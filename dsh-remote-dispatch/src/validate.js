/**
 * Strict validators for every value that reaches a remote filesystem path.
 *
 * Why this file exists: `shellQuote` prevents *shell injection*, but it says
 * nothing about *path traversal*. A value like `..` or `../../.ssh` quotes
 * perfectly and still walks out of the intended directory. Every identifier
 * that is interpolated into a remote path must therefore be whitelisted here
 * before it is used, never sanitized into something else.
 *
 * Rule: sanitize-or-reject. Rejecting is preferred — silently rewriting
 * `我的项目` into `default` gives two different users the same directory and
 * turns a typo into a data-collision. Callers that accept user input should
 * surface the RemoteError to the user instead.
 *
 * @module dsh-remote-dispatch/validate
 */

/** Thrown when an identifier is unsafe. Mirrors the service's RemoteError shape. */
export class ValidationError extends Error {
  /**
   * @param {string} code - machine-readable code, e.g. `invalid-job-id`.
   * @param {string} message - user-facing explanation.
   */
  constructor(code, message) {
    super(message)
    this.name = 'ValidationError'
    this.code = code
  }
}

/**
 * A safe identifier: letters, digits, dot, underscore, dash.
 * Must start with an alphanumeric so it can never be `.` or `..`,
 * and may not contain a `..` sequence anywhere.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Longest identifier we accept. Comfortably below every common filesystem
 * limit (255 bytes) while leaving room for the `<id>/meta.json` suffix.
 */
export const MAX_ID_LENGTH = 128

/**
 * Validate a single path segment.
 * @param {unknown} value - candidate.
 * @param {string} field - human name used in the error message.
 * @returns {string} the same value, trimmed.
 * @throws {ValidationError} if the value is not a safe segment.
 */
export function assertSegment(value, field) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') {
    throw new ValidationError(`invalid-${field}`, `${field} 不能为空。`)
  }
  if (text.length > MAX_ID_LENGTH) {
    throw new ValidationError(`invalid-${field}`, `${field} 超过 ${MAX_ID_LENGTH} 个字符。`)
  }
  if (text === '.' || text === '..') {
    throw new ValidationError(`invalid-${field}`, `${field} 不能是 "." 或 ".."。`)
  }
  if (text.includes('..')) {
    throw new ValidationError(`invalid-${field}`, `${field} 不能包含 ".."。`)
  }
  if (!SEGMENT.test(text)) {
    throw new ValidationError(
      `invalid-${field}`,
      `${field} 只能包含字母、数字、点、下划线、短横线，且必须以字母或数字开头；收到 ${JSON.stringify(text)}。`,
    )
  }
  return text
}

/**
 * Validate a job id.
 * @param {unknown} value - candidate.
 * @returns {string} the validated job id.
 */
export function assertJobId(value) {
  return assertSegment(value, 'jobId')
}

/**
 * Validate a project name (the `~/dsh-work/<project>` component).
 * @param {unknown} value - candidate.
 * @returns {string} the validated project name.
 */
export function assertProject(value) {
  return assertSegment(value, 'project')
}

/**
 * Derive a default project name from an absolute local directory.
 *
 * Non-ASCII directory names are common (and supported) on the local side, but
 * the derived name must still be a safe remote segment. We transliterate
 * nothing and instead append a short hash of the original path, so two
 * different Chinese project names never collapse onto the same directory.
 * @param {string} localDir - absolute local path.
 * @param {string} [hash] - precomputed short hash (injected for tests).
 * @returns {string} a safe project name.
 */
export function projectFromLocalDir(localDir, hash) {
  const base = String(localDir).replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  const slug = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 40)
  const suffix = hash ?? stableHash(localDir)
  return assertProject(slug ? `${slug}-${suffix}` : `p-${suffix}`)
}

/**
 * Deterministic, collision-resistant 8-char hash of a string.
 *
 * FNV-1a over UTF-16 code units, rendered as hex. Good enough to separate
 * distinct directory names; it is *not* a cryptographic hash.
 * @param {string} input - value to hash.
 * @returns {string} 8 hex characters.
 */
export function stableHash(input) {
  let hash = 0x811c9dc5
  const text = String(input)
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Assert that `root` is a strict path prefix of `child` after normalization.
 * Belt-and-braces for any path built from user input: even if a future
 * validated upstream, this catches an escape at the point of use.
 * @param {string} root - absolute root directory.
 * @param {string} child - absolute path that must live inside `root`.
 * @returns {string} `child`.
 * @throws {ValidationError} when `child` escapes `root`.
 */
export function assertWithin(root, child) {
  const norm = (value) => normalizeUnix(value.replace(/\/+$/, ''))
  const normRoot = norm(root)
  const normChild = norm(child)
  if (normChild !== normRoot && !normChild.startsWith(`${normRoot}/`)) {
    throw new ValidationError('path-escape', `路径 ${child} 逃出了 ${root}。`)
  }
  return child
}

/**
 * Collapse `.` and `..` segments in an absolute POSIX path, lexically.
 * Pure string math — no filesystem access, and intentionally does not resolve
 * symlinks (the remote side may not share this machine's namespace).
 * @param {string} value - absolute POSIX path.
 * @returns {string} normalized path with no `.` or `..` segments.
 */
export function normalizeUnix(value) {
  const absolute = String(value).startsWith('/')
  /** @type {string[]} */
  const out = []
  for (const part of String(value).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(part)
  }
  return `${absolute ? '/' : ''}${out.join('/')}` || (absolute ? '/' : '.')
}
