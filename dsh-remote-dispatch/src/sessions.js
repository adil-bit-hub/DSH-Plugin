/**
 * Session portability for `dsh-remote-dispatch`.
 *
 * A DSH session log is an append-only file of concatenated zstd frames
 * (`session.v4.jsonl.zstd`). Node's zstd stream stops after the first frame, so
 * reading a real conversation requires splitting on the frame magic and
 * decoding each frame on its own.
 *
 * This module lets the plugin take the conversation you are having locally and
 * hand it to the cloud: decode → rewrite the header `cwd` to the remote working
 * directory → re-encode as one frame. The cloud then adopts it with
 * `dsh --session-id <id>` and continues with the full history.
 *
 * @module dsh-remote-dispatch/sessions
 */
import { existsSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { RemoteError } from './ssh.js'

/** zstd frame magic: 0x28 B5 2F FD, little-endian on disk. */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Split a concatenated-zstd buffer into frame slices. */
function splitFrames(buf) {
  const offsets = []
  let at = buf.indexOf(MAGIC, 0)
  while (at >= 0) {
    offsets.push(at)
    at = buf.indexOf(MAGIC, at + 4)
  }
  if (offsets.length === 0) {
    throw new RemoteError('session-invalid', '不是有效的 zstd 会话文件。')
  }
  return offsets.map((start, index) => {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buf.length
    return buf.subarray(start, end)
  })
}

/** Decode every frame of a session log into one JSONL string. */
export function decodeSessionLog(buf) {
  const chunks = []
  for (const frame of splitFrames(buf)) {
    try {
      chunks.push(zstdDecompressSync(frame))
    } catch {
      // A truncated tail (the writer mid-append) is expected; stop there.
      break
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse decoded JSONL into events, skipping unreadable lines. */
export function parseEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // ignore a partially written trailing line
    }
  }
  return events
}

/**
 * Re-encode events the way DSH stores them.
 *
 * The store validates the log strictly: the **first zstd frame must contain
 * exactly the one header line**, and the rest of the conversation follows in
 * later frames. Compressing everything into a single frame is rejected as
 * "first frame is not exactly one header line".
 */
export function encodeSessionLog(events) {
  if (events.length === 0) {
    throw new RemoteError('session-invalid', '会话里没有任何事件。')
  }
  const header = events[0]
  if (!isSessionHeader(header)) {
    throw new RemoteError('session-invalid', '第一个事件不是 session 头，无法编码。')
  }
  const headerFrame = zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'))
  if (events.length === 1) return headerFrame

  const restText = events.slice(1).map((event) => JSON.stringify(event)).join('\n') + '\n'
  const bodyFrame = zstdCompressSync(Buffer.from(restText, 'utf8'))
  return Buffer.concat([headerFrame, bodyFrame])
}

/** True when the first event looks like a session header. */
export function isSessionHeader(event) {
  return Boolean(event && event.type === 'session' && typeof event.id === 'string')
}

/**
 * Read a local session log and rewrite its working directory for the cloud.
 *
 * @param {string} file - absolute path to `session.v4.jsonl.zstd`.
 * @param {string} remoteCwd - the directory the cloud will run in.
 * @returns {Promise<{id:string, events:number, bytes:Buffer, source:object}>}
 */
export async function prepareSessionForCloud(file, remoteCwd) {
  let raw
  try {
    raw = await readFile(file)
  } catch (error) {
    throw new RemoteError('session-missing', `读不到会话文件 ${file}：${error.message}`)
  }

  const events = parseEvents(decodeSessionLog(raw))
  const header = events.find(isSessionHeader)
  if (!header) {
    throw new RemoteError('session-invalid', '会话文件缺少 session 头事件，无法迁移。')
  }

  // The header carries the origin cwd; the cloud must believe it ran there,
  // otherwise the session is filtered out of that working directory's store.
  const source = { cwd: header.cwd, agentPreset: header.agentPreset, createdAt: header.createdAt }
  header.cwd = remoteCwd

  // A session started from the desktop app records its agent preset, but the
  // one-shot (`headless`) runner refuses a preset it does not compose — it only
  // composes its own. Dropping the field makes the log look exactly like one
  // headless created (its headers carry no agentPreset).
  delete header.agentPreset

  // The preset is also recorded as `agent-preset/selected` events, and events
  // reference each other by seq (`sourceEventSeqs`), so the log cannot be
  // filtered without corrupting those references. Instead blank the preset
  // value in place: a one-shot runner then falls back to its own default,
  // exactly like a session it created itself.
  for (const event of events) {
    if (event.type === 'agent-preset/selected' && event.data) {
      delete event.data.agentPreset
    }
  }

  // Keep the header first: the store requires it as the sole content of frame 1.
  const ordered = [header, ...events.filter((event) => event !== header)]

  // Any event that echoes the cwd is rewritten too, so replays agree with the
  // new location. Field edits keep seq and cross-references intact.
  for (const event of ordered) {
    if (event !== header && typeof event.cwd === 'string') event.cwd = remoteCwd
  }

  const bytes = encodeSessionLog(ordered)
  return { id: header.id, events: ordered.length, bytes, source }
}

/**
 * Where a session's log lives for a given working directory.
 * DSH buckets session logs by cwd: `/…/sessions/--<slug>--/<session-id>/`.
 */
export function sessionBucketName(cwd) {
  const slug = String(cwd)
    .replace(/[:\\/]/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return `--${slug}--`
}

/**
 * Locate a local session directory by id across every bucket.
 * @param {string} sessionsRoot - e.g. `<DSH_HOME>/sessions`.
 * @param {string} sessionId
 */
export async function findLocalSession(sessionsRoot, sessionId) {
  const { readdir } = await import('node:fs/promises')
  const buckets = await readdir(sessionsRoot, { withFileTypes: true })
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const dir = join(sessionsRoot, bucket.name, sessionId)
    const file = join(dir, 'session.v4.jsonl.zstd')
    try {
      const raw = await readFile(file)
      const events = parseEvents(decodeSessionLog(raw))
      const header = events.find(isSessionHeader)
      if (header) {
        return { file, dir, bucket: bucket.name, events: events.length, header, raw }
      }
    } catch {
      // not in this bucket
    }
  }
  return undefined
}

/**
 * Newest session per bucket — used when the UI cannot tell us which session the
 * user is looking at (composer slots receive no session id).
 * @param {string} sessionsRoot
 */
export async function newestSession(sessionsRoot) {
  const { readdir, stat } = await import('node:fs/promises')
  let best
  for (const bucket of await readdir(sessionsRoot, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    const bucketDir = join(sessionsRoot, bucket.name)
    let entries
    try {
      entries = await readdir(bucketDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue
      const file = join(bucketDir, entry.name, 'session.v4.jsonl.zstd')
      try {
        const info = await stat(file)
        if (!best || info.mtimeMs > best.mtimeMs) {
          best = { id: entry.name, file, dir: join(bucketDir, entry.name), bucket: bucket.name, mtimeMs: info.mtimeMs }
        }
      } catch {
        // ignore
      }
    }
  }
  return best
}

/** Write an encoded session log where a cloud DSH will find it. */
export async function writeLocalSession(file, bytes) {
  await writeFile(file, bytes)
  return file
}

/** Join only the visible `text` parts of a content array (drops reasoning). */
function visibleText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/**
 * Decode only the first frame — the session header carries id/cwd cheaply.
 * Listing candidates must not decompress every conversation on disk.
 *
 * @param {string} file
 */
export async function readSessionHeader(file) {
  const raw = await readFile(file)
  const frames = splitFrames(raw)
  if (frames.length === 0) return undefined
  try {
    const text = zstdDecompressSync(frames[0]).toString('utf8')
    const firstLine = text.split('\n').find((line) => line.trim() !== '')
    if (!firstLine) return undefined
    const header = JSON.parse(firstLine)
    return isSessionHeader(header) ? header : undefined
  } catch {
    return undefined
  }
}

/**
 * Recent sessions on this machine, newest first.
 *
 * The plugin cannot know which conversation the user is looking at (composer
 * slots receive no session id), and "newest" is wrong because the agent's own
 * session writes constantly. So the panel lists candidates and the user picks —
 * this function supplies that list.
 *
 * @param {string} sessionsRoot
 * @param {object} [options] - { limit }
 * @returns {Promise<Array<{sessionId:string, cwd:string, project:string, updatedAt:string}>>}
 */
export async function listRecentSessions(sessionsRoot, options = {}) {
  const { readdir, stat } = await import('node:fs/promises')
  const limit = Math.max(1, Math.min(40, options.limit ?? 12))

  const candidates = []
  for (const bucket of await readdir(sessionsRoot, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    const bucketDir = join(sessionsRoot, bucket.name)
    let entries
    try {
      entries = await readdir(bucketDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue
      const file = join(bucketDir, entry.name, 'session.v4.jsonl.zstd')
      try {
        const info = await stat(file)
        candidates.push({ sessionId: entry.name, file, mtimeMs: info.mtimeMs, size: info.size })
      } catch {
        // ignore unreadable entries
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const out = []
  for (const candidate of candidates.slice(0, limit)) {
    const header = await readSessionHeader(candidate.file).catch(() => undefined)
    const cwd = header?.cwd ?? ''

    // Turns and touched files make the picker self-describing: a wrong pick
    // ("1 轮 · 0 文件") is then obvious before pushing.
    let turns = 0
    let fileCount = 0
    try {
      const events = parseEvents(decodeSessionLog(await readFile(candidate.file)))
      turns = events.filter(
        (event) => event.type === 'user/message' &&
          (!event.data?.source?.kind || event.data.source.kind === 'user'),
      ).length
      fileCount = cwd === '' ? 0 : collectTouchedFiles(events, cwd).length
    } catch {
      // keep zeros for an unreadable log
    }

    out.push({
      sessionId: candidate.sessionId,
      cwd,
      project: cwd ? (String(cwd).split(/[\\/]/).filter(Boolean).pop() ?? '') : '',
      updatedAt: new Date(candidate.mtimeMs).toISOString(),
      sizeBytes: candidate.size,
      turns,
      fileCount,
    })
  }
  return out
}

/** Collect every string value inside a parsed tool argument object. */
function collectStrings(value, out) {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out)
  }
}

/** Split a shell command or free text into candidate path tokens. */
function pathTokens(text) {
  if (typeof text !== 'string' || text === '') return []
  const tokens = text.split(/[\s"'`;,()\[\]{}<>|]+/)
  return tokens.filter((token) => token.includes('.') || token.includes('/') || token.includes('\\'))
}

/**
 * Files this conversation actually touched.
 *
 * Every tool call's arguments are scanned for path-looking strings (and for
 * path tokens inside shell commands), then a candidate is kept only when it
 * resolves to a real file inside the session's working directory. That is how
 * the handoff ships "the files this session touched" instead of the whole tree.
 *
 * @param {unknown[]} events - parsed session events.
 * @param {string} cwd - the session working directory.
 * @param {object} [options] - { maxFiles }
 * @returns {string[]} relative paths (POSIX separators), de-duplicated, stable order.
 */
export function collectTouchedFiles(events, cwd, options = {}) {
  const maxFiles = Math.max(1, options.maxFiles ?? 500)

  const root = String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (root === '') return []

  const seen = new Set()
  const relative = []

  const consider = (candidate) => {
    if (relative.length >= maxFiles) return
    let raw = String(candidate).replace(/^["'`]+|["'`]+$/g, '').replace(/\\/g, '/')
    if (raw === '' || raw.length > 400) return

    // Resolve relative candidates against the session directory.
    if (!/^[A-Za-z]:\//.test(raw) && !raw.startsWith('/')) {
      if (!raw.includes('/')) return
      raw = `${root}/${raw}`
    }

    // Normalize `..` segments without a path library dependency on Windows forms.
    const parts = []
    for (const segment of raw.split('/')) {
      if (segment === '' || segment === '.') continue
      if (segment === '..') parts.pop()
      else parts.push(segment)
    }
    const normalized = (/^[A-Za-z]:/.test(raw) ? '' : '/') + parts.join('/')

    const rootKey = root.toLowerCase()
    const normKey = normalized.toLowerCase()
    if (!normKey.startsWith(rootKey + '/')) return

    const rel = normalized.slice(root.length + 1)
    if (rel === '' || seen.has(rel.toLowerCase())) return
    seen.add(rel.toLowerCase())
    relative.push(rel)
  }

  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const args = event.data && event.data.arguments
    if (typeof args !== 'string' || args === '') continue

    let parsed
    try {
      parsed = JSON.parse(args)
    } catch {
      parsed = undefined
    }
    if (parsed && typeof parsed === 'object') {
      const strings = []
      collectStrings(parsed, strings)
      for (const value of strings) {
        consider(value)
        for (const token of pathTokens(value)) consider(token)
      }
    } else {
      for (const token of pathTokens(args)) consider(token)
    }
  }

  // Keep only entries that exist as files right now.
  return relative.filter((rel) => {
    try {
      return existsSync(join(root, rel)) && statSync(join(root, rel)).isFile()
    } catch {
      return false
    }
  })
}

/**
 * Build a readable transcript of a session.
 *
 * Migrating the raw log is not possible: the store validates `seq` continuity,
 * cross-event `sourceEventSeqs` references, and an agent-preset selection that a
 * one-shot runner does not compose. So continuity is delivered as text instead:
 * the whole conversation is handed to the cloud as part of the task, which is
 * what actually carries context to the model.
 *
 * Tool calls and results are collapsed to short markers — the synced project
 * files let the cloud re-read whatever it needs.
 *
 * @param {string} file - session log path.
 * @param {object} [options]
 * @param {number} [options.maxChars] - hard cap on the transcript length.
 * @param {boolean} [options.includeTools] - keep one-line tool markers.
 * @returns {Promise<{text:string, turns:number, truncated:boolean, cwd:string, sessionId:string}>}
 */
export async function buildTranscript(file, options = {}) {
  const maxChars = Math.max(1000, options.maxChars ?? 240_000)

  const raw = await readFile(file)
  const events = parseEvents(decodeSessionLog(raw))
  const header = events.find(isSessionHeader)
  if (!header) throw new RemoteError('session-invalid', '会话文件缺少 session 头事件。')

  const lines = []
  let turns = 0

  for (const event of events) {
    const data = event.data ?? {}

    if (event.type === 'user/message') {
      // Skip injected context (system/tool/user-questions rows); keep real asks.
      const kind = data.source && data.source.kind
      if (kind && kind !== 'user') continue
      const text = visibleText(data.content).trim()
      if (text === '') continue
      turns += 1
      lines.push(`\n## 用户（第 ${turns} 轮）\n${text}\n`)
      continue
    }

    if (event.type === 'assistant/message') {
      const text = visibleText(data.message && data.message.content).trim()
      if (text === '') continue
      lines.push(`\n### 助手\n${text}\n`)
    }
    // 工具调用一律不写进交接记录：它只增加噪声，云端需要细节时会读代码文件。
  }

  let text = lines.join('\n').trim()
  let truncated = false
  if (text.length > maxChars) {
    // Keep the most recent half: earlier rounds matter less than the tail.
    text = `（较早的对话已省略）\n\n${text.slice(text.length - maxChars)}`
    truncated = true
  }

  return { text, turns, truncated, cwd: header.cwd, sessionId: header.id }
}