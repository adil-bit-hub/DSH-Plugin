/**
 * The dispatch service: everything a remote job needs, independent of the
 * agent-tool surface so it can be unit tested and reused.
 *
 * Concepts
 * --------
 * A *host* is a cloud machine whose ssh credential lives in the DSH credential
 * store. A *job* is one task pushed to one host; the cloud runs `dsh headless`
 * detached from the SSH session, so a local network drop cannot interrupt it.
 *
 * @module dsh-remote-dispatch/service
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { RemoteError, SshTarget, shellQuote } from './ssh.js'
import {
  ValidationError,
  assertJobId,
  assertProject,
  assertWithin,
  projectFromLocalDir,
} from './validate.js'

/** Directories never uploaded when syncing a project. */
const EXCLUDE = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build',
  '.dsh', 'dsh-jobs', '.cache', '.DS_Store', 'target', '.pytest_cache', '.idea', '.vscode',
])

/** Strip the quoting YAML uses for scalars the vault writes. */
function unquote(value) {
  const v = value.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n')
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'")
  }
  return v
}

export class RemoteDispatchService {
  /**
   * @param {object} ctx - plugin context (needs `credentials`).
   * @param {object} settings - resolved plugin config.
   * @param {import('./devices.js').DeviceRegistry} [registry] - device bindings.
   */
  constructor(ctx, settings, registry) {
    this.ctx = ctx
    this.settings = settings
    this.registry = registry
    this.cache = new Map()
  }

  /** Configured host names. */
  hostNames() {
    return Object.keys(this.settings.hosts ?? {})
  }

  /** Every bound device name (registry first, config as fallback). */
  async deviceNames() {
    if (!this.registry) return this.hostNames()
    const { devices } = await this.registry.list()
    return devices.map((device) => device.name)
  }

  /**
   * List every ssh credential in the store, so the Settings page can offer
   * them for binding. Returns metadata only — never a password or key.
   */
  async listSshCredentials() {
    const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
    const candidates = [join(home, '.credentials.yaml'), join(home, '.credentials.yml')]

    let text
    for (const path of candidates) {
      try {
        text = await readFile(path, 'utf8')
        break
      } catch {
        // next candidate
      }
    }
    if (!text) return []

    // Every record block looks like `dsh-credential-vault/<id>:` at indent 2.
    // Pull id/host/port/username/authMethod/type for the ssh ones only.
    const lines = text.split(/\r?\n/)
    const out = []
    for (let i = 0; i < lines.length; i += 1) {
      const header = lines[i].match(/^(\s*)dsh-credential-vault\/([A-Za-z0-9_-]+):\s*$/)
      if (!header) continue
      const blockIndent = header[1].length
      const id = header[2]
      const fields = {}
      let inPayload = false
      let payloadIndent = 0
      for (let j = i + 1; j < lines.length; j += 1) {
        const raw = lines[j]
        if (raw.trim() === '') continue
        const indent = (raw.match(/^\s*/) ?? [''])[0].length
        if (indent <= blockIndent) break
        const m = raw.match(/^\s*([A-Za-z0-9_.-]+):\s?(.*)$/)
        if (!m) continue
        const [, key, value] = m
        if (key === 'payload' && (value ?? '').trim() === '') {
          inPayload = true
          payloadIndent = indent
          continue
        }
        if (!inPayload || indent <= payloadIndent) continue
        if (['id', 'type', 'name', 'host', 'port', 'username', 'authMethod', 'note'].includes(key)) {
          fields[key] = (value ?? '').trim().replace(/^"(.*)"$/, '$1')
        }
      }
      // Only real ssh servers: must carry a host and look like an ssh record.
      if (fields.type !== 'ssh') continue
      if (!fields.host) continue
      out.push({
        id,
        name: fields.name ?? id,
        host: fields.host ?? '',
        port: Number(fields.port) || 22,
        username: fields.username ?? '',
        authMethod: fields.authMethod ?? 'password',
        note: fields.note ?? '',
      })
    }
    return out
  }

  /** The name of the device used when a call names none. */
  async defaultDeviceName() {
    if (!this.registry) return this.settings.defaultHost
    const { defaultDevice } = await this.registry.list()
    return defaultDevice
  }

  /** Resolve a device/host name to its binding. */
  async resolveHost(name) {
    if (this.registry) {
      const entry = await this.registry.resolve(name)
      return { name: entry.name, entry }
    }
    const wanted = name && name.trim() !== '' ? name.trim() : this.settings.defaultHost
    const entry = this.settings.hosts?.[wanted]
    if (!entry) {
      throw new RemoteError(
        'unknown-host',
        `未配置的主机「${wanted}」。可用主机名：${this.hostNames().join(', ') || '(无)'}。` +
          '（host 参数要用配置键，不是机器 hostname）请在 设置 → remote-dispatch → hosts 里配置。',
      )
    }
    return { name: wanted, entry }
  }

  /** Read the ssh credential record behind a host and build an SSH target. */
  async target(hostName) {
    const { name, entry } = await this.resolveHost(hostName)
    const cached = this.cache.get(name)
    if (cached && cached.stamp === JSON.stringify(entry)) return cached.target

    if (!entry.credentialId) {
      throw new RemoteError('no-credential', `主机「${name}」没有配置 credentialId。`)
    }
    const record = await this.readCredential(entry.credentialId)
    const target = new SshTarget(record, this.settings)
    this.cache.set(name, { stamp: JSON.stringify(entry), target })
    return target
  }

  /** Pull an ssh record out of the DSH credential store by id. */
  async readCredential(credentialId) {
    // The composition may or may not mount a credentials service; never touch
    // the property un-guarded (cordis throws for un-injected services).
    let credentials
    try {
      credentials = this.ctx.credentials
    } catch {
      credentials = undefined
    }
    // Preferred path: the live credentials service, when the composition has
    // one (the web profile does).
    if (credentials && typeof credentials.readRecord === 'function') {
      const scopes = ['dsh-credential-vault', 'credential-vault']
      let record
      let lastError
      for (const scope of scopes) {
        try {
          record = await credentials.readRecord(`${scope}/${credentialId}`)
        } catch (error) {
          lastError = error
          continue
        }
        if (record) return this.normalizeRecord(credentialId, record)
      }
      if (lastError) {
        this.ctx.logger?.warn?.(`remote-dispatch: readRecord 失败，改用文件兜底：${lastError.message}`)
      }
    }

    // Fallback: read the credential file directly. Headless/tui compositions
    // often mount no credentials service, but the file is still there.
    return this.readCredentialFile(credentialId)
  }

  /** Read `<DSH_HOME>/.credentials.yaml` without a YAML dependency. */
  async readCredentialFile(credentialId) {
    const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
    const candidates = [join(home, '.credentials.yaml'), join(home, '.credentials.yml')]

    let text
    let used
    for (const path of candidates) {
      try {
        text = await readFile(path, 'utf8')
        used = path
        break
      } catch {
        // try the next candidate
      }
    }
    if (!text) {
      throw new RemoteError('credential-file-missing', `读取凭据失败：凭据服务不可用，且找不到 ${candidates[0]}`)
    }

    // The vault writes one block per record keyed by
    // `dsh-credential-vault/<id>`:
    //
    //   dsh-credential-vault/ssh-xxxx:
    //     kind: grant
    //     payload:
    //       id: ssh-xxxx
    //       host: 1.2.3.4
    //       port: 22
    //       username: root
    //       password: "..."
    //       authMethod: password
    //
    // We only need the `payload:` scalars, so parse that deliberately small
    // shape rather than pulling in a YAML dependency.
    const lines = text.split(/\r?\n/)
    let start = -1
    let blockIndent = 0
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.trim() === `dsh-credential-vault/${credentialId}:` ||
          line.trim() === `credential-vault/${credentialId}:`) {
        start = i
        blockIndent = (line.match(/^\s*/) ?? [''])[0].length
        break
      }
    }
    if (start < 0) {
      throw new RemoteError('credential-missing', `凭据库里找不到 ${credentialId}（${used}）`)
    }

    const rec = {}
    let inPayload = false
    let payloadIndent = 0
    let currentKey
    let blockKey
    let blockIndentForValue
    let foldedKey

    for (let i = start + 1; i < lines.length; i += 1) {
      const raw = lines[i]
      const indent = (raw.match(/^\s*/) ?? [''])[0].length

      // Continuation of a multi-line scalar: keep going while indented deeper.
      if (blockKey !== undefined && (raw.trim() === '' || indent > blockIndentForValue - 1)) {
        if (raw.trim() !== '' && indent >= blockIndentForValue - 1) {
          rec[blockKey] = rec[blockKey] === '' ? raw.slice(blockIndentForValue) : `${rec[blockKey]}\n${raw.slice(blockIndentForValue)}`
          continue
        }
      }
      if (raw.trim() === '') {
        if (foldedKey && inPayload) rec[foldedKey] = `${rec[foldedKey] ?? ''}\n`
        continue
      }
      if (blockKey !== undefined && indent < blockIndentForValue) blockKey = undefined
      if (indent <= blockIndent) break

      const m = raw.match(/^\s*([A-Za-z0-9_.-]+):\s?(.*)$/)
      if (!m) continue
      const [, key, rest] = m
      const value = rest ?? ''

      if (key === 'payload' && value.trim() === '') {
        inPayload = true
        payloadIndent = indent
        continue
      }
      if (!inPayload) continue
      if (indent <= payloadIndent) break

      blockKey = undefined
      foldedKey = undefined

      const trimmed = value.trim()
      if (trimmed === '|' || trimmed === '|-' || trimmed === '>+' || trimmed === '>') {
        // Literal block scalar: the following lines are the value, verbatim,
        // one per line (this is how private keys are stored).
        blockKey = key
        blockIndentForValue = undefined
        rec[key] = ''
        currentKey = key
        // Determine the block indent from the first following content line.
        for (let j = i + 1; j < lines.length; j += 1) {
          if (lines[j].trim() === '') continue
          blockIndentForValue = (lines[j].match(/^\s*/) ?? [''])[0].length
          break
        }
        if (blockIndentForValue === undefined) {
          blockKey = undefined
          continue
        }
        continue
      }
      currentKey = key
      rec[key] = unquote(trimmed)
      if (rec[key] === '') rec[key] = undefined
    }

    if (rec.id && rec.id !== credentialId) {
      throw new RemoteError('credential-invalid', `凭据 id 不匹配：期望 ${credentialId}，得到 ${rec.id}`)
    }
    return this.normalizeRecord(credentialId, { payload: rec })
  }

  /** Turn a stored record into the flat shape the SSH layer expects. */
  normalizeRecord(credentialId, record) {
    const rec = record && record.payload && typeof record.payload === 'object' ? record.payload : record
    if (!rec || !rec.host) {
      throw new RemoteError('credential-invalid', `凭据 ${credentialId} 缺少 host 字段。`)
    }
    return {
      id: credentialId,
      host: rec.host,
      port: Number(rec.port) || 22,
      username: rec.username ?? 'root',
      authMethod: rec.privateKey ? 'key' : (rec.authMethod ?? 'password'),
      password: rec.password,
      privateKey: rec.privateKey,
    }
  }

  /** Cloud-side home directory, discovered once per host. */
  async home(hostName) {
    const t = await this.target(hostName)
    const r = await t.exec('printf %s "$HOME"')
    const home = r.stdout.trim()
    if (!home) throw new RemoteError('no-home', `无法确定 ${hostName} 的主目录：${r.stderr.trim()}`)
    return home
  }

  /** Verify the host is reachable and has the remote runner installed. */
  async probe(hostName) {
    const t = await this.target(hostName)
    const r = await t.exec(
      'echo "host=$(hostname)"; echo "node=$(command -v node || echo missing)"; ' +
      'echo "dsh=$(command -v dsh || echo missing)"; echo "runner=$(command -v dsh-job || echo missing)"; ' +
      'echo "home=$HOME"',
    )
    const info = {}
    for (const line of r.stdout.split(/\r?\n/)) {
      const at = line.indexOf('=')
      if (at > 0) info[line.slice(0, at)] = line.slice(at + 1)
    }
    return {
      host: hostName,        // config key — this is what tools accept
      hostname: info.host,   // the machine's own hostname
      ssh: t.label,
      reachable: r.code === 0,
      node: info.node,
      dsh: info.dsh,
      runner: info.runner,
      home: info.home,
      ready: Boolean(info.node && info.node !== 'missing' && info.dsh && info.dsh !== 'missing'),
      runnerInstalled: Boolean(info.runner && info.runner !== 'missing'),
      warnings: r.stderr.trim() ? [r.stderr.trim()] : [],
    }
  }

  /** Build a job id like `proj-1110-180233`. */
  makeJobId(project) {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const stamp = `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    return `${project || 'job'}-${stamp}`
  }

  /**
   * Resolve a project name to a safe directory component.
   *
   * Previously this stripped illegal characters, which silently mapped every
   * non-ASCII name onto `default` (two different users, one directory) and
   * let `.` / `..` through untouched — `[^A-Za-z0-9._-]` *permits* dots, so
   * `project: ".."` produced `~/dsh-work/..`, i.e. `$HOME` itself.
   * Now: reject, never rewrite. Names without an explicit project fall back
   * to a hash-suffixed slug of the local directory, so distinct Chinese
   * folder names stay distinct.
   * @param {string} [name] - explicit project name, if any.
   * @param {string} [localDir] - used to derive a name when `name` is absent.
   * @returns {string} safe project name.
   */
  safeProject(name, localDir) {
    const explicit = typeof name === 'string' ? name.trim() : ''
    if (explicit !== '') {
      try {
        return assertProject(explicit)
      } catch (error) {
        if (error instanceof ValidationError) {
          throw new RemoteError(error.code, error.message)
        }
        throw error
      }
    }
    if (localDir) {
      try {
        return projectFromLocalDir(resolve(localDir))
      } catch (error) {
        if (error instanceof ValidationError) {
          throw new RemoteError(error.code, error.message)
        }
        throw error
      }
    }
    return 'default'
  }

  /**
   * Validate a job id supplied by the caller.
   * @param {unknown} value - candidate job id.
   * @returns {string} validated id.
   */
  validateJobId(value) {
    try {
      return assertJobId(value)
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new RemoteError(error.code, error.message)
      }
      throw error
    }
  }

  /**
   * Pack a local directory into a .tar.gz using the system tar (no deps).
   * @returns {Promise<{path:string, bytes:number, dir:string}>}
   */
  async packDirectory(localDir) {
    const dir = resolve(localDir)
    let info
    try {
      info = await stat(dir)
    } catch {
      throw new RemoteError('dir-missing', `本地目录不存在：${dir}`)
    }
    if (!info.isDirectory()) throw new RemoteError('not-a-directory', `不是目录：${dir}`)

    const tmp = await mkdtemp(join(tmpdir(), 'dsh-remote-pack-'))
    const archive = join(tmp, 'payload.tar.gz')

    const excludes = [...EXCLUDE].flatMap((name) => ['--exclude', name])
    // Windows 10+ ships bsdtar as C:\Windows\System32\tar.exe.
    const args = ['-czf', archive, ...excludes, '-C', dir, '.']
    const { runProcess } = await import('./ssh.js')
    const result = await runProcess('tar', args, {}, 300_000)
    if (result.code !== 0) {
      await rm(tmp, { recursive: true, force: true })
      throw new RemoteError('pack-failed', `打包失败：${result.stderr.trim() || `tar 退出码 ${result.code}`}`)
    }
    const packed = await stat(archive)
    return { path: archive, bytes: packed.size, dir, cleanup: () => rm(tmp, { recursive: true, force: true }) }
  }

  /**
   * Dispatch a task.
   * @param {object} input
   * @param {string} input.task - the task text.
   * @param {string} [input.host] - host name.
   * @param {string} [input.project] - project / remote working dir name.
   * @param {string} [input.localDir] - optional local directory to upload first.
   * @param {string} [input.continueSession] - previous job id whose session to resume.
   * @param {string} [input.jobId] - explicit job id.
   * @param {Function} [input.onProgress] - called with {phase, percent, detail, bytes, total}.
   */
  async dispatch(input) {
    const task = String(input.task ?? '').trim()
    if (!task) throw new RemoteError('empty-task', '任务内容为空。')

    const hostName = (await this.resolveHost(input.host)).name
    const t = await this.target(hostName)
    const home = await this.home(hostName)

    const project = this.safeProject(input.project, input.localDir)
    const jobId = input.jobId ? this.validateJobId(input.jobId) : this.makeJobId(project)
    const remoteRoot = `${home}/dsh-work/${project}`
    assertWithin(`${home}/dsh-work`, remoteRoot)
    const notes = []
    const report = (patch) => {
      try {
        input.onProgress?.(patch)
      } catch {
        // a broken progress sink must never fail the dispatch
      }
    }

    report({ phase: 'connecting', percent: 0, detail: `连接 ${hostName}` })

    // 1) optional directory upload
    if (input.localDir) {
      report({ phase: 'packing', percent: 2, detail: '打包本地目录' })
      const packed = await this.packDirectory(input.localDir)
      try {
        const mb = packed.bytes / 1024 / 1024
        if (mb > this.settings.maxUploadMb) {
          throw new RemoteError('upload-too-large', `目录打包后 ${mb.toFixed(1)}MB，超过上限 ${this.settings.maxUploadMb}MB。`)
        }
        report({ phase: 'uploading', percent: 4, detail: `打包完成 ${mb.toFixed(2)}MB，开始上传`, bytes: packed.bytes })
        const remoteTar = `/tmp/_dshpush-${jobId}.tar.gz`
        await this.uploadWithProgress(t, packed.path, packed.bytes, remoteTar, report)
        report({ phase: 'unpacking', percent: 93, detail: '云端解包中' })
        const up = await t.exec(
          `mkdir -p ${shellQuote(remoteRoot)} && ` +
            `tar -xzf ${shellQuote(remoteTar)} -C ${shellQuote(remoteRoot)} --no-same-owner && ` +
            `rm -f ${shellQuote(remoteTar)} && echo UPLOAD_OK`,
          Math.max(this.settings.commandTimeoutMs, 600_000),
        )
        if (!up.stdout.includes('UPLOAD_OK')) {
          throw new RemoteError('upload-failed', `解包失败：${(up.stderr || up.stdout).trim().slice(0, 500)}`)
        }
        notes.push(`已上传本地目录 ${packed.dir}（${mb.toFixed(2)}MB）到 ${remoteRoot}`)
      } finally {
        await packed.cleanup().catch(() => {})
      }
    }

    report({ phase: 'submitting', percent: 96, detail: '提交任务' })

    // 2) resolve session to continue
    let session = ''
    if (input.continueSession) {
      const continueId = this.validateJobId(input.continueSession)
      const meta = await t.exec(`cat ${shellQuote(`${home}/dsh-jobs/${continueId}/meta.json`)} 2>/dev/null`)
      const m = (meta.stdout || '').match(/"session"\s*:\s*"([^"]+)"/)
      if (m && m[1]) {
        session = m[1]
        notes.push(`续跑 session ${session}`)
      } else {
        notes.push(`未找到 ${input.continueSession} 的 session，按新任务执行`)
      }
    }

    // 3) upload task text and submit
    const remoteTask = `/tmp/_dshtask-${jobId}.md`
    const up = await t.execWithStdin(`cat > ${shellQuote(remoteTask)} && echo TASK_OK`, Buffer.from(task, 'utf8'))
    if (!up.stdout.includes('TASK_OK')) {
      throw new RemoteError('task-upload-failed', `任务文本上传失败：${(up.stderr || up.stdout).trim()}`)
    }

    const submitCmd =
      `dsh-job submit ${shellQuote(jobId)} ${shellQuote(remoteRoot)} ${shellQuote(remoteTask)}` +
      (session ? ` --session ${shellQuote(session)}` : '') +
      ` && rm -f ${shellQuote(remoteTask)}`
    const res = await t.exec(submitCmd)
    if (res.code !== 0) {
      throw new RemoteError('submit-failed', `提交失败：${(res.stderr || res.stdout).trim().slice(0, 800)}`)
    }

    return {
      jobId,
      host: hostName,
      ssh: t.label,
      project,
      remoteRoot,
      session: session || undefined,
      notes,
      message: `${jobId} 已在 ${hostName} 上开始执行；本地断网或关机都不会影响它，稍后用 remote_status / remote_result 取结果。`,
    }
  }

  /**
   * Pack **only the given files** and unpack them into the cloud working
   * directory, preserving their relative paths.
   *
   * Shipping the whole project directory drags along unrelated trees
   * (node_modules, git history, binaries); the handoff only needs the files this
   * conversation actually touched.
   *
   * @param {object} input - { hostName, remoteRoot, cwd, files, tag, report }
   */
  async uploadFiles(input) {
    const { hostName, remoteRoot, cwd, files, tag, report } = input
    if (!Array.isArray(files) || files.length === 0) {
      return { files: 0, bytes: 0, skipped: true }
    }
    const t = await this.target(hostName)

    report({ phase: 'packing', percent: 2, detail: `打包 ${files.length} 个文件` })

    const tmp = await mkdtemp(join(tmpdir(), 'dsh-remote-files-'))
    const archive = join(tmp, 'files.tar.gz')
    const listFile = join(tmp, 'files.txt')
    // Forward slashes + LF: what the tar on either side expects.
    await writeFile(listFile, files.map((file) => file.replace(/\\/g, '/')).join('\n') + '\n', 'utf8')

    const { runProcess } = await import('./ssh.js')
    try {
      const packed = await runProcess(
        'tar',
        ['-czf', archive, '-C', cwd, '-T', listFile],
        {},
        300_000,
      )
      if (packed.code !== 0) {
        throw new RemoteError('pack-failed', `打包失败：${(packed.stderr || '').trim().slice(0, 300)}`)
      }
      const bytes = (await stat(archive)).size
      const mb = bytes / 1024 / 1024
      if (mb > this.settings.maxUploadMb) {
        throw new RemoteError('upload-too-large', `文件合计 ${mb.toFixed(1)}MB，超过上限 ${this.settings.maxUploadMb}MB。`)
      }

      report({ phase: 'uploading', percent: 6, detail: `上传 ${files.length} 个文件（${mb.toFixed(2)}MB）`, bytes, total: bytes })
      const remoteTar = `/tmp/_dshfiles-${tag}-${Date.now()}.tar.gz`
      await this.uploadWithProgress(t, archive, bytes, remoteTar, report)

      report({ phase: 'unpacking', percent: 93, detail: '云端解包中' })
      const up = await t.exec(
        `mkdir -p ${shellQuote(remoteRoot)} && ` +
          `tar -xzf ${shellQuote(remoteTar)} -C ${shellQuote(remoteRoot)} --no-same-owner && ` +
          `rm -f ${shellQuote(remoteTar)} && echo UPLOAD_OK`,
        Math.max(this.settings.commandTimeoutMs, 600_000),
      )
      if (!up.stdout.includes('UPLOAD_OK')) {
        throw new RemoteError('upload-failed', `解包失败：${(up.stderr || up.stdout).trim().slice(0, 500)}`)
      }
      return { files: files.length, bytes, mb }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * 云端项目根目录（所有项目都在这里）。
   * @param {string} hostName
   */
  async workRoot(hostName) {
    const home = await this.home(hostName)
    return `${home}/dsh-work`
  }

  /**
   * 列出云端项目：每个 `~/dsh-work/<name>` 目录就是一个项目。
   *
   * 一次 SSH 往返拿全量（文件数 / 体积 / 更新时间），避免 N 个项目 N 次连接。
   *
   * @param {string} [host]
   * @returns {Promise<{host:string, root:string, projects:Array}>}
   */
  async projects(host) {
    const hostName = (await this.resolveHost(host)).name
    const t = await this.target(hostName)
    const root = await this.workRoot(hostName)

    // 逐行拼命令：用 '; ' 连接会把 `do` 后面拼出 `do;`，shell 会报语法错误
    const cmd = [
      `mkdir -p ${shellQuote(root)}`,
      `cd ${shellQuote(root)} || exit 1`,
      'for d in */; do',
      '  [ -d "$d" ] || continue',
      '  n=${d%/}',
      '  c=$(find "$n" -type f 2>/dev/null | wc -l)',
      '  b=$(du -sb "$n" 2>/dev/null | cut -f1)',
      '  m=$(stat -c %Y "$n" 2>/dev/null)',
      '  echo "$n|$c|$b|$m"',
      'done',
    ].join('\n')

    const r = await t.exec(cmd)
    const projects = []
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const [name, files, bytes, mtime] = trimmed.split('|')
      if (!name) continue
      projects.push({
        name,
        path: `${root}/${name}`,
        files: Number(files) || 0,
        bytes: Number(bytes) || 0,
        updatedAt: mtime ? new Date(Number(mtime) * 1000).toISOString() : '',
      })
    }
    projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return { host: hostName, root, count: projects.length, projects }
  }

  /** 新建云端项目（就是一个空的工作目录）。 */
  async createProject(input) {
    const hostName = (await this.resolveHost(input.host)).name
    const t = await this.target(hostName)
    const root = await this.workRoot(hostName)
    const name = this.safeProject(input.name, undefined)
    const dir = `${root}/${name}`
    assertWithin(root, dir)

    const r = await t.exec(`mkdir -p ${shellQuote(dir)} && echo CREATE_OK`)
    if (!r.stdout.includes('CREATE_OK')) {
      throw new RemoteError('create-failed', (r.stderr || '创建目录失败').trim().slice(0, 300))
    }
    return { host: hostName, name, path: dir, created: true }
  }

  /** 删除云端项目。必须显式 confirm，避免手误。 */
  async removeProject(input) {
    const hostName = (await this.resolveHost(input.host)).name
    const t = await this.target(hostName)
    const root = await this.workRoot(hostName)
    const name = this.safeProject(input.name, undefined)
    const dir = `${root}/${name}`
    assertWithin(root, dir)
    if (dir === root) throw new RemoteError('invalid-project', '不能删除项目根目录。')
    if (input.confirm !== true) {
      throw new RemoteError('confirm-required', `删除 ${dir} 需要显式确认（confirm=true）。`)
    }

    const r = await t.exec(`rm -rf ${shellQuote(dir)} && echo REMOVE_OK`)
    if (!r.stdout.includes('REMOVE_OK')) {
      throw new RemoteError('remove-failed', (r.stderr || '删除失败').trim().slice(0, 300))
    }
    return { host: hostName, name, removed: true }
  }

  /** 列出项目内的文件（相对路径、大小、修改时间）。 */
  async projectFiles(input) {
    const hostName = (await this.resolveHost(input.host)).name
    const t = await this.target(hostName)
    const root = await this.workRoot(hostName)
    const name = this.safeProject(input.project, undefined)
    const dir = `${root}/${name}`
    assertWithin(root, dir)

    const depth = Math.max(1, Math.min(8, Number(input.depth) || 3))
    const limit = Math.max(1, Math.min(2000, Number(input.limit) || 300))
    const cmd =
      `cd ${shellQuote(dir)} 2>/dev/null && ` +
      `find . -maxdepth ${depth} -type f -printf '%P|%s|%T@\\n' 2>/dev/null | sort | head -n ${limit}`

    const r = await t.exec(cmd)
    if (r.code !== 0) {
      throw new RemoteError('no-project', `云端没有项目 ${name}（${dir}）。`)
    }
    const files = []
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const [path, size, mtime] = trimmed.split('|')
      if (!path) continue
      files.push({
        path,
        bytes: Number(size) || 0,
        updatedAt: mtime ? new Date(Number(mtime) * 1000).toISOString() : '',
      })
    }
    return { host: hostName, project: name, path: dir, count: files.length, files }
  }

  /**
   * 把本地文件或目录上传到云端项目（可指定子目录）。
   * 传的是"你选的东西"，不是整个工作目录。
   */
  async uploadToProject(input) {
    const localPath = String(input.localPath ?? '').trim()
    if (localPath === '') throw new RemoteError('no-input', '请提供要上传的本地文件或目录。')

    const hostName = (await this.resolveHost(input.host)).name
    const t = await this.target(hostName)
    const root = await this.workRoot(hostName)
    const project = this.safeProject(input.project, undefined)
    const projectDir = `${root}/${project}`
    assertWithin(root, projectDir)

    const subdir = String(input.subdir ?? '').trim().replace(/^[\\/]+|[\\/]+$/g, '')
    const destDir = subdir === '' ? projectDir : `${projectDir}/${subdir}`
    assertWithin(projectDir, destDir)

    const report = (patch) => {
      try {
        input.onProgress?.(patch)
      } catch {
        // 进度回调坏了也不能影响上传
      }
    }

    const resolved = resolve(localPath)
    let info
    try {
      info = await stat(resolved)
    } catch {
      throw new RemoteError('not-found', `本地路径不存在：${resolved}`)
    }

    report({ phase: 'packing', percent: 2, detail: '打包本地内容' })

    const { runProcess } = await import('./ssh.js')
    const tmp = await mkdtemp(join(tmpdir(), 'dsh-project-upload-'))
    const archive = join(tmp, 'payload.tar.gz')
    try {
      let bytes
      if (info.isDirectory()) {
        const packed = await this.packDirectory(resolved)
        try {
          await rename(packed.path, archive)
          bytes = packed.bytes
        } finally {
          await packed.cleanup().catch(() => {})
        }
      } else {
        // 单文件：只打它一个，落到目标目录同名位置
        const base = basename(resolved)
        const packed = await runProcess(
          'tar',
          ['-czf', archive, '-C', resolve(resolved, '..'), base],
          {},
          300_000,
        )
        if (packed.code !== 0) {
          throw new RemoteError('pack-failed', `打包失败：${(packed.stderr || '').trim().slice(0, 300)}`)
        }
        bytes = (await stat(archive)).size
      }

      const mb = bytes / 1024 / 1024
      if (mb > this.settings.maxUploadMb) {
        throw new RemoteError('upload-too-large', `打包后 ${mb.toFixed(1)}MB，超过上限 ${this.settings.maxUploadMb}MB。`)
      }

      report({ phase: 'uploading', percent: 5, detail: `上传 ${mb.toFixed(2)}MB`, bytes, total: bytes })
      const remoteTar = `/tmp/_dshup-${project}-${Date.now()}.tar.gz`
      await this.uploadWithProgress(t, archive, bytes, remoteTar, report)

      report({ phase: 'unpacking', percent: 93, detail: '云端解包中' })
      const up = await t.exec(
        `mkdir -p ${shellQuote(destDir)} && ` +
          `tar -xzf ${shellQuote(remoteTar)} -C ${shellQuote(destDir)} --no-same-owner && ` +
          `rm -f ${shellQuote(remoteTar)} && echo UPLOAD_OK`,
        Math.max(this.settings.commandTimeoutMs, 600_000),
      )
      if (!up.stdout.includes('UPLOAD_OK')) {
        throw new RemoteError('upload-failed', `解包失败：${(up.stderr || up.stdout).trim().slice(0, 400)}`)
      }

      report({ phase: 'done', percent: 100, detail: '上传完成' })
      return {
        host: hostName,
        project,
        remoteDir: destDir,
        source: resolved,
        kind: info.isDirectory() ? 'directory' : 'file',
        bytes,
        mb,
      }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** 把云端项目里的某个文件/目录下载到本地。 */
  async downloadFromProject(input) {
    const hostName = (await this.resolveHost(input.host)).name
    const t = await this.target(hostName)
    const root = await this.workRoot(hostName)
    const project = this.safeProject(input.project, undefined)
    const projectDir = `${root}/${project}`
    assertWithin(root, projectDir)

    const remotePath = String(input.remotePath ?? '').trim().replace(/^[\\/]+/, '')
    if (remotePath === '') throw new RemoteError('no-path', '请指定要下载的文件（项目内相对路径）。')
    const target = `${projectDir}/${remotePath}`
    assertWithin(projectDir, target)

    const localDir = resolve(String(input.localDir ?? '').trim() || process.cwd())

    const report = (patch) => {
      try {
        input.onProgress?.(patch)
      } catch {
        // ignore
      }
    }

    report({ phase: 'packing', percent: 5, detail: '云端打包' })
    const stamp = Date.now()
    const remoteTar = `/tmp/_dshdown-${project}-${stamp}.tar.gz`
    const packed = await t.exec(
      `cd ${shellQuote(projectDir)} && tar -czf ${shellQuote(remoteTar)} -- ${shellQuote(remotePath)} && ` +
        `stat -c %s ${shellQuote(remoteTar)}`,
      Math.max(this.settings.commandTimeoutMs, 600_000),
    )
    const bytes = Number((packed.stdout.trim().split(/\r?\n/).pop() || '0').trim()) || 0
    if (bytes <= 0) {
      throw new RemoteError('download-empty', `云端找不到 ${remotePath}：${(packed.stderr || '').trim().slice(0, 300)}`)
    }

    await mkdir(localDir, { recursive: true })
    const localTar = join(tmpdir(), `dsh-down-${stamp}.tar.gz`)
    report({ phase: 'downloading', percent: 40, detail: `下载 ${(bytes / 1024 / 1024).toFixed(2)}MB` })
    const dl = await t.downloadToFile(remoteTar, localTar, Math.max(this.settings.commandTimeoutMs, 600_000))
    try {
      if (dl.code !== 0) {
        throw new RemoteError('download-failed', (dl.stderr || '下载失败').trim().slice(0, 300))
      }
      report({ phase: 'unpacking', percent: 85, detail: '本地解包' })
      const { runProcess } = await import('./ssh.js')
      const unpack = await runProcess(
        'tar',
        ['-xzf', localTar, '-C', localDir, '--no-same-owner'],
        {},
        600_000,
      )
      if (unpack.code !== 0) {
        throw new RemoteError('unpack-failed', (unpack.stderr || '解包失败').trim().slice(0, 300))
      }
      report({ phase: 'done', percent: 100, detail: '下载完成' })
      return { host: hostName, project, remotePath, localDir, bytes }
    } finally {
      await rm(localTar, { force: true }).catch(() => {})
      await t.exec(`rm -f ${shellQuote(remoteTar)}`).catch(() => {})
    }
  }

  /** 列出某个项目下跑过的任务（按 meta.json 的工作目录过滤）。 */
  async projectTasks(input) {
    const hostName = (await this.resolveHost(input.host)).name
    const t = await this.target(hostName)
    const home = await this.home(hostName)
    const root = `${home}/dsh-work`
    const project = this.safeProject(input.project, undefined)
    const projectDir = `${root}/${project}`

    const cmd =
      `for f in ${shellQuote(home)}/dsh-jobs/*/meta.json; do ` +
      `[ -f "$f" ] || continue; ` +
      `d=$(dirname "$f"); ` +
      `w=$(sed -n 's/.*"workdir":"\\([^"]*\\)".*/\\1/p' "$f"); ` +
      `[ "$w" = ${shellQuote(projectDir)} ] || continue; ` +
      `s=$(cat "$d/status" 2>/dev/null); ` +
      `t=$(sed -n 's/.*"submitted_at":"\\([^"]*\\)".*/\\1/p' "$f"); ` +
      `echo "$(basename "$d")|$s|$t"; done`

    const r = await t.exec(cmd)
    const tasks = []
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const [jobId, state, submittedAt] = trimmed.split('|')
      if (!jobId) continue
      tasks.push({ jobId, state: state || 'unknown', submittedAt: submittedAt || '' })
    }
    tasks.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)))
    return { host: hostName, project, path: projectDir, count: tasks.length, tasks }
  }

  /**
   * Stream a local file to the host in chunks, reporting progress per chunk.
   *
   * ssh reads stdin; we feed the file in CHUNK-sized slices so a large upload
   * still shows movement instead of one silent minute. Progress is throttled so
   * the UI is not flooded.
   *
   * @param {SshTarget} t - target host.
   * @param {string} localPath - file to send.
   * @param {number} totalBytes - its size.
   * @param {string} remotePath - destination path.
   * @param {Function} report - progress sink.
   */
  async uploadWithProgress(t, localPath, totalBytes, remotePath, report) {
    const CHUNK = 256 * 1024
    const upload = await t.startStdin(`cat > ${shellQuote(remotePath)}`)
    const stream = createReadStream(localPath, { highWaterMark: CHUNK })
    let sent = 0
    let lastReport = 0
    // Upload occupies 5%..92% of the bar so unpack/submit still get room.
    const spanStart = 5
    const spanEnd = 92

    try {
      for await (const chunk of stream) {
        await upload.write(chunk)
        sent += chunk.length
        const now = Date.now()
        if (now - lastReport > 120 || sent >= totalBytes) {
          lastReport = now
          const ratio = totalBytes > 0 ? sent / totalBytes : 1
          report({
            phase: 'uploading',
            percent: Math.round(spanStart + ratio * (spanEnd - spanStart)),
            detail: `上传中 ${(sent / 1024 / 1024).toFixed(2)} / ${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
            bytes: sent,
            total: totalBytes,
          })
        }
      }
      const result = await upload.end()
      if (result.code !== 0) {
        throw new RemoteError('upload-failed', `上传失败：${(result.stderr || result.stdout).trim().slice(0, 500)}`)
      }
    } catch (error) {
      await upload.abort().catch(() => {})
      throw error
    }
  }

  /** Read the status / metadata of a job. */
  async status(jobId, host) {
    jobId = this.validateJobId(jobId)
    const hostName = (await this.resolveHost(host)).name
    const t = await this.target(hostName)
    const home = await this.home(hostName)
    const dir = `${home}/dsh-jobs/${jobId}`
    const cmd =
      `if [ ! -d ${shellQuote(dir)} ]; then echo __MISSING__; exit 3; fi; ` +
      `echo "STATE=$(cat ${shellQuote(`${dir}/status`)} 2>/dev/null)"; ` +
      `echo "PID=$(cat ${shellQuote(`${dir}/pid`)} 2>/dev/null)"; ` +
      `echo "META=$(cat ${shellQuote(`${dir}/meta.json`)} 2>/dev/null)"; ` +
      `echo "RESULT_BYTES=$(wc -c < ${shellQuote(`${dir}/result.md`)} 2>/dev/null)"; ` +
      `echo "LOG_LINES=$(wc -l < ${shellQuote(`${dir}/run.log`)} 2>/dev/null)"`
    const r = await t.exec(cmd)
    if (r.stdout.includes('__MISSING__')) {
      throw new RemoteError('job-not-found', `${hostName} 上没有任务 ${jobId}。可用 remote_list 查看。`)
    }
    const pick = (key) => (r.stdout.match(new RegExp(`^${key}=(.*)$`, 'm')) ?? [])[1]?.trim() ?? ''
    let meta = {}
    try { meta = JSON.parse(pick('META') || '{}') } catch { /* keep empty */ }

    const state = pick('STATE') || 'unknown'
    return {
      jobId,
      host: hostName,
      state,
      finished: ['done', 'failed', 'cancelled'].includes(state),
      pid: pick('PID') || undefined,
      workdir: meta.workdir,
      session: meta.session || undefined,
      submittedAt: meta.submitted_at,
      resultBytes: Number(pick('RESULT_BYTES')) || 0,
      logLines: Number(pick('LOG_LINES')) || 0,
    }
  }

  /** Fetch a job's final answer. */
  async result(jobId, host) {
    jobId = this.validateJobId(jobId)
    const hostName = (await this.resolveHost(host)).name
    const t = await this.target(hostName)
    const home = await this.home(hostName)
    // Capture `cat`'s own status, not the status of `echo`. Written as
    // `rc=$?` immediately after cat, because in `cat …; echo; echo __RC=$?`
    // the `$?` expands to the preceding `echo` and is therefore always 0 —
    // which made the failure branch below unreachable.
    const r = await t.exec(
      `cat ${shellQuote(`${home}/dsh-jobs/${jobId}/result.md`)} 2>/dev/null; rc=$?; echo; echo __RC=$rc`,
    )
    if (r.code !== 0 && !r.stdout.trim()) {
      throw new RemoteError('result-read-failed', (r.stderr || '读取结果失败').trim())
    }
    const text = r.stdout.replace(/\n__RC=\d+\s*$/, '').replace(/__RC=\d+\s*$/, '')
    if (text.trim() === '') {
      throw new RemoteError('result-empty', `任务 ${jobId} 还没有结果（可能仍在运行）。用 remote_status 查看状态。`)
    }
    return { jobId, host: hostName, text: text.trim() }
  }

  /** Read the run log (and stderr tail) of a job. */
  async logs(jobId, host, lines = 40) {
    jobId = this.validateJobId(jobId)
    const hostName = (await this.resolveHost(host)).name
    const t = await this.target(hostName)
    const home = await this.home(hostName)
    const dir = `${home}/dsh-jobs/${jobId}`
    const n = Math.max(1, Math.min(2000, Number(lines) || 40))
    const r = await t.exec(
      `echo '--- run.log ---'; tail -n ${n} ${shellQuote(`${dir}/run.log`)} 2>/dev/null; ` +
      `echo '--- stderr ---'; tail -n 40 ${shellQuote(`${dir}/err.log`)} 2>/dev/null`,
    )
    return { jobId, host: hostName, log: r.stdout.trim() }
  }

  /** List jobs on a host. */
  async list(host) {
    const hostName = (await this.resolveHost(host)).name
    const t = await this.target(hostName)
    const r = await t.exec('dsh-job list')
    if (r.code !== 0) {
      throw new RemoteError('list-failed', (r.stderr || 'dsh-job 未安装').trim())
    }
    const rows = r.stdout
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [id, state, ...rest] = line.split(/\s+/)
        return { jobId: id, state, submittedAt: rest.join(' ') }
      })
    return { host: hostName, count: rows.length, jobs: rows }
  }

  /** Cancel a job. */
  async cancel(jobId, host) {
    jobId = this.validateJobId(jobId)
    const hostName = (await this.resolveHost(host)).name
    const t = await this.target(hostName)
    const r = await t.exec(`dsh-job cancel ${shellQuote(jobId)}`)
    if (r.code !== 0) throw new RemoteError('cancel-failed', (r.stderr || r.stdout).trim())
    return { jobId, host: hostName, cancelled: true, message: r.stdout.trim() }
  }

  /** Block until a job finishes (polling on the cloud side). */
  async wait(jobId, host, timeoutMs) {
    jobId = this.validateJobId(jobId)
    const hostName = (await this.resolveHost(host)).name
    const t = await this.target(hostName)
    const budget = Math.max(30_000, Number(timeoutMs) || this.settings.waitTimeoutMs)
    const r = await t.exec(
      `dsh-job wait ${shellQuote(jobId)} ${Math.round(budget / 1000)}`,
      budget + 120_000,
    )
    const state = (r.stdout.trim().split(/\r?\n/).pop() || 'unknown').trim()
    const out = { jobId, host: hostName, state }
    if (state === 'done') {
      try {
        out.result = (await this.result(jobId, hostName)).text
      } catch (error) {
        out.resultError = error.message
      }
    }
    return out
  }
}
