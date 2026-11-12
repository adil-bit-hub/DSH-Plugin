/**
 * Browser ⇄ Host channel for the composer push button.
 *
 * The Harness Connection service's private RPC channel registers against the
 * provider context, so a third-party plugin cannot use it. Like
 * dsh-credential-vault, we register our own prefix route on the Host web server
 * and run the Connection admission check ourselves: only an authenticated
 * browser peer of this Host passes the Host/Origin fence and the signed session
 * cookie.
 *
 * Progress is streamed as newline-delimited JSON (NDJSON) so the browser can
 * paint an upload bar while the bytes are still moving. Everything else answers
 * with the usual single `{ok, value|error}` envelope.
 *
 * @module dsh-remote-dispatch/rpc
 */
import { basename, join } from 'node:path'
import { RemoteError } from './ssh.js'

/** Route prefix; the browser half posts to `<prefix>/<endpoint>`. */
export const RPC_CHANNEL = '/remote-dispatch'

const MAX_BODY_BYTES = 1024 * 1024
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
})

function send(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function failure(error) {
  if (error instanceof RemoteError) {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, error: { code: 'internal', message } }
}

async function readJson(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.byteLength
    if (total > MAX_BODY_BYTES) throw new RemoteError('too-large', '请求体过大。')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RemoteError('invalid', '请求体不是合法的 JSON。')
  }
}

function record(payload) {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
}

/**
 * Register the dispatch HTTP endpoints.
 * @param {object} web - context injected with `connection` and `webServer`.
 * @param {import('./service.js').RemoteDispatchService} service
 * @param {object} settings
 */
export function registerRpc(web, service, settings) {
  const handlers = {
    /** 云端项目列表（`~/dsh-work/*`）。 */
    async projects(payload) {
      const body = record(payload)
      return await service.projects(typeof body.host === 'string' ? body.host : undefined)
    },

    /** 新建云端项目。 */
    async createProject(payload) {
      const body = record(payload)
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        throw new RemoteError('invalid', '请提供项目名。')
      }
      return await service.createProject(body)
    },

    /** 删除云端项目（必须 confirm=true）。 */
    async removeProject(payload) {
      const body = record(payload)
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        throw new RemoteError('invalid', '请提供项目名。')
      }
      return await service.removeProject(body)
    },

    /** 项目内文件列表。 */
    async projectFiles(payload) {
      const body = record(payload)
      if (typeof body.project !== 'string' || body.project.trim() === '') {
        throw new RemoteError('invalid', '请提供项目名。')
      }
      return await service.projectFiles(body)
    },

    /** 项目下跑过的任务。 */
    async projectTasks(payload) {
      const body = record(payload)
      if (typeof body.project !== 'string' || body.project.trim() === '') {
        throw new RemoteError('invalid', '请提供项目名。')
      }
      return await service.projectTasks(body)
    },

    /** 上传本地文件/目录到项目（NDJSON 进度流）。 */
    async uploadToProject(payload, res) {
      const body = record(payload)
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      })
      const emit = (line) => {
        try {
          res.write(`${JSON.stringify(line)}\n`)
        } catch {
          // 浏览器断开也不影响云端的上传
        }
      }
      try {
        const result = await service.uploadToProject({
          ...body,
          onProgress: (progress) => emit({ type: 'progress', ...progress }),
        })
        emit({ type: 'done', result })
      } catch (error) {
        emit({ type: 'error', error: failure(error).error })
      } finally {
        res.end()
      }
    },

    /** 从项目下载文件/目录到本地（NDJSON 进度流）。 */
    async downloadFromProject(payload, res) {
      const body = record(payload)
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      })
      const emit = (line) => {
        try {
          res.write(`${JSON.stringify(line)}\n`)
        } catch {
          // ignore
        }
      }
      try {
        const result = await service.downloadFromProject({
          ...body,
          onProgress: (progress) => emit({ type: 'progress', ...progress }),
        })
        emit({ type: 'done', result })
      } catch (error) {
        emit({ type: 'error', error: failure(error).error })
      } finally {
        res.end()
      }
    },

    /** Devices + defaults. Never includes a secret. */
    async hosts() {
      const { defaultDevice, devices } = await service.registry.list()
      const enriched = []
      for (const device of devices) {
        let ssh = null
        try {
          const rec = await service.readCredential(device.credentialId)
          ssh = { host: rec.host, port: rec.port, username: rec.username, authMethod: rec.authMethod }
        } catch (error) {
          ssh = { error: failure(error).error.message }
        }
        enriched.push({ ...device, ssh })
      }
      return {
        defaultHost: defaultDevice,
        defaultDevice,
        hosts: enriched.map((d) => ({ name: d.name, label: d.label })),
        devices: enriched,
        maxUploadMb: settings.maxUploadMb,
      }
    },

    /** Available ssh credentials to bind a device to. */
    async credentials() {
      const list = await service.listSshCredentials()
      return { credentials: list }
    },

    /** Create or update a device binding. */
    async saveDevice(payload) {
      const body = record(payload)
      const device = await service.registry.upsert(body)
      return { device }
    },

    /** Remove a device binding (the ssh credential itself is kept). */
    async removeDevice(payload) {
      const { name } = record(payload)
      if (typeof name !== 'string' || name.trim() === '') throw new RemoteError('invalid', '缺少设备名。')
      return await service.registry.remove(name)
    },

    /** Choose the default device. */
    async setDefaultDevice(payload) {
      const { name } = record(payload)
      if (typeof name !== 'string' || name.trim() === '') throw new RemoteError('invalid', '缺少设备名。')
      return await service.registry.setDefault(name)
    },

    async probe(payload) {
      const { host } = record(payload)
      const names = host ? [(await service.resolveHost(host)).name] : await service.deviceNames()
      const results = []
      for (const name of names) {
        try {
          const { entry } = await service.resolveHost(name)
          results.push({ name, label: entry?.label, ...(await service.probe(name)) })
        } catch (error) {
          results.push({ name, reachable: false, error: failure(error).error.message })
        }
      }
      return { hosts: results }
    },

    /**
     * Push a task that came from the composer.
     *
     * `task` is the user's message text, `localDir` an optional project folder
     * to upload first. The reply is NDJSON: progress lines, then a final line.
     */
    async push(payload, res) {
      const body = record(payload)
      const task = typeof body.task === 'string' ? body.task.trim() : ''
      if (task === '') throw new RemoteError('empty-task', '没有可推送的任务内容。')

      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      })

      const emit = (line) => {
        try {
          res.write(`${JSON.stringify(line)}\n`)
        } catch {
          // the browser went away; the dispatch itself keeps running
        }
      }

      try {
        const result = await service.dispatch({
          task,
          host: typeof body.host === 'string' ? body.host : undefined,
          project: typeof body.project === 'string' ? body.project : undefined,
          localDir: typeof body.localDir === 'string' && body.localDir.trim() !== '' ? body.localDir : undefined,
          continueSession: typeof body.continueSession === 'string' ? body.continueSession : undefined,
          onProgress: (progress) => emit({ type: 'progress', ...progress }),
        })
        emit({ type: 'done', result })
      } catch (error) {
        emit({ type: 'error', error: failure(error).error })
      } finally {
        res.end()
      }
    },


    async status(payload) {
      const { jobId, host } = record(payload)
      if (typeof jobId !== 'string' || jobId === '') throw new RemoteError('invalid', '缺少 jobId。')
      return await service.status(jobId, typeof host === 'string' ? host : undefined)
    },

    async result(payload) {
      const { jobId, host } = record(payload)
      if (typeof jobId !== 'string' || jobId === '') throw new RemoteError('invalid', '缺少 jobId。')
      return await service.result(jobId, typeof host === 'string' ? host : undefined)
    },

    async list(payload) {
      const { host } = record(payload)
      return await service.list(typeof host === 'string' ? host : undefined)
    },

    async cancel(payload) {
      const { jobId, host } = record(payload)
      if (typeof jobId !== 'string' || jobId === '') throw new RemoteError('invalid', '缺少 jobId。')
      return await service.cancel(jobId, typeof host === 'string' ? host : undefined)
    },

    async logs(payload) {
      const { jobId, host, lines } = record(payload)
      if (typeof jobId !== 'string' || jobId === '') throw new RemoteError('invalid', '缺少 jobId。')
      return await service.logs(jobId, typeof host === 'string' ? host : undefined, lines)
    },
  }

  const STREAMING = new Set(['push', 'uploadToProject', 'downloadFromProject'])

  const handler = async (req, res) => {
    let admission
    try {
      admission = web.connection.admit(req)
    } catch (error) {
      web.logger?.warn?.(error)
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('admission failed')
      return
    }
    if (admission.rejection !== undefined) {
      res.writeHead(admission.rejection, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }

    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const endpoint = pathname.startsWith(`${RPC_CHANNEL}/`) ? pathname.slice(RPC_CHANNEL.length + 1) : ''
    if (req.method !== 'POST' || endpoint === '' || endpoint.includes('/')) {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' })
      res.end('method not allowed')
      return
    }

    const fn = handlers[endpoint]
    if (fn === undefined) {
      send(res, 404, { ok: false, error: { code: 'not-found', message: `未知的接口：${endpoint}` } })
      return
    }

    try {
      const payload = await readJson(req)
      if (STREAMING.has(endpoint)) {
        // The handler owns the response and its framing.
        await fn(payload, res)
        return
      }
      const value = await fn(payload)
      send(res, 200, { ok: true, value })
    } catch (error) {
      if (!res.headersSent) send(res, 200, failure(error))
      else res.end()
    }
  }

  web.effect(
    () => web.webServer.register({ kind: 'prefix', path: RPC_CHANNEL, handler }),
    'remote-dispatch: composer route',
  )
}
