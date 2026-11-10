/**
 * dsh-remote-dispatch — Web Client half.
 *
 * Two surfaces:
 *  1. A 推送 button in the composer tool row (`conversation.input.right`). It
 *     opens a panel holding the task text, device choice and an optional local
 *     folder, pushes to the cloud, and paints upload progress live from the
 *     Host's NDJSON stream.
 *  2. A 云端设备 section in Settings, where devices are bound to SSH
 *     credentials, probed, and made default.
 *
 * Loaded by the Harness module loader as `dsh-remote-dispatch`; React comes
 * from the browser module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-dispatch',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CHANNEL = '/remote-dispatch'

    const STYLES = String.raw`
.drd-root { position: relative; display: inline-flex; align-items: center; }
.drd-btn {
  display: inline-flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 10px 0 9px; border-radius: 8px;
  border: 1px solid #c7d7fe;
  background: #eef4ff;
  color: #1d4ed8;
  font-size: 12.5px; line-height: 1; cursor: pointer; font-weight: 500;
  transition: background .12s ease, border-color .12s ease, box-shadow .12s ease;
  white-space: nowrap; font-family: inherit; flex: none;
}
.drd-btn:hover { background: #e0ebff; border-color: #93b4fd; }
.drd-btnBusy { border-color: #3b82f6; color: #fff; background: #2563eb; }
.drd-btnBusy:hover { background: #1d4ed8; }
.drd-icon { display: inline-flex; align-items: center; }
.drd-btnDev { font-weight: 400; opacity: .8; max-width: 72px; overflow: hidden; text-overflow: ellipsis; }
.drd-dot { width: 6px; height: 6px; border-radius: 50%; background: #fff; animation: drd-pulse 1.1s ease-in-out infinite; flex: none; }
@keyframes drd-pulse { 0%,100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1.15); } }

.drd-panel {
  position: absolute; right: 0; bottom: calc(100% + 10px); z-index: 60;
  width: 372px; max-width: calc(100vw - 48px); padding: 13px; border-radius: 12px;
  background: var(--dsw-alias-bg-elevated, #fff);
  border: 1px solid var(--dsw-alias-line-regular, #e3e5e8);
  box-shadow: 0 12px 34px rgba(15, 23, 42, .16);
  color: var(--dsw-alias-label-primary, #1f2329);
  font-size: 12.5px; line-height: 18px; font-family: inherit;
  text-align: left;
}
.drd-panel *, .drd-panel *::before, .drd-panel *::after { box-sizing: border-box; }
.drd-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.drd-title { font-size: 13px; font-weight: 650; }
.drd-close { border: 0; background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary, #646a73); font-size: 15px; line-height: 1; padding: 2px 5px; border-radius: 6px; }
.drd-close:hover { background: var(--dsw-alias-bg-secondary, #f4f5f7); }
.drd-label { display: block; margin-bottom: 5px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 11.5px; }
.drd-input {
  width: 100%; height: 30px; padding: 0 9px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-line-regular, #d8dbe0);
  background: var(--dsw-alias-bg-primary, #fff);
  color: inherit; font-size: 12.5px; font-family: inherit; outline: none;
}
.drd-input:focus { border-color: #3b82f6; }
.drd-hint { color: var(--dsw-alias-label-secondary, #8a9099); font-size: 11px; margin-top: 4px; }

/* device chooser */
.drd-devices { display: flex; flex-direction: column; gap: 6px; max-height: 190px; overflow: auto; padding: 1px; }
.drd-device {
  display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 9px;
  border: 1px solid var(--dsw-alias-line-regular, #e3e5e8); cursor: pointer;
  background: var(--dsw-alias-bg-primary, #fff); transition: border-color .12s, background .12s;
  text-align: left; width: 100%; font-family: inherit; font-size: 12.5px; color: inherit;
}
.drd-device:hover:not(:disabled) { background: var(--dsw-alias-bg-secondary, #f7f8fa); }
.drd-deviceOn { border-color: #2563eb; background: #eff6ff; }
.drd-deviceMain { flex: 1; min-width: 0; }
.drd-deviceName { font-weight: 600; display: flex; align-items: center; gap: 5px; }
.drd-deviceAddr { color: var(--dsw-alias-label-secondary, #8a9099); font-size: 11px; font-family: ui-monospace, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drd-tag { font-size: 10px; padding: 0 5px; height: 15px; line-height: 15px; border-radius: 4px; background: #dbeafe; color: #1d4ed8; font-weight: 500; flex: none; }
.drd-tagBad { background: #fee2e2; color: #b91c1c; }
.drd-tagOk { background: #d1fae5; color: #047857; }
.drd-radio { width: 13px; height: 13px; border-radius: 50%; border: 1.5px solid #c7cdd6; flex: none; }
.drd-radioOn { border-color: #2563eb; border-width: 4px; }

.drd-draft { max-height: 52px; overflow: auto; padding: 6px 8px; border-radius: 8px; background: var(--dsw-alias-bg-secondary, #f4f5f7); color: var(--dsw-alias-label-secondary, #646a73); font-size: 11.5px; white-space: pre-wrap; word-break: break-word; }
.drd-textarea {
  width: 100%; padding: 7px 9px; border-radius: 8px; resize: vertical; min-height: 58px; max-height: 160px;
  border: 1px solid var(--dsw-alias-line-regular, #d8dbe0);
  background: var(--dsw-alias-bg-primary, #fff); color: inherit;
  font-size: 12.5px; line-height: 18px; font-family: inherit; outline: none; margin-bottom: 11px;
}
.drd-textarea:focus { border-color: #3b82f6; }
.drd-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.drd-primary, .drd-ghost {
  height: 30px; padding: 0 14px; border-radius: 8px; font-size: 12.5px; cursor: pointer; font-family: inherit; border: 1px solid transparent;
}
.drd-primary { background: #2563eb; color: #fff; }
.drd-primary:hover:not(:disabled) { background: #1d4ed8; }
.drd-primary:disabled { opacity: .55; cursor: not-allowed; }
.drd-ghost { background: transparent; border-color: var(--dsw-alias-line-regular, #d8dbe0); color: inherit; }
.drd-ghost:hover:not(:disabled) { background: var(--dsw-alias-bg-secondary, #f4f5f7); }
.drd-ghost:disabled { opacity: .5; cursor: not-allowed; }

.drd-progressWrap { margin-top: 11px; }
.drd-progressTop { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 5px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #646a73); }
.drd-progressTop span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drd-bar { height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-tertiary, #eceef1); overflow: hidden; }
.drd-barFill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #60a5fa, #2563eb); transition: width .18s ease; }
.drd-barFillErr { background: #ef4444; }
.drd-barFillOk { background: #10b981; }
.drd-steps { display: flex; gap: 4px; margin-top: 8px; }
.drd-step { flex: 1; height: 3px; border-radius: 999px; background: var(--dsw-alias-bg-tertiary, #eceef1); }
.drd-stepOn { background: #93c5fd; }
.drd-msg { margin-top: 9px; padding: 8px 10px; border-radius: 8px; font-size: 11.5px; line-height: 17px; word-break: break-all; }
.drd-msgOk { background: #ecfdf5; color: #047857; }
.drd-msgErr { background: #fef2f2; color: #b91c1c; }
.drd-job { font-family: ui-monospace, Consolas, monospace; font-weight: 650; margin: 3px 0; }
.drd-empty { padding: 14px 10px; text-align: center; color: var(--dsw-alias-label-secondary, #8a9099); font-size: 12px; border: 1px dashed var(--dsw-alias-line-regular, #d8dbe0); border-radius: 9px; }

/* Settings section */
.drd-page { width: 100%; max-width: 880px; padding: 8px 0 32px; color: var(--dsw-alias-label-primary, #1f2329); font-size: 13px; line-height: 20px; }
.drd-page *, .drd-page *::before, .drd-page *::after { box-sizing: border-box; }
.drd-pageHead h2 { margin: 0 0 4px; font-size: 17px; line-height: 24px; font-weight: 650; }
.drd-pageHead p { margin: 0 0 14px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12.5px; max-width: 620px; }
.drd-card { border: 1px solid var(--dsw-alias-line-regular, #e3e5e8); border-radius: 12px; padding: 13px 14px; margin-bottom: 12px; background: var(--dsw-alias-bg-primary, #fff); }
.drd-cardHead { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.drd-cardTitle { font-weight: 650; font-size: 13px; display: flex; align-items: center; gap: 7px; }
.drd-row { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 9px; border: 1px solid var(--dsw-alias-line-regular, #e3e5e8); margin-bottom: 8px; }
.drd-row:hover { background: var(--dsw-alias-bg-secondary, #fafbfc); }
.drd-rowMain { flex: 1; min-width: 0; }
.drd-rowName { font-weight: 600; display: flex; align-items: center; gap: 6px; }
.drd-rowMeta { color: var(--dsw-alias-label-secondary, #8a9099); font-size: 11.5px; font-family: ui-monospace, Consolas, monospace; margin-top: 2px; }
.drd-mini { height: 26px; padding: 0 10px; border-radius: 7px; font-size: 12px; cursor: pointer; border: 1px solid var(--dsw-alias-line-regular, #d8dbe0); background: transparent; color: inherit; font-family: inherit; flex: none; }
.drd-mini:hover:not(:disabled) { background: var(--dsw-alias-bg-secondary, #f4f5f7); }
.drd-mini:disabled { opacity: .5; cursor: not-allowed; }
.drd-miniDanger { color: #b91c1c; border-color: #fecaca; }
.drd-miniDanger:hover:not(:disabled) { background: #fef2f2; }
.drd-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.drd-formFull { grid-column: 1 / -1; }
.drd-select { width: 100%; height: 30px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-line-regular, #d8dbe0); background: var(--dsw-alias-bg-primary, #fff); color: inherit; font-size: 12.5px; font-family: inherit; outline: none; }
.drd-note { color: var(--dsw-alias-label-secondary, #646a73); font-size: 11.5px; margin-top: 8px; }
.drd-ok { color: #047857; }
.drd-bad { color: #b91c1c; }
.drd-pre { margin: 8px 0 0; padding: 9px 10px; border-radius: 8px; background: var(--dsw-alias-bg-secondary, #f7f8fa); border: 1px solid var(--dsw-alias-line-regular, #eceef1); max-height: 260px; overflow: auto; font-size: 11.5px; line-height: 17px; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, Consolas, monospace; color: var(--dsw-alias-label-primary, #1f2329); }
.drd-session { padding: 8px 10px; border-radius: 9px; background: var(--dsw-alias-bg-secondary, #f7f8fa); border: 1px solid var(--dsw-alias-line-regular, #eceef1); margin-bottom: 11px; }
.drd-sessionMain { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }
.drd-sessionPath { margin-top: 3px; color: var(--dsw-alias-label-secondary, #8a9099); font-size: 11px; font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
.drd-check { display: flex; align-items: center; gap: 7px; font-size: 12.5px; cursor: pointer; margin-top: 4px; }
.drd-check input { width: 14px; height: 14px; accent-color: #2563eb; cursor: pointer; }
`

    let styleInstalled = false
    function installStyles() {
      if (styleInstalled) return () => {}
      const tag = document.createElement('style')
      tag.id = 'dsh-remote-dispatch-styles'
      tag.textContent = STYLES
      document.head.appendChild(tag)
      styleInstalled = true
      return () => {
        tag.remove()
        styleInstalled = false
      }
    }

    function callRpc(endpoint, payload) {
      return fetch(`${CHANNEL}/${endpoint}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload === undefined ? {} : payload),
      }).then(async (response) => {
        let body = null
        try {
          body = await response.json()
        } catch {
          body = null
        }
        if (!response.ok) {
          const message = body && body.error && body.error.message ? body.error.message : `HTTP ${response.status}`
          throw new Error(message)
        }
        if (!body || body.ok !== true) {
          const error = body && body.error ? body.error : {}
          throw new Error(error.message || `请求 ${endpoint} 失败`)
        }
        return body.value
      })
    }

    /** POST and consume an NDJSON progress stream. */
    async function streamRpc(endpoint, payload, onLine) {
      const response = await fetch(`${CHANNEL}/${endpoint}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let at
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at).trim()
          buffer = buffer.slice(at + 1)
          if (line === '') continue
          try {
            onLine(JSON.parse(line))
          } catch {
            // ignore a malformed line
          }
        }
      }
      const tail = buffer.trim()
      if (tail !== '') {
        try {
          onLine(JSON.parse(tail))
        } catch {
          // ignore
        }
      }
    }

    const PHASES = [
      { key: 'packing', label: '打包' },
      { key: 'uploading', label: '上传' },
      { key: 'unpacking', label: '解包' },
      { key: 'submitting', label: '提交' },
      { key: 'downloading', label: '下载' },
    ]

    // ---------------------------------------------------------------- panel

/**
     * 「协同推送」控制条。
     *
     * 默认行为就是把当前会话整体搬到云端：整段对话以文字记录随任务下发，本会话
     * 所在的项目目录自动打包上传（不需要手填路径）。执行完成后可以一键把云端的
     * 工作目录拉回本地，形成往返同步。
     */
    function PushControl(props) {
      const [open, setOpen] = React.useState(false)
      const [devices, setDevices] = React.useState([])
      const [defaultDevice, setDefaultDevice] = React.useState('')
      const [selected, setSelected] = React.useState('')
      const [info, setInfo] = React.useState(null)
      const [infoError, setInfoError] = React.useState('')
      const [sessions, setSessions] = React.useState([])
      const [sessionId, setSessionId] = React.useState('')
      const [instruction, setInstruction] = React.useState('')
      const [syncFiles, setSyncFiles] = React.useState(true)
      const [project, setProject] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [percent, setPercent] = React.useState(0)
      const [phase, setPhase] = React.useState('')
      const [detail, setDetail] = React.useState('')
      const [error, setError] = React.useState('')
      const [job, setJob] = React.useState(null)
      const [pulling, setPulling] = React.useState(false)
      const [pullResult, setPullResult] = React.useState(null)
      const rootRef = React.useRef(null)

      // 打开时读取设备与本会话信息
      React.useEffect(() => {
        if (!open) return
        let alive = true
        // 两个请求互不拖累：会话信息失败也要能选设备，反之亦然。
        callRpc('hosts', {})
          .then((hostsValue) => {
            if (!alive) return
            const list = hostsValue.devices || []
            setDevices(list)
            setDefaultDevice(hostsValue.defaultHost || '')
            setSelected((cur) => cur || hostsValue.defaultHost || (list[0] && list[0].name) || '')
          })
          .catch((err) => {
            if (alive) setInfoError((prev) => prev || `设备读取失败：${err.message}`)
          })
        callRpc('sessions', { limit: 12 })
          .then((value) => {
            if (!alive) return
            const list = value.sessions || []
            setSessions(list)
            setSessionId((cur) => {
              if (cur) return cur
              // 优先用上次成功推送过的会话，其次用最新的一条
              let remembered = ''
              try {
                remembered = window.localStorage.getItem('drd.sessionId') || ''
              } catch {
                remembered = ''
              }
              if (remembered && list.some((item) => item.sessionId === remembered)) return remembered
              return (list[0] && list[0].sessionId) || ''
            })
          })
          .catch((err) => {
            if (alive) setInfoError((prev) => prev || `会话列表读取失败：${err.message}`)
          })
        return () => {
          alive = false
        }
      }, [open])

      // 选中哪个会话，就读哪个会话的轮次与文件
      React.useEffect(() => {
        if (!open || sessionId === '') return
        let alive = true
        setInfoError('')
        try {
          window.localStorage.setItem('drd.sessionId', sessionId)
        } catch {
          // 隐私模式下忽略
        }
        callRpc('sessionInfo', { sessionId })
          .then((infoValue) => {
            if (!alive) return
            setInfo(infoValue)
            setProject((cur) => cur || infoValue.project || '')
          })
          .catch((err) => {
            if (alive) setInfoError(err.message)
          })
        return () => {
          alive = false
        }
      }, [open, sessionId])

      React.useEffect(() => {
        if (!open) return
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        return () => document.removeEventListener('mousedown', onDown, true)
      }, [open])

      const start = async () => {
        if (busy) return
        if (selected === '') {
          setError('请先选择一个云端设备。')
          return
        }
        setBusy(true)
        setError('')
        setJob(null)
        setPullResult(null)
        setPercent(0)
        setPhase('packing')
        setDetail('准备推送整段对话')
        try {
          await streamRpc(
            'pushSession',
            {
              sessionId: sessionId || (info ? info.sessionId : undefined),
              instruction,
              host: selected,
              project: project || undefined,
              syncFiles,
            },
            (line) => {
              if (line.type === 'progress') {
                setPercent(typeof line.percent === 'number' ? line.percent : 0)
                setPhase(line.phase || '')
                setDetail(line.detail || '')
              } else if (line.type === 'done') {
                setPercent(100)
                setPhase('done')
                setDetail('已派发')
                setJob(line.result)
              } else if (line.type === 'error') {
                setError((line.error && line.error.message) || '派发失败')
                setPhase('error')
              }
            },
          )
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
          setPhase('error')
        } finally {
          setBusy(false)
        }
      }

      const doPull = async () => {
        if (pulling || !job) return
        setPulling(true)
        setError('')
        setPullResult(null)
        setPercent(0)
        setPhase('packing')
        setDetail('准备拉回')
        try {
          await streamRpc(
            'pull',
            { host: job.host || selected, project: job.project || project, localDir: job.localDir || (info && info.localDir) },
            (line) => {
              if (line.type === 'progress') {
                setPercent(typeof line.percent === 'number' ? line.percent : 0)
                setPhase(line.phase || '')
                setDetail(line.detail || '')
              } else if (line.type === 'done') {
                setPercent(100)
                setPhase('done')
                setDetail('已同步回本地')
                setPullResult(line.result)
              } else if (line.type === 'error') {
                setError((line.error && line.error.message) || '拉回失败')
                setPhase('error')
              }
            },
          )
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
          setPhase('error')
        } finally {
          setPulling(false)
        }
      }

      const phaseIndex = PHASES.findIndex((item) => item.key === phase)
      const active = busy || pulling
      const fillClass =
        phase === 'error' ? 'drd-barFill drd-barFillErr' : phase === 'done' ? 'drd-barFill drd-barFillOk' : 'drd-barFill'
      const selectedDevice = devices.find((d) => d.name === selected)
      const currentLabel = selectedDevice ? selectedDevice.label || selectedDevice.name : ''

      return h(
        'div',
        { className: 'drd-root', ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            className: active ? 'drd-btn drd-btnBusy' : 'drd-btn',
            title: '把对话记录写成文件 + 同步项目文件，推到云端执行（本地断网也不影响）',
            onClick: () => setOpen((v) => !v),
          },
          active
            ? h('span', { className: 'drd-dot' })
            : h('span', { className: 'drd-icon', 'aria-hidden': 'true' },
                h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none' },
                  h('path', {
                    d: 'M8 2v8m0-8L4.5 5.5M8 2l3.5 3.5M3 11v1.5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V11',
                    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
                  }))),
          active ? `${percent}%` : '推送',
          h('span', { className: 'drd-btnDev' }, currentLabel || '云端'),
        ),

        open
          ? h(
              'div',
              { className: 'drd-panel' },
              h(
                'div',
                { className: 'drd-head' },
                h('span', { className: 'drd-title' }, '推送到云端'),
                h('button', { type: 'button', className: 'drd-close', onClick: () => setOpen(false), title: '关闭' }, '×'),
              ),

              // 选择要搬运的会话（插件无法得知你正在看哪个，必须由你确认）
              h(
                'div',
                { style: { marginBottom: '9px' } },
                h('span', { className: 'drd-label' }, '要搬运的会话'),
                h(
                  'select',
                  {
                    className: 'drd-select',
                    value: sessionId,
                    onChange: (e) => setSessionId(e.target.value),
                    disabled: active,
                  },
                  sessions.length === 0
                    ? h('option', { value: '' }, '读取中…')
                    : sessions.map((item) =>
                        h(
                          'option',
                          { key: item.sessionId, value: item.sessionId },
                          `${item.project || '（无目录）'} · ${item.turns ?? 0} 轮 · ${item.fileCount ?? 0} 文件 · ${new Date(item.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
                        ),
                      ),
                ),
                h('div', { className: 'drd-hint' }, '默认选最新的一条；如果不是你正在看的那个，在这里改'),
              ),

              // 会话概况
              h(
                'div',
                { className: 'drd-session' },
                info
                  ? h(
                      'div',
                      null,
                      h('div', { className: 'drd-sessionMain' },
                        h('span', { className: 'drd-tag drd-tagOk' }, '本会话'),
                        h('span', null, `${info.turns} 轮对话 · ${(info.transcriptChars / 1000).toFixed(1)}k 字`),
                        h('span', { className: 'drd-tag' }, `${info.fileCount ?? 0} 个文件`),
                        info.truncated ? h('span', { className: 'drd-tag' }, '已截断') : null,
                      ),
                      h('div', { className: 'drd-sessionPath' }, info.localDir || '（未识别到项目目录）'),
                    )
                  : h('div', { className: 'drd-hint' }, infoError ? `读取会话失败：${infoError}` : '读取会话中…'),
              ),

              // 设备
              h(
                'div',
                { style: { marginBottom: '11px' } },
                h('span', { className: 'drd-label' }, '目标设备'),
                devices.length === 0
                  ? h('div', { className: 'drd-empty' }, '还没有绑定设备。到 设置 → 云端派发 用 SSH 关联一台服务器。')
                  : h(
                      'div',
                      { className: 'drd-devices' },
                      devices.map((device) =>
                        h(
                          'button',
                          {
                            key: device.name,
                            type: 'button',
                            className: device.name === selected ? 'drd-device drd-deviceOn' : 'drd-device',
                            onClick: () => setSelected(device.name),
                            disabled: active,
                          },
                          h('span', { className: device.name === selected ? 'drd-radio drd-radioOn' : 'drd-radio' }),
                          h(
                            'span',
                            { className: 'drd-deviceMain' },
                            h(
                              'span',
                              { className: 'drd-deviceName' },
                              device.label || device.name,
                              device.name === defaultDevice ? h('span', { className: 'drd-tag' }, '默认') : null,
                            ),
                            h(
                              'span',
                              { className: 'drd-deviceAddr' },
                              device.ssh && device.ssh.host
                                ? `${device.ssh.username}@${device.ssh.host}:${device.ssh.port}`
                                : device.credentialId,
                            ),
                          ),
                        ),
                      ),
                    ),
              ),

              // 项目名
              h(
                'div',
                { style: { marginBottom: '9px' } },
                h('span', { className: 'drd-label' }, '云端项目名（工作目录）'),
                h('input', {
                  className: 'drd-input',
                  value: project,
                  placeholder: '默认用本地目录名',
                  onChange: (e) => setProject(e.target.value),
                  disabled: active,
                }),
              ),

              // 同步项目文件开关
              h(
                'label',
                { className: 'drd-check' },
                h('input', {
                  type: 'checkbox',
                  checked: syncFiles,
                  onChange: (e) => setSyncFiles(e.target.checked),
                  disabled: active,
                }),
                h('span', null, info ? `同步本会话涉及的 ${info.fileCount ?? 0} 个文件（供云端参考）` : '同步本会话涉及的文件（供云端参考）'),
                h('span', { className: 'drd-hint', style: { marginTop: 0 } }, '（只传这次对话真正碰过的文件，保持相对路径）'),
              ),

              // 追加指令
              h('span', { className: 'drd-label', style: { marginTop: '10px' } }, '希望云端接着做什么（可选）'),
              h('textarea', {
                className: 'drd-textarea',
                value: instruction,
                placeholder: '留空则让云端继续完成最后一件未完成的事',
                onChange: (e) => setInstruction(e.target.value),
                disabled: active,
                rows: 2,
              }),

              busy || pulling || phase === 'done' || phase === 'error'
                ? h(
                    'div',
                    { className: 'drd-progressWrap' },
                    h('div', { className: 'drd-progressTop' }, h('span', null, detail || '处理中'), h('span', null, `${percent}%`)),
                    h('div', { className: 'drd-bar' }, h('div', { className: fillClass, style: { width: `${Math.max(2, percent)}%` } })),
                    h(
                      'div',
                      { className: 'drd-steps' },
                      PHASES.map((item, index) =>
                        h('div', { key: item.key, className: index <= phaseIndex ? 'drd-step drd-stepOn' : 'drd-step', title: item.label }),
                      ),
                    ),
                  )
                : null,

              job
                ? h(
                    'div',
                    { className: 'drd-msg drd-msgOk' },
                    h('div', null, '已推送到云端，本地可断网／关机。'),
                    h('div', { className: 'drd-job' }, job.jobId),
                    h('div', null, `${job.host} · ${job.remoteRoot || ''}`),
                    h('div', null, `对话记录存为 CONVERSATION.md（${job.turns} 轮），提示词仅 ${job.promptChars || 0} 字`),
                    h('div', null, job.filesSynced ? `已同步本会话涉及的 ${job.fileCount ?? 0} 个文件，云端会先读记录再动手` : '本次未同步文件'),
                    h(
                      'div',
                      { className: 'drd-banner' },
                      h('span', null, '任务跑完后可把云端改动拉回本地：'),
                      h('button', { type: 'button', className: 'drd-mini', onClick: doPull, disabled: pulling }, pulling ? '同步中…' : '拉回本地'),
                    ),
                  )
                : null,

              pullResult
                ? h(
                    'div',
                    { className: 'drd-msg drd-msgOk' },
                    h('div', null, '已同步回本地。'),
                    h('div', null, pullResult.localDir),
                    h('div', { className: 'drd-hint' }, `覆盖前备份：${pullResult.backup}`),
                  )
                : null,

              error ? h('div', { className: 'drd-msg drd-msgErr' }, error) : null,

              h(
                'div',
                { className: 'drd-actions' },
                h('button', { type: 'button', className: 'drd-ghost', onClick: () => setOpen(false), disabled: active }, '关闭'),
                h(
                  'button',
                  { type: 'button', className: 'drd-primary', onClick: start, disabled: active || selected === '' },
                  busy ? '推送中…' : selected === '' ? '请选择设备' : '推送整段对话',
                ),
              ),
            )
          : null,
      )
    }

    // ------------------------------------------------------------- settings

    /**
     * Pushed-job history for one device. This is the reliable place to watch
     * what you pushed: cloud-side jobs run detached in their own working
     * directory, so the cloud Web UI does not list them unless that directory is
     * registered as a workspace there.
     */
    function JobsPanel(props) {
      const devices = props.devices || []
      const [host, setHost] = React.useState('')
      const [jobs, setJobs] = React.useState([])
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState('')
      const [openJob, setOpenJob] = React.useState(null)
      const [openText, setOpenText] = React.useState('')
      const [openBusy, setOpenBusy] = React.useState(false)

      React.useEffect(() => {
        if (host === '' && devices.length > 0) setHost(devices[0].name)
      }, [devices, host])

      const load = React.useCallback(async () => {
        if (host === '') return
        setLoading(true)
        setError('')
        try {
          const value = await callRpc('list', { host })
          setJobs(value.jobs || [])
        } catch (err) {
          setError(err.message)
          setJobs([])
        } finally {
          setLoading(false)
        }
      }, [host])

      React.useEffect(() => {
        load()
      }, [load])

      const openResult = async (jobId) => {
        setOpenJob(jobId)
        setOpenBusy(true)
        setOpenText('')
        try {
          const value = await callRpc('result', { jobId, host })
          setOpenText(value.text)
        } catch (err) {
          setOpenText(`（读取失败）${err.message}`)
        } finally {
          setOpenBusy(false)
        }
      }

      const badgeClass = (state) =>
        state === 'done' ? 'drd-tag drd-tagOk' : state === 'failed' ? 'drd-tag drd-tagBad' : 'drd-tag'

      return h(
        'div',
        { className: 'drd-card' },
        h(
          'div',
          { className: 'drd-cardHead' },
          h('span', { className: 'drd-cardTitle' }, `推送的任务（${jobs.length}）`),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h(
              'select',
              { className: 'drd-select', style: { width: '150px' }, value: host, onChange: (e) => setHost(e.target.value) },
              devices.length === 0
                ? h('option', { value: '' }, '（无设备）')
                : devices.map((d) => h('option', { key: d.name, value: d.name }, d.label || d.name)),
            ),
            h('button', { type: 'button', className: 'drd-mini', onClick: load, disabled: loading || host === '' }, loading ? '读取中…' : '刷新'),
          ),
        ),

        error ? h('div', { className: 'drd-msg drd-msgErr' }, error) : null,

        devices.length === 0
          ? h('div', { className: 'drd-empty' }, '先在上面绑定一台设备。')
          : jobs.length === 0
            ? h('div', { className: 'drd-empty' }, loading ? '读取中…' : '这台设备上还没有推送任务。')
            : jobs.map((job) =>
                h(
                  'div',
                  { key: job.jobId, style: { borderBottom: '1px solid var(--dsw-alias-line-regular, #eceef1)', paddingBottom: '8px' } },
                  h(
                    'div',
                    { className: 'drd-row', style: { marginBottom: '0' } },
                    h(
                      'div',
                      { className: 'drd-rowMain' },
                      h(
                        'div',
                        { className: 'drd-rowName' },
                        job.jobId,
                        h('span', { className: badgeClass(job.state) }, job.state),
                      ),
                      h('div', { className: 'drd-rowMeta' }, job.submittedAt || ''),
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'drd-mini', onClick: () => openResult(job.jobId), disabled: openBusy && openJob === job.jobId },
                      openJob === job.jobId ? '收起' : '结果',
                    ),
                  ),
                  openJob === job.jobId
                    ? h('pre', { className: 'drd-pre' }, openBusy ? '读取中…' : openText || '（无内容）')
                    : null,
                ),
              ),
      )
    }

    function DevicesSection() {
      const [state, setState] = React.useState({ loading: true, devices: [], defaultDevice: '', credentials: [], maxUploadMb: 0 })
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [probes, setProbes] = React.useState({})
      const [form, setForm] = React.useState({ name: '', label: '', credentialId: '', workRoot: '', note: '', editing: false })

      const refresh = React.useCallback(async () => {
        setError('')
        try {
          const [hostsValue, credValue] = await Promise.all([callRpc('hosts', {}), callRpc('credentials', {})])
          setState({
            loading: false,
            devices: hostsValue.devices || [],
            defaultDevice: hostsValue.defaultDevice || '',
            credentials: credValue.credentials || [],
            maxUploadMb: hostsValue.maxUploadMb || 0,
          })
        } catch (err) {
          setState((prev) => ({ ...prev, loading: false }))
          setError(err.message)
        }
      }, [])

      React.useEffect(() => {
        refresh()
      }, [refresh])

      const act = async (fn, okText) => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          await fn()
          if (okText) setNotice(okText)
          await refresh()
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }

      const doProbe = async (name) => {
        setProbes((prev) => ({ ...prev, [name]: { testing: true } }))
        try {
          const value = await callRpc('probe', { host: name })
          const row = value.hosts && value.hosts[0]
          setProbes((prev) => ({ ...prev, [name]: row || { reachable: false, error: '无响应' } }))
        } catch (err) {
          setProbes((prev) => ({ ...prev, [name]: { reachable: false, error: err.message } }))
        }
      }

      const bind = () => {
        if (form.credentialId === '') {
          setError('请选择一个 SSH 凭据作为设备。若还没有，请先到「凭据管家」新建一台 SSH 服务器。')
          return
        }
        act(
          () =>
            callRpc('saveDevice', {
              name: form.name || form.label,
              label: form.label,
              credentialId: form.credentialId,
              workRoot: form.workRoot,
              note: form.note,
            }),
          '设备已绑定',
        ).then(() => setForm({ name: '', label: '', credentialId: '', workRoot: '', note: '', editing: false }))
      }

      const credentialOptions = state.credentials.map((cred) =>
        h('option', { key: cred.id, value: cred.id }, `${cred.name} — ${cred.username}@${cred.host}:${cred.port}（${cred.authMethod === 'key' ? '私钥' : '密码'}）`),
      )

      return h(
        'div',
        { className: 'drd-page' },
        h(
          'div',
          { className: 'drd-pageHead' },
          h('h2', null, '云端设备'),
          h('p', null, '用 SSH 关联一台云服务器作为「设备」。派发任务时选择设备即可；电脑断网或关机，云端照常执行。密码与私钥仍由「凭据管家」保管，这里只记录绑定关系。'),
        ),

        notice ? h('div', { className: 'drd-msg drd-msgOk', style: { marginBottom: '10px' } }, notice) : null,
        error ? h('div', { className: 'drd-msg drd-msgErr', style: { marginBottom: '10px' } }, error) : null,

        h(
          'div',
          { className: 'drd-card' },
          h(
            'div',
            { className: 'drd-cardHead' },
            h('span', { className: 'drd-cardTitle' }, `已绑定设备（${state.devices.length}）`),
            h('button', { type: 'button', className: 'drd-mini', onClick: refresh, disabled: busy }, '刷新'),
          ),
          state.loading
            ? h('div', { className: 'drd-empty' }, '加载中…')
            : state.devices.length === 0
              ? h('div', { className: 'drd-empty' }, '还没有绑定设备，用下面的表单关联一台服务器。')
              : state.devices.map((device) => {
                  const probe = probes[device.name]
                  const addr = device.ssh && device.ssh.host ? `${device.ssh.username}@${device.ssh.host}:${device.ssh.port}` : device.credentialId
                  return h(
                    'div',
                    { key: device.name, className: 'drd-row' },
                    h(
                      'div',
                      { className: 'drd-rowMain' },
                      h(
                        'div',
                        { className: 'drd-rowName' },
                        device.label || device.name,
                        device.name === state.defaultDevice ? h('span', { className: 'drd-tag' }, '默认') : null,
                        probe && probe.testing ? h('span', { className: 'drd-tag' }, '检测中') : null,
                        probe && !probe.testing
                          ? probe.reachable && probe.ready
                            ? h('span', { className: 'drd-tag drd-tagOk' }, '就绪')
                            : h('span', { className: 'drd-tag drd-tagBad' }, probe.reachable ? '缺运行时' : '不可达')
                          : null,
                      ),
                      h('div', { className: 'drd-rowMeta' }, `${device.name} · ${addr}`),
                      probe && !probe.testing && !probe.reachable && probe.error
                        ? h('div', { className: 'drd-rowMeta drd-bad' }, probe.error)
                        : null,
                    ),
                    h('button', { type: 'button', className: 'drd-mini', onClick: () => doProbe(device.name), disabled: busy || !!probe?.testing }, '检测'),
                    device.name === state.defaultDevice
                      ? null
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'drd-mini',
                            onClick: () => act(() => callRpc('setDefaultDevice', { name: device.name }), '已设为默认设备'),
                            disabled: busy,
                          },
                          '设为默认',
                        ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'drd-mini drd-miniDanger',
                        onClick: () => act(() => callRpc('removeDevice', { name: device.name }), '已解绑（凭据未删除）'),
                        disabled: busy,
                      },
                      '解绑',
                    ),
                  )
                }),
        ),

        h(
          'div',
          { className: 'drd-card' },
          h('div', { className: 'drd-cardHead' }, h('span', { className: 'drd-cardTitle' }, '用 SSH 关联新设备')),
          h(
            'div',
            { className: 'drd-form' },
            h(
              'div',
              { className: 'drd-formFull' },
              h('span', { className: 'drd-label' }, 'SSH 凭据（来自凭据管家）'),
              h(
                'select',
                {
                  className: 'drd-select',
                  value: form.credentialId,
                  onChange: (e) => setForm((f) => ({ ...f, credentialId: e.target.value })),
                  disabled: busy,
                },
                h('option', { value: '' }, state.credentials.length === 0 ? '（凭据管家里还没有 SSH 凭据）' : '请选择…'),
                credentialOptions,
              ),
            ),
            h(
              'div',
              null,
              h('span', { className: 'drd-label' }, '显示名'),
              h('input', {
                className: 'drd-input',
                value: form.label,
                placeholder: '阿里云 2H2C',
                onChange: (e) => setForm((f) => ({ ...f, label: e.target.value, name: f.editing ? f.name : '' })),
                disabled: busy,
              }),
            ),
            h(
              'div',
              null,
              h('span', { className: 'drd-label' }, '设备名（可选）'),
              h('input', {
                className: 'drd-input',
                value: form.name,
                placeholder: '留空则用显示名',
                onChange: (e) => setForm((f) => ({ ...f, name: e.target.value })),
                disabled: busy,
              }),
            ),
            h(
              'div',
              { className: 'drd-formFull' },
              h('span', { className: 'drd-label' }, '备注（可选）'),
              h('input', {
                className: 'drd-input',
                value: form.note,
                placeholder: '这台机器用来做什么',
                onChange: (e) => setForm((f) => ({ ...f, note: e.target.value })),
                disabled: busy,
              }),
            ),
          ),
          h(
            'div',
            { className: 'drd-actions', style: { justifyContent: 'space-between', alignItems: 'center' } },
            h('div', { className: 'drd-note' }, state.maxUploadMb ? `单次上传上限 ${state.maxUploadMb}MB` : ''),
            h('button', { type: 'button', className: 'drd-primary', onClick: bind, disabled: busy }, '绑定设备'),
          ),
        ),

        h(JobsPanel, { devices: state.devices }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => installStyles(), 'remote-dispatch: install styles')
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'remote-dispatch-push',
          order: 60,
        }, PushControl))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'remote-dispatch',
          order: 35,
          label: '云端派发',
        }, DevicesSection))
      },
    }
  },
})
