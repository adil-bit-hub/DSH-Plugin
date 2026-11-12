/**
 * Agent tools for `dsh-remote-dispatch`.
 *
 * Plain registry objects (same shape the harness `tools` service accepts) so the
 * bundle needs no build step. Each tool is a thin wrapper over the dispatch
 * service.
 *
 * @module dsh-remote-dispatch/tools
 */
import { RemoteError } from './ssh.js'

const JSON_RENDER = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

/** Drop undefined/NaN so the envelope stays lossless JSON. */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      out[k] = clean(v)
    }
    return out
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  return value
}

function errorText(error) {
  if (error instanceof RemoteError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

const HOST_ARG = {
  type: 'string',
  description: '目标云主机名（config.hosts 的键，如 aliyun、tencent）。省略则用 defaultHost。',
}

/**
 * Register every remote-dispatch tool.
 * @param {object} ctx - host plugin context with `tools`.
 * @param {import('./service.js').RemoteDispatchService} service - dispatch service.
 * @param {object} settings - resolved config.
 */
export function registerTools(ctx, service, settings) {
  const wrap = (fn) => async (args = {}) => {
    try {
      return clean(await fn(args))
    } catch (error) {
      throw new Error(errorText(error))
    }
  }

  ctx.tools.register({
    name: 'remote_hosts',
    description:
      '列出可用的云主机，并检查每台的连通性与运行时就绪情况（node/dsh/dsh-job 是否装好）。派发任务前可用它确认目标是否可用。',
    parameters: {
      type: 'object',
      properties: {
        host: { ...HOST_ARG, description: '只检查这一台；省略则检查全部。' },
        probe: { type: 'boolean', description: '是否真正 SSH 连上去探测（默认 true）。' },
      },
    },
    output: { schema: {}, render: JSON_RENDER },
    execute: wrap(async (args) => {
      const all = await service.deviceNames()
      const names = args.host ? [(await service.resolveHost(args.host)).name] : all
      const results = []
      for (const name of names) {
        if (args.probe === false) {
          const { entry } = await service.resolveHost(name)
          results.push({ host: name, label: entry?.label, credentialId: entry?.credentialId })
          continue
        }
        try {
          const { entry } = await service.resolveHost(name)
          results.push({ host: name, label: entry?.label, ...(await service.probe(name)) })
        } catch (error) {
          results.push({ host: name, reachable: false, error: errorText(error) })
        }
      }
      return { defaultHost: await service.defaultDeviceName(), count: results.length, hosts: results }
    }),
  })

  ctx.tools.register({
    name: 'remote_dispatch',
    description:
      '把一个任务派发到云服务器的 DSH 上执行，立刻返回 jobId，不阻塞。云端用 setsid+nohup 与 SSH 会话彻底脱钩，' +
      '因此本地断网、关机、休眠都不影响它继续跑完。适合：长耗时任务、即将断网、希望任务在云端挂机完成。' +
      '可先用 localDir 把本地项目打包上传，让云端在同样的代码上干活；用 continueSession 传上一次的 jobId 可续跑会话上下文。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '任务内容（自然语言，云端 DSH 会作为一次完整任务执行）。' },
        host: HOST_ARG,
        project: { type: 'string', description: '项目名，决定云端工作目录 ~/dsh-work/<project>。省略时用 localDir 的目录名或 default。' },
        localDir: { type: 'string', description: '可选：本地目录绝对路径。会打包（排除 node_modules/.git 等）上传到云端工作目录后再执行。' },
        continueSession: { type: 'string', description: '可选：上一次任务的 jobId，续跑它的会话，云端模型会记得前文。' },
        jobId: { type: 'string', description: '可选：自定义 jobId，便于识别。默认 <project>-<月日-时分秒>。' },
      },
      required: ['task'],
    },
    output: { schema: {}, render: JSON_RENDER },
    execute: wrap(async (args) => service.dispatch(args)),
  })

  ctx.tools.register({
    name: 'remote_status',
    description: '查询云端任务的执行状态（queued/running/done/failed/cancelled）与元信息。断网回来后用它确认进度。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '派发时返回的 jobId。' },
        host: HOST_ARG,
      },
      required: ['jobId'],
    },
    output: { schema: {}, render: JSON_RENDER },
    execute: wrap(async (args) => service.status(args.jobId, args.host)),
  })

  ctx.tools.register({
    name: 'remote_result',
    description: '取回云端任务的最终答复。任务仍在运行时返回错误提示，请改用 remote_status 或 remote_wait。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '派发时返回的 jobId。' },
        host: HOST_ARG,
      },
      required: ['jobId'],
    },
    output: { schema: {}, render: JSON_RENDER },
    execute: wrap(async (args) => service.result(args.jobId, args.host)),
  })

  ctx.tools.register({
    name: 'remote_wait',
    description:
      '等待云端任务跑完并直接返回最终答复。注意：这会让本地一直连着（仍可随时中断，任务不受影响，之后用 remote_result 取）。' +
      '打算断网时不要用这个，改用 remote_status / remote_result。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '派发时返回的 jobId。' },
        host: HOST_ARG,
        timeoutSeconds: { type: 'number', description: '最长等待秒数，默认 3600，上限 21600。' },
      },
      required: ['jobId'],
    },
    output: { schema: {}, render: JSON_RENDER },
    execute: wrap(async (args) => {
      const seconds = Math.max(30, Math.min(21_600, Number(args.timeoutSeconds) || settings.waitTimeoutMs / 1000))
      return service.wait(args.jobId, args.host, seconds * 1000)
    }),
  })

  ctx.tools.register({
    name: 'remote_logs',
    description: '查看云端任务的运行日志（run.log 与 stderr 末尾），任务失败时用它排错。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '派发时返回的 jobId。' },
        host: HOST_ARG,
        lines: { type: 'number', description: 'run.log 取末尾多少行，默认 40。' },
      },
      required: ['jobId'],
    },
    output: { schema: {}, render: JSON_RENDER },
    execute: wrap(async (args) => service.logs(args.jobId, args.host, args.lines)),
  })

  ctx.tools.register({
    name: 'remote_list',
    description: '列出某台云主机上的所有任务及其状态，忘了 jobId 时用它找回来。',
    parameters: {
      type: 'object',
      properties: { host: HOST_ARG },
    },
    output: { schema: {}, render: JSON_RENDER },
    execute: wrap(async (args) => service.list(args.host)),
  })

  ctx.tools.register({
    name: 'remote_push_session',
    description:
      '把「当前进行中的这段对话」整体搬到云端继续：整段对话以文字记录随任务下发，本会话所在的项目目录自动打包上传，' +
      '云端带着完整上下文接着干。适合任务很长、即将断网/关机、或希望挂机跑完时使用。' +
      '完成后可用 remote_pull 把云端改动同步回本地。',
    parameters: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: '希望云端接着做什么；留空则让它继续完成最后一件未完成的事。' },
        host: HOST_ARG,
        project: { type: 'string', description: '云端项目名（工作目录），默认用本地目录名。' },
        syncFiles: { type: 'boolean', description: '是否同步本会话的项目文件，默认 true。' },
        sessionId: { type: 'string', description: '可选：指定会话 id；省略则自动取本机最近活动的会话。' },
      },
    },
    output: { schema: {}, render: JSON_RENDER },
    execute: wrap(async (args) => service.dispatchSession(args)),
  })

  ctx.tools.register({
    name: 'remote_pull',
    description:
      '把云端项目目录的改动拉回本地，覆盖前会先备份本地内容。用于「两边同步」：云端跑完后把结果文件取回来。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '云端项目名（与推送时一致）。' },
        localDir: { type: 'string', description: '本地目标目录，默认沿用该项目的本地路径。' },
        host: HOST_ARG,
      },
      required: ['project'],
    },
    output: { schema: {}, render: JSON_RENDER },
    execute: wrap(async (args) => service.pull(args)),
  })

  ctx.tools.register({
    name: 'remote_cancel',
    description: '取消云端任务（杀掉整个进程组）。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '要取消的 jobId。' },
        host: HOST_ARG,
      },
      required: ['jobId'],
    },
    output: { schema: {}, render: JSON_RENDER },
    execute: wrap(async (args) => service.cancel(args.jobId, args.host)),
  })

  ctx.tools.register({
    name: 'remote_devices',
    description:
      '管理已绑定的云端设备（云服务器）：列出设备、绑定一台 SSH 服务器为设备、设置默认设备、或解绑。' +
      '设备通过 SSH 凭据关联，密码/私钥仍由凭据管家保管。删除设备不会删除凭据。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'bind', 'unbind', 'setDefault', 'sshCredentials'],
          description: 'list=列出；bind=绑定/更新；unbind=解绑；setDefault=设为默认；sshCredentials=列出可绑定的 SSH 凭据。',
        },
        name: { type: 'string', description: '设备名（字母数字-_），bind/unbind/setDefault 用。' },
        label: { type: 'string', description: '显示名，如「我的云主机 A」。' },
        credentialId: { type: 'string', description: '绑定的 SSH 凭据 id（从 sshCredentials 获取）。' },
        workRoot: { type: 'string', description: '云端工作根目录，留空则用 ~/dsh-work。' },
        note: { type: 'string', description: '备注。' },
      },
      required: ['action'],
    },
    output: { schema: {}, render: JSON_RENDER },
    execute: wrap(async (args) => {
      const registry = service.registry
      const action = String(args.action ?? 'list')
      if (action === 'list') {
        const { defaultDevice, devices } = await registry.list()
        return { defaultDevice, devices }
      }
      if (action === 'sshCredentials') {
        return { credentials: await service.listSshCredentials() }
      }
      if (action === 'bind') {
        const device = await registry.upsert({
          name: args.name,
          label: args.label,
          credentialId: args.credentialId,
          workRoot: args.workRoot,
          note: args.note,
          makeDefault: args.name ? undefined : true,
        })
        return { device, message: `设备「${device.name}」已绑定到凭据 ${device.credentialId}` }
      }
      if (action === 'unbind') {
        return await registry.remove(args.name)
      }
      if (action === 'setDefault') {
        return await registry.setDefault(args.name)
      }
      throw new Error(`未知 action：${action}`)
    }),
  })
}
