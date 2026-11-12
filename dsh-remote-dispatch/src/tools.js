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
    name: 'remote_projects',
    description:
      '管理云端的「项目」（云端就是 ~/dsh-work/<项目名> 目录）。' +
      'list=列出所有项目（文件数/体积/更新时间）；create=新建空项目；remove=删除项目（需 confirm=true）；' +
      'files=列出项目内文件；tasks=列出该项目跑过的任务。用来像本地一样操作两台云端 DSH。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'remove', 'files', 'tasks'], description: '要执行的操作。' },
        host: HOST_ARG,
        project: { type: 'string', description: '项目名（create/remove/files/tasks 必填）。' },
        confirm: { type: 'boolean', description: 'remove 时必须显式传 true。' },
        depth: { type: 'number', description: 'files 时的目录深度，默认 3。' },
      },
      required: ['action'],
    },
    output: { schema: {}, render: JSON_RENDER },
    execute: wrap(async (args) => {
      const action = String(args.action ?? 'list')
      if (action === 'list') return await service.projects(args.host)
      if (action === 'create') return await service.createProject({ host: args.host, name: args.project })
      if (action === 'remove') return await service.removeProject({ host: args.host, name: args.project, confirm: args.confirm === true })
      if (action === 'files') return await service.projectFiles({ host: args.host, project: args.project, depth: args.depth })
      if (action === 'tasks') return await service.projectTasks({ host: args.host, project: args.project })
      throw new Error(`未知 action：${action}`)
    }),
  })

  ctx.tools.register({
    name: 'remote_upload',
    description:
      '把本地文件或目录上传到云端项目（可指定项目内子目录）。只上传你指定的这一项，不会搬整个目录。' +
      '上传后可在该项目里用 remote_task 开任务或 remote_dispatch 派发。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '目标项目名（不存在会自动创建目录）。' },
        localPath: { type: 'string', description: '本地文件或目录的绝对路径。' },
        subdir: { type: 'string', description: '项目内的子目录，可留空表示项目根。' },
        host: HOST_ARG,
      },
      required: ['project', 'localPath'],
    },
    output: { schema: {}, render: JSON_RENDER },
    execute: wrap(async (args) => service.uploadToProject(args)),
  })

  ctx.tools.register({
    name: 'remote_download',
    description: '把云端项目里的文件或目录下载到本地指定目录。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目名。' },
        remotePath: { type: 'string', description: '项目内的相对路径，例如 src/main.py。' },
        localDir: { type: 'string', description: '本地落地目录（绝对路径）。' },
        host: HOST_ARG,
      },
      required: ['project', 'remotePath', 'localDir'],
    },
    output: { schema: {}, render: JSON_RENDER },
    execute: wrap(async (args) => service.downloadFromProject(args)),
  })

  ctx.tools.register({
    name: 'remote_task',
    description:
      '在指定的云端项目目录里开一个任务（不需要上传任何东西，直接用该项目已有的文件）。' +
      '返回 jobId，之后用 remote_status / remote_result 取结果。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目名（即云端工作目录名）。' },
        task: { type: 'string', description: '让云端在这个项目里做什么。' },
        host: HOST_ARG,
      },
      required: ['project', 'task'],
    },
    output: { schema: {}, render: JSON_RENDER },
    execute: wrap(async (args) =>
      service.dispatch({ host: args.host, project: args.project, task: args.task }),
    ),
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
