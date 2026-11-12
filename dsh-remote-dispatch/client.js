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
     * 输入框旁的「云端」按钮。
     *
     * 像在本地一样操作云端：选设备 → 选/建项目 → 写任务 → 发送。
     * 任务在云端项目目录里执行，不需要上传任何东西（需要文件时去设置页传）。
     */
    function PushControl(props) {
      const [open, setOpen] = React.useState(false)
      const [devices, setDevices] = React.useState([])
      const [defaultDevice, setDefaultDevice] = React.useState('')
      const [device, setDevice] = React.useState('')
      const [projects, setProjects] = React.useState([])
      const [project, setProject] = React.useState('')
      const [newProject, setNewProject] = React.useState('')
      const [creating, setCreating] = React.useState(false)
      const [task, setTask] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [error, setError] = React.useState('')
      const [job, setJob] = React.useState(null)
      const rootRef = React.useRef(null)
      const taskRef = React.useRef(null)

      // 打开时读设备
      React.useEffect(() => {
        if (!open) return
        let alive = true
        callRpc('hosts', {})
          .then((value) => {
            if (!alive) return
            const list = value.devices || []
            setDevices(list)
            setDefaultDevice(value.defaultHost || '')
            setDevice((cur) => cur || value.defaultHost || (list[0] && list[0].name) || '')
          })
          .catch((err) => alive && setError(`设备读取失败：${err.message}`))
        return () => {
          alive = false
        }
      }, [open])

      // 设备变化时读项目
      const loadProjects = React.useCallback(async (hostName) => {
        if (!hostName) return
        try {
          const value = await callRpc('projects', { host: hostName })
          const list = value.projects || []
          setProjects(list)
          setProject((cur) => (cur && list.some((p) => p.name === cur) ? cur : (list[0] && list[0].name) || ''))
        } catch (err) {
          setError(`项目读取失败：${err.message}`)
        }
      }, [])

      React.useEffect(() => {
        if (!open || !device) return
        loadProjects(device)
      }, [open, device, loadProjects])

      React.useEffect(() => {
        if (!open) return
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        return () => document.removeEventListener('mousedown', onDown, true)
      }, [open])

      const doCreateProject = async () => {
        const name = newProject.trim()
        if (name === '') return
        setCreating(true)
        setError('')
        try {
          const value = await callRpc('createProject', { host: device, name })
          setNewProject('')
          await loadProjects(device)
          setProject(value.name)
          setNotice(`已创建项目 ${value.name}`)
        } catch (err) {
          setError(err.message)
        } finally {
          setCreating(false)
        }
      }

      const send = async () => {
        if (busy) return
        if (task.trim() === '') {
          setError('请先填写任务内容。')
          taskRef.current?.focus()
          return
        }
        if (project === '') {
          setError('请先选择或创建项目。')
          return
        }
        setBusy(true)
        setError('')
        setNotice('')
        setJob(null)
        try {
          const value = await callRpc('push', { host: device, project, task })
          setJob(value)
          setTask('')
          setNotice('已在云端项目里开始执行')
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }

      const selectedDevice = devices.find((d) => d.name === device)
      const label = selectedDevice ? selectedDevice.label || selectedDevice.name : ''

      return h(
        'div',
        { className: 'drd-root', ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            className: busy ? 'drd-btn drd-btnBusy' : 'drd-btn',
            title: '在云端项目里开任务（不需要上传文件，直接跑）',
            onClick: () => setOpen((v) => !v),
          },
          busy
            ? h('span', { className: 'drd-dot' })
            : h('span', { className: 'drd-icon', 'aria-hidden': 'true' },
                h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none' },
                  h('path', {
                    d: 'M8 2v8m0-8L4.5 5.5M8 2l3.5 3.5M3 11v1.5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V11',
                    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
                  }))),
          busy ? '发送中' : '云端任务',
          label ? h('span', { className: 'drd-btnDev' }, label) : null,
        ),

        open
          ? h(
              'div',
              { className: 'drd-panel' },
              h(
                'div',
                { className: 'drd-head' },
                h('span', { className: 'drd-title' }, '在云端跑任务'),
                h('button', { type: 'button', className: 'drd-close', onClick: () => setOpen(false), title: '关闭' }, '×'),
              ),

              // 设备
              h(
                'div',
                { style: { marginBottom: '9px' } },
                h('span', { className: 'drd-label' }, '云端设备'),
                devices.length === 0
                  ? h('div', { className: 'drd-empty' }, '还没有绑定设备。到 设置 → 云端派发 用 SSH 关联一台服务器。')
                  : h(
                      'div',
                      { className: 'drd-devices' },
                      devices.map((d) =>
                        h(
                          'button',
                          {
                            key: d.name,
                            type: 'button',
                            className: d.name === device ? 'drd-device drd-deviceOn' : 'drd-device',
                            onClick: () => setDevice(d.name),
                            disabled: busy,
                          },
                          h('span', { className: d.name === device ? 'drd-radio drd-radioOn' : 'drd-radio' }),
                          h(
                            'span',
                            { className: 'drd-deviceMain' },
                            h('span', { className: 'drd-deviceName' },
                              d.label || d.name,
                              d.name === defaultDevice ? h('span', { className: 'drd-tag' }, '默认') : null),
                            h('span', { className: 'drd-deviceAddr' },
                              d.ssh && d.ssh.host ? `${d.ssh.username}@${d.ssh.host}:${d.ssh.port}` : d.credentialId),
                          ),
                        ),
                      ),
                    ),
              ),

              // 项目
              h(
                'div',
                { style: { marginBottom: '9px' } },
                h('span', { className: 'drd-label' }, '项目（云端工作目录）'),
                h(
                  'select',
                  { className: 'drd-select', value: project, onChange: (e) => setProject(e.target.value), disabled: busy },
                  projects.length === 0
                    ? h('option', { value: '' }, '（还没有项目，先建一个）')
                    : projects.map((p) =>
                        h('option', { key: p.name, value: p.name }, `${p.name} · ${p.files} 文件`)),
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
                  h('input', {
                    className: 'drd-input',
                    value: newProject,
                    placeholder: '新建项目名，例如 blog',
                    onChange: (e) => setNewProject(e.target.value),
                    onKeyDown: (e) => { if (e.key === 'Enter') doCreateProject() },
                    disabled: busy || creating,
                  }),
                  h('button', {
                    type: 'button', className: 'drd-mini',
                    onClick: doCreateProject,
                    disabled: busy || creating || newProject.trim() === '',
                  }, creating ? '创建中' : '新建'),
                ),
              ),

              // 任务
              h('span', { className: 'drd-label' }, '任务内容'),
              h('textarea', {
                ref: taskRef,
                className: 'drd-textarea',
                value: task,
                placeholder: '例如：读一下项目里的 README，补一份安装说明',
                onChange: (e) => setTask(e.target.value),
                disabled: busy,
                rows: 3,
              }),

              notice ? h('div', { className: 'drd-msg drd-msgOk' }, notice) : null,
              job
                ? h(
                    'div',
                    { className: 'drd-msg drd-msgOk' },
                    h('div', null, '任务已提交，本地断网也不影响。'),
                    h('div', { className: 'drd-job' }, job.jobId),
                    h('div', null, `${job.host} · ${job.remoteRoot}`),
                  )
                : null,
              error ? h('div', { className: 'drd-msg drd-msgErr' }, error) : null,

              h(
                'div',
                { className: 'drd-actions' },
                h('button', { type: 'button', className: 'drd-ghost', onClick: () => setOpen(false), disabled: busy }, '关闭'),
                h(
                  'button',
                  { type: 'button', className: 'drd-primary', onClick: send, disabled: busy || project === '' },
                  busy ? '提交中…' : '在云端执行',
                ),
              ),
            )
          : null,
      )
    }


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

/**
     * 云端项目管理：像本地一样建项目、看文件、传文件、跑任务、取结果。
     */
    function ProjectsPanel(props) {
      const devices = props.devices || []
      const [device, setDevice] = React.useState('')
      const [projects, setProjects] = React.useState([])
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [newName, setNewName] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      // 当前打开的项目
      const [current, setCurrent] = React.useState(null)
      const [files, setFiles] = React.useState([])
      const [tasks, setTasks] = React.useState([])
      const [detailLoading, setDetailLoading] = React.useState(false)

      // 上传 / 新任务
      const [uploadPath, setUploadPath] = React.useState('')
      const [uploadSubdir, setUploadSubdir] = React.useState('')
      const [uploading, setUploading] = React.useState(false)
      const [uploadPct, setUploadPct] = React.useState(0)
      const [taskText, setTaskText] = React.useState('')
      const [starting, setStarting] = React.useState(false)
      const [taskResult, setTaskResult] = React.useState(null)
      const [localDir, setLocalDir] = React.useState('')

      React.useEffect(() => {
        if (device === '' && devices.length > 0) setDevice(devices[0].name)
      }, [devices, device])

      const load = React.useCallback(async () => {
        if (device === '') return
        setLoading(true)
        setError('')
        try {
          const value = await callRpc('projects', { host: device })
          setProjects(value.projects || [])
        } catch (err) {
          setError(err.message)
          setProjects([])
        } finally {
          setLoading(false)
        }
      }, [device])

      React.useEffect(() => {
        setCurrent(null)
        load()
      }, [load])

      const openProject = async (name) => {
        setCurrent(name)
        setDetailLoading(true)
        setError('')
        setTaskResult(null)
        try {
          const [f, t] = await Promise.all([
            callRpc('projectFiles', { host: device, project: name }),
            callRpc('projectTasks', { host: device, project: name }),
          ])
          setFiles(f.files || [])
          setTasks(t.tasks || [])
        } catch (err) {
          setError(err.message)
          setFiles([])
          setTasks([])
        } finally {
          setDetailLoading(false)
        }
      }

      const createProject = async () => {
        const name = newName.trim()
        if (name === '') return
        setBusy(true)
        setError('')
        try {
          await callRpc('createProject', { host: device, name })
          setNewName('')
          setNotice(`已创建项目 ${name}`)
          await load()
          await openProject(name)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }

      const removeProject = async (name) => {
        if (!window.confirm(`确定删除云端项目 ${name}？该目录下的文件会一起删除。`)) return
        setBusy(true)
        setError('')
        try {
          await callRpc('removeProject', { host: device, name, confirm: true })
          setNotice(`已删除项目 ${name}`)
          if (current === name) setCurrent(null)
          await load()
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }

      const doUpload = async () => {
        if (current === null || uploadPath.trim() === '') return
        setUploading(true)
        setError('')
        setNotice('')
        setUploadPct(0)
        try {
          await streamRpc(
            'uploadToProject',
            { host: device, project: current, localPath: uploadPath.trim(), subdir: uploadSubdir.trim() },
            (line) => {
              if (line.type === 'progress') setUploadPct(line.percent || 0)
              else if (line.type === 'done') {
                setUploadPct(100)
                setNotice(`已上传到 ${line.result.remoteDir}`)
                setUploadPath('')
              } else if (line.type === 'error') {
                setError((line.error && line.error.message) || '上传失败')
              }
            },
          )
          await openProject(current)
          await load()
        } catch (err) {
          setError(err.message)
        } finally {
          setUploading(false)
        }
      }

      const startTask = async () => {
        if (current === null || taskText.trim() === '') return
        setStarting(true)
        setError('')
        setTaskResult(null)
        try {
          const value = await callRpc('push', { host: device, project: current, task: taskText.trim() })
          setTaskResult(value)
          setTaskText('')
          await openProject(current)
        } catch (err) {
          setError(err.message)
        } finally {
          setStarting(false)
        }
      }

      const showResult = async (jobId) => {
        try {
          const value = await callRpc('result', { jobId, host: device })
          setTaskResult({ jobId, text: value.text })
        } catch (err) {
          setTaskResult({ jobId, text: `（还没结果）${err.message}` })
        }
      }

      const downloadFile = async (path) => {
        setError('')
        if (localDir.trim() === '') {
          setError('请先在「下载到」里填一个本地目录。')
          return
        }
        try {
          await streamRpc(
            'downloadFromProject',
            { host: device, project: current, remotePath: path, localDir: localDir.trim() },
            (line) => {
              if (line.type === 'done') setNotice(`已下载到 ${line.result.localDir}`)
              else if (line.type === 'error') setError((line.error && line.error.message) || '下载失败')
            },
          )
        } catch (err) {
          setError(err.message)
        }
      }

      const sizeText = (bytes) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(0, Math.round(bytes / 1024))}KB`)

      return h(
        'div',
        { className: 'drd-card' },
        h(
          'div',
          { className: 'drd-cardHead' },
          h('span', { className: 'drd-cardTitle' }, '云端项目'),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h(
              'select',
              { className: 'drd-select', style: { width: '160px' }, value: device, onChange: (e) => setDevice(e.target.value) },
              devices.length === 0
                ? h('option', { value: '' }, '（无设备）')
                : devices.map((d) => h('option', { key: d.name, value: d.name }, d.label || d.name)),
            ),
            h('button', { type: 'button', className: 'drd-mini', onClick: load, disabled: loading || device === '' }, loading ? '读取中…' : '刷新'),
          ),
        ),

        notice ? h('div', { className: 'drd-msg drd-msgOk' }, notice) : null,
        error ? h('div', { className: 'drd-msg drd-msgErr' }, error) : null,

        // 新建项目
        h(
          'div',
          { style: { display: 'flex', gap: '8px', marginBottom: '10px' } },
          h('input', {
            className: 'drd-input',
            value: newName,
            placeholder: '新建项目名（就是云端目录名）',
            onChange: (e) => setNewName(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') createProject() },
            disabled: busy || device === '',
          }),
          h('button', { type: 'button', className: 'drd-primary', style: { flex: 'none' }, onClick: createProject, disabled: busy || newName.trim() === '' }, '新建'),
        ),

        // 项目列表
        projects.length === 0
          ? h('div', { className: 'drd-empty' }, loading ? '读取中…' : '这台设备上还没有项目，先新建一个。')
          : projects.map((p) =>
              h(
                'div',
                { key: p.name, className: 'drd-row' },
                h(
                  'div',
                  { className: 'drd-rowMain' },
                  h('div', { className: 'drd-rowName' }, p.name,
                    current === p.name ? h('span', { className: 'drd-tag drd-tagOk' }, '已打开') : null),
                  h('div', { className: 'drd-rowMeta' },
                    `${p.files} 文件 · ${sizeText(p.bytes)} · ${p.updatedAt ? new Date(p.updatedAt).toLocaleString('zh-CN') : ''}`),
                ),
                h('button', { type: 'button', className: 'drd-mini', onClick: () => openProject(p.name), disabled: busy }, '进入'),
                h('button', { type: 'button', className: 'drd-mini drd-miniDanger', onClick: () => removeProject(p.name), disabled: busy }, '删除'),
              ),
            ),

        // 打开的项目详情
        current
          ? h(
              'div',
              { style: { marginTop: '12px', borderTop: '1px solid var(--dsw-alias-line-regular, #eceef1)', paddingTop: '12px' } },
              h('div', { className: 'drd-cardTitle' }, `项目 ${current}`),
              h('div', { className: 'drd-hint' }, detailLoading ? '读取中…' : `${files.length} 个文件 · ${tasks.length} 个任务`),

              // 上传
              h(
                'div',
                { style: { display: 'flex', gap: '6px', margin: '10px 0' } },
                h('input', {
                  className: 'drd-input',
                  value: uploadPath,
                  placeholder: '本地文件或目录的绝对路径',
                  onChange: (e) => setUploadPath(e.target.value),
                  disabled: uploading,
                }),
                h('input', {
                  className: 'drd-input',
                  style: { width: '110px', flex: 'none' },
                  value: uploadSubdir,
                  placeholder: '子目录(可空)',
                  onChange: (e) => setUploadSubdir(e.target.value),
                  disabled: uploading,
                }),
                h('button', {
                  type: 'button', className: 'drd-mini', style: { flex: 'none' },
                  onClick: doUpload,
                  disabled: uploading || uploadPath.trim() === '',
                }, uploading ? `${uploadPct}%` : '上传'),
              ),

              // 下载目录
              h(
                'div',
                { style: { display: 'flex', gap: '6px', marginBottom: '8px' } },
                h('input', {
                  className: 'drd-input',
                  value: localDir,
                  placeholder: '下载到（本地目录绝对路径，如 C:\\Users\\you\\Downloads）',
                  onChange: (e) => setLocalDir(e.target.value),
                }),
              ),

              // 文件
              h('div', { className: 'drd-label' }, '文件'),
              files.length === 0
                ? h('div', { className: 'drd-empty' }, '（空）')
                : files.slice(0, 40).map((f) =>
                    h(
                      'div',
                      { key: f.path, className: 'drd-row', style: { marginBottom: '4px', padding: '5px 8px' } },
                      h('div', { className: 'drd-rowMain' },
                        h('div', { className: 'drd-rowMeta', style: { marginTop: 0 } }, `${f.path}  ·  ${sizeText(f.bytes)}`)),
                      h('button', { type: 'button', className: 'drd-mini', onClick: () => downloadFile(f.path) }, '下载'),
                    ),
                  ),

              // 新任务
              h('div', { className: 'drd-label', style: { marginTop: '12px' } }, '在这个项目里开任务'),
              h(
                'div',
                { style: { display: 'flex', gap: '6px' } },
                h('input', {
                  className: 'drd-input',
                  value: taskText,
                  placeholder: '让云端在这个目录里做什么',
                  onChange: (e) => setTaskText(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') startTask() },
                  disabled: starting,
                }),
                h('button', {
                  type: 'button', className: 'drd-primary', style: { flex: 'none' },
                  onClick: startTask,
                  disabled: starting || taskText.trim() === '',
                }, starting ? '提交中' : '执行'),
              ),

              taskResult
                ? h('div', { className: 'drd-msg drd-msgOk', style: { marginTop: '8px' } },
                    h('div', { className: 'drd-job' }, taskResult.jobId),
                    taskResult.text ? h('pre', { className: 'drd-pre' }, taskResult.text) : h('div', null, '任务已提交，稍后点「结果」查看。'))
                : null,

              // 任务列表
              tasks.length > 0
                ? h(
                    'div',
                    { style: { marginTop: '10px' } },
                    h('div', { className: 'drd-label' }, '任务记录'),
                    tasks.slice(0, 10).map((t) =>
                      h(
                        'div',
                        { key: t.jobId, className: 'drd-row', style: { marginBottom: '4px', padding: '5px 8px' } },
                        h('div', { className: 'drd-rowMain' },
                          h('div', { className: 'drd-rowName' }, t.jobId,
                            h('span', { className: t.state === 'done' ? 'drd-tag drd-tagOk' : t.state === 'failed' ? 'drd-tag drd-tagBad' : 'drd-tag' }, t.state)),
                          h('div', { className: 'drd-rowMeta' }, t.submittedAt || '')),
                        h('button', { type: 'button', className: 'drd-mini', onClick: () => showResult(t.jobId) }, '结果'),
                      ),
                    ),
                  )
                : null,
            )
          : null,
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
          h('p', null, '用 SSH 关联云服务器作为「设备」。绑定后可以像本地一样在中控端管理云端项目：建项目、传文件、开任务、取结果。密码与私钥仍由「凭据管家」保管，这里只记录绑定关系。'),
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
                placeholder: '我的云主机 A',
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

        h(ProjectsPanel, { devices: state.devices }),
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
          label: '云端管理',
        }, DevicesSection))
      },
    }
  },
})
