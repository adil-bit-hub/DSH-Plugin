/**
 * dsh-remote-dispatch — Host half.
 *
 * Lets this harness push work to a cloud DSH and walk away. The cloud runs
 * `dsh headless` detached from the SSH session, so a local network drop or a
 * laptop going to sleep cannot interrupt the job; you reconnect later and read
 * the answer.
 *
 * Registered tools: remote_hosts, remote_dispatch, remote_status, remote_result,
 * remote_wait, remote_logs, remote_list, remote_cancel.
 *
 * @module dsh-remote-dispatch
 */
import { registerTools } from './src/tools.js'
import { registerRpc } from './src/rpc.js'
import { DeviceRegistry } from './src/devices.js'
import { RemoteDispatchService } from './src/service.js'

/** Registered plugin name. */
export const name = 'remote-dispatch'

/** Services this plugin needs from the Host composition. */
export const inject = ['tools', 'systemPrompt']

/**
 * Normalize user config without a Schemastery dependency.
 * @param {object|undefined} config - the row config from cordis.patch.yml.
 * @returns {object} resolved settings.
 */
function resolveSettings(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const number = (value, fallback) => (Number.isFinite(value) ? value : fallback)

  const hosts = {}
  if (source.hosts && typeof source.hosts === 'object') {
    for (const [key, value] of Object.entries(source.hosts)) {
      if (!value || typeof value !== 'object') continue
      const id = typeof value.credentialId === 'string' ? value.credentialId.trim() : ''
      if (!id) continue
      hosts[key] = {
        credentialId: id,
        label: typeof value.label === 'string' ? value.label : key,
      }
    }
  }

  const defaultHost =
    typeof source.defaultHost === 'string' && source.defaultHost.trim() !== ''
      ? source.defaultHost.trim()
      : (Object.keys(hosts)[0] ?? '')

  return {
    defaultHost,
    hosts,
    promptSummary: source.promptSummary !== false,
    commandTimeoutMs: Math.max(10_000, Math.min(600_000, number(source.commandTimeoutMs, 120_000))),
    waitTimeoutMs: Math.max(30_000, Math.min(21_600_000, number(source.waitTimeoutMs, 3_600_000))),
    maxUploadMb: Math.max(1, Math.min(2048, number(source.maxUploadMb, 200))),
  }
}

/**
 * Mount the plugin: agent tools plus an optional system-prompt section.
 * @param {object} ctx - plugin context.
 * @param {object} [config] - bundle row config.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  if (Object.keys(settings.hosts).length === 0) {
    ctx.logger?.warn?.('remote-dispatch: 没有配置任何 hosts，工具将不可用')
  }

  const registry = new DeviceRegistry(ctx, settings)
  const service = new RemoteDispatchService(ctx, settings, registry)

  // Tools are the primary surface; headless and tui profiles get them too.
  ctx.inject(['tools'], () => {
    registerTools(ctx, service, settings)
  })

  // The composer push button needs a web server + connection; headless
  // profiles simply do not get it.
  ctx.inject(['connection', 'webServer'], (web) => {
    registerRpc(web, service, settings)
  })

  // Nudge the model toward offloading when the user mentions leaving/network.
  // Guarded: a composition without systemPrompt must still get the tools.
  if (settings.promptSummary) {
    try {
      ctx.inject(['systemPrompt'], (sp) => {
        sp.systemPrompt.section({
          name: 'remote-dispatch',
          order: 61,
          text: () => {
            const names = Object.keys(settings.hosts)
            if (names.length === 0) return ''
            const list = names
              .map((n) => `${n}${settings.hosts[n].label ? `(${settings.hosts[n].label})` : ''}`)
              .join('、')
            return (
              `云端派发工具（remote-dispatch）可用，云主机：${list}；默认 ${settings.defaultHost}。\n` +
              '当任务预计很长（数十分钟以上）、用户提到即将断网/关机/离开、或希望任务"挂机跑完"时，' +
              '优先用 remote_dispatch 把它推到云端（返回 jobId 后即可结束本地会话），不要本地死等。' +
              '之后用 remote_status 查进度、remote_result 取结果；续跑上下文用 continueSession。'
            )
          },
        })
      })
    } catch (error) {
      ctx.logger?.warn?.(`remote-dispatch: systemPrompt 段注册失败：${error?.message ?? error}`)
    }
  }

  // 停用/卸载插件时把控制台隧道一起收掉，避免留下 ssh 进程
  ctx.effect(() => () => {
    try {
      service.disposeTunnels()
    } catch {
      // 清理失败不影响卸载
    }
  }, 'remote-dispatch: close console tunnels')

  ctx.logger?.info?.(`remote-dispatch: ready (${Object.keys(settings.hosts).length} host(s))`)
}
