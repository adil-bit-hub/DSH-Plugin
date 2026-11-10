/**
 * SSH transport for `dsh-remote-dispatch`.
 *
 * We deliberately use the platform OpenSSH client (the same approach as
 * dsh-credential-vault) so the plugin has zero runtime dependencies and works on
 * Windows / Linux / macOS alike. Credentials come from the DSH credential store
 * and are handed to ssh through SSH_ASKPASS for passwords, or a temporary key
 * file for private keys — never as a command-line argument, so secrets do not
 * appear in the process list, the shell history or the tool arguments.
 *
 * @module dsh-remote-dispatch/ssh
 */
import { spawn } from 'node:child_process'
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_OUTPUT = 200_000
const ASKPASS_VAR = 'DSH_REMOTE_ASKPASS'

// Windows OpenSSH runs the askpass program through posix_spawnp, which cannot
// execute a batch file, so compile a tiny .NET helper once (same trick as the
// credential vault).
const ASKPASS_CS = `using System;
using System.Text;
class DshRemoteAskpass {
  static int Main() {
    string secret = Environment.GetEnvironmentVariable("DSH_REMOTE_ASKPASS");
    if (secret == null) return 1;
    byte[] bytes = new UTF8Encoding(false).GetBytes(secret);
    using (System.IO.Stream output = Console.OpenStandardOutput()) {
      output.Write(bytes, 0, bytes.Length);
      output.Flush();
    }
    return 0;
  }
}
`

const ASKPASS_SH = `#!/bin/sh
printf '%s' "$DSH_REMOTE_ASKPASS"
`

export class RemoteError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function helperDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(process.env.USERPROFILE ?? process.env.HOME ?? tmpdir(), '.dsh')
  return join(home, 'storages', 'dsh-remote-dispatch')
}

function findCsc() {
  if (process.platform !== 'win32') return undefined
  for (const root of [process.env.WINDIR ?? 'C:\\Windows', 'C:\\Windows']) {
    for (const framework of ['Framework64', 'Framework']) {
      const candidate = join(root, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe')
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

let askpassPromise

/** Build the askpass helper once per process and return its path. */
function ensureAskpass() {
  if (askpassPromise) return askpassPromise
  askpassPromise = (async () => {
    const dir = helperDir()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })

    if (process.platform !== 'win32') {
      const target = join(dir, 'askpass.sh')
      await writeFile(target, ASKPASS_SH, 'utf8')
      await chmod(target, 0o700)
      return target
    }

    const target = join(dir, 'askpass.exe')
    try {
      await access(target)
      return target
    } catch {
      // compile below
    }
    const csc = findCsc()
    if (!csc) {
      throw new RemoteError(
        'askpass-unavailable',
        '找不到 csc.exe，无法为密码登录构建 askpass 助手；请改用私钥登录，或手动生成该助手。',
      )
    }
    const source = join(dir, 'askpass.cs')
    await writeFile(source, ASKPASS_CS, 'utf8')
    await runProcess(csc, ['/nologo', '/target:exe', `/out:${target}`, source], {}, 60_000)
    return target
  })()
  return askpassPromise
}

/** Spawn a process and collect its output, with an optional stdin payload. */
export function runProcess(command, args, options = {}, timeoutMs = 120_000, input) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, {
        ...options,
        windowsHide: true,
        shell: false,
      })
    } catch (error) {
      reject(new RemoteError('spawn-failed', `无法启动 ${command}: ${error.message}`))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      reject(new RemoteError('timeout', `命令超时（${Math.round(timeoutMs / 1000)}s）：${command}`))
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new RemoteError('spawn-failed', `无法启动 ${command}: ${error.message}`))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? 0, stdout, stderr })
    })

    if (input !== undefined && child.stdin) {
      child.stdin.end(input)
    } else {
      child.stdin?.end()
    }
  })
}

/** Quote a value for safe use inside a POSIX shell command string. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * One SSH connection target built from a stored credential.
 */
export class SshTarget {
  /**
   * @param {object} record - normalized credential record with user/host/port/auth.
   * @param {object} options - resolved plugin settings.
   */
  constructor(record, options = {}) {
    this.record = record
    this.options = options
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000
  }

  get label() {
    return `${this.record.username}@${this.record.host}:${this.record.port ?? 22}`
  }

  /** Build the base argv shared by every ssh invocation. */
  async baseArgs(extra = []) {
    const r = this.record
    const args = [
      '-o', 'BatchMode=no',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=4',
      '-o', 'ConnectTimeout=15',
      '-o', 'LogLevel=ERROR',
      '-o', 'PreferredAuthentications=' + (r.authMethod === 'key' ? 'publickey' : 'publickey,password,keyboard-interactive'),
      '-p', String(r.port ?? 22),
      ...extra,
      `${r.username}@${r.host}`,
    ]
    return args
  }

  /** Prepare environment + temp files needed for authentication. */
  async auth() {
    const r = this.record
    const env = { ...process.env }
    const cleanup = []

    if (r.authMethod === 'key' && r.privateKey) {
      // Write the key to a short-lived 0600 file: ssh has no stdin key option.
      const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-key-'))
      const keyPath = join(dir, 'id')
      await writeFile(keyPath, r.privateKey.endsWith('\n') ? r.privateKey : `${r.privateKey}\n`, { mode: 0o600 })
      await chmod(keyPath, 0o600).catch(() => {})
      cleanup.push(() => rm(dir, { recursive: true, force: true }))
      return { env, extraArgs: ['-i', keyPath, '-o', 'IdentitiesOnly=yes'], cleanup, usesAskpass: false }
    }

    const askpass = await ensureAskpass()
    env[ASKPASS_VAR] = r.password ?? ''
    env.SSH_ASKPASS = askpass
    env.SSH_ASKPASS_REQUIRE = 'force'
    // Without a TTY ssh prefers askpass; DISPLAY is also required by some builds.
    if (!env.DISPLAY) env.DISPLAY = ':0'
    return { env, extraArgs: [], cleanup, usesAskpass: true }
  }

  /**
   * Run one command on the remote host.
   * @param {string} command - POSIX shell command.
   * @returns {Promise<{code:number, stdout:string, stderr:string}>}
   */
  async exec(command, timeoutMs) {
    const auth = await this.auth()
    try {
      const args = await this.baseArgs(auth.extraArgs)
      args.push(command)
      const result = await runProcess('ssh', args, { env: auth.env }, timeoutMs ?? this.commandTimeoutMs)
      return result
    } finally {
      await Promise.all(auth.cleanup.map((fn) => fn().catch(() => {})))
    }
  }

  /**
   * Pipe a byte buffer into a remote command (used for uploads).
   * @param {string} command - remote command; receives the data on stdin.
   * @param {Buffer} data - payload.
   */
  async execWithStdin(command, data, timeoutMs) {
    const auth = await this.auth()
    try {
      const args = await this.baseArgs(auth.extraArgs)
      args.push(command)
      return await runProcess('ssh', args, { env: auth.env }, timeoutMs ?? this.commandTimeoutMs, data)
    } finally {
      await Promise.all(auth.cleanup.map((fn) => fn().catch(() => {})))
    }
  }

  /**
   * Open a command whose stdin stays writable, for streamed uploads.
   *
   * Returns a small handle rather than a promise so the caller can push chunks
   * and observe progress as it goes.
   *
   * @param {string} command - remote command reading stdin.
   * @param {number} [timeoutMs]
   * @returns {Promise<{write:(buf:Buffer)=>Promise<void>, end:()=>Promise<{code:number,stdout:string,stderr:string}>, abort:()=>Promise<void>}>}
   */
  async startStdin(command, timeoutMs) {
    const auth = await this.auth()
    const args = await this.baseArgs(auth.extraArgs)
    args.push(command)

    const child = spawn('ssh', args, { env: auth.env, windowsHide: true, shell: false })

    let stdout = ''
    let stderr = ''
    let closed = false
    let failure
    let exitCode = 0

    const done = new Promise((resolve) => {
      child.stdout?.on('data', (c) => {
        if (stdout.length < MAX_OUTPUT) stdout += c.toString('utf8')
      })
      child.stderr?.on('data', (c) => {
        if (stderr.length < MAX_OUTPUT) stderr += c.toString('utf8')
      })
      child.on('error', (error) => {
        failure = failure ?? error
        closed = true
        resolve()
      })
      child.on('close', (code) => {
        exitCode = code ?? 0
        closed = true
        resolve()
      })
      // A remote failure while we are still writing would otherwise look like a
      // stalled write; surface it as an EPIPE we can inspect.
      child.stdin?.on('error', (error) => {
        failure = failure ?? error
      })
    })

    const cleanup = () => Promise.all(auth.cleanup.map((fn) => fn().catch(() => {})))

    // Guard against a wedged connection.
    const budget = timeoutMs ?? this.commandTimeoutMs
    const timer = setTimeout(() => {
      if (!closed) {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        failure = failure ?? new RemoteError('timeout', `上传超时（${Math.round(budget / 1000)}s）`)
      }
    }, budget)

    const write = (buf) => new Promise((resolve, reject) => {
      if (failure) {
        reject(new RemoteError('upload-aborted', `上传中断：${failure.message}`))
        return
      }
      let settled = false
      child.stdin.write(buf, (error) => {
        if (settled) return
        settled = true
        if (error) reject(new RemoteError('upload-aborted', `写入失败：${error.message}`))
        else resolve()
      })
    })

    const end = async () => {
      child.stdin.end()
      await done
      clearTimeout(timer)
      await cleanup()
      if (failure) throw new RemoteError('upload-failed', `上传失败：${failure.message}`)
      return { code: exitCode, stdout, stderr }
    }

    const abort = async () => {
      clearTimeout(timer)
      try { child.stdin.destroy() } catch { /* ignore */ }
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      await cleanup()
    }

    return { write, end, abort }
  }

  /**
   * Stream a remote file to a local path, byte-exact.
   *
   * The text-oriented helpers collect stdout as a UTF-8 string, which destroys
   * binary payloads (a tar.gz arrives as garbage). This writes raw chunks to
   * disk instead.
   *
   * @param {string} remotePath - file to read on the host.
   * @param {string} localPath - destination on this machine.
   * @param {number} [timeoutMs]
   */
  async downloadToFile(remotePath, localPath, timeoutMs) {
    const { createWriteStream } = await import('node:fs')
    const auth = await this.auth()
    try {
      const args = await this.baseArgs(auth.extraArgs)
      args.push(`cat -- ${shellQuote(remotePath)}`)

      const child = spawn('ssh', args, { env: auth.env, windowsHide: true, shell: false })
      const out = createWriteStream(localPath)
      let stderr = ''
      let exitCode = 0

      child.stdout.on('data', (chunk) => out.write(chunk))
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 4000) stderr += chunk.toString('utf8')
      })

      const finished = new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code) => {
          exitCode = code ?? 0
          resolve()
        })
        out.on('error', reject)
      })

      const budget = timeoutMs ?? this.commandTimeoutMs
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }, budget)

      try {
        await finished
      } finally {
        clearTimeout(timer)
        await new Promise((resolve) => out.end(resolve))
      }
      return { code: exitCode, stderr }
    } finally {
      await Promise.all(auth.cleanup.map((fn) => fn().catch(() => {})))
    }
  }

  /** Copy a remote file back as a Buffer. */
  async download(remotePath, timeoutMs) {
    const auth = await this.auth()
    try {
      const args = await this.baseArgs(auth.extraArgs)
      args.push(`cat -- ${shellQuote(remotePath)}`)
      const result = await runProcess('ssh', args, { env: auth.env }, timeoutMs ?? this.commandTimeoutMs)
      return result
    } finally {
      await Promise.all(auth.cleanup.map((fn) => fn().catch(() => {})))
    }
  }
}
