# dsh-remote-dispatch

把 DSH 任务派发到云端服务器执行。**本地断网、关机、休眠都不影响云端继续跑完**，回来取结果即可。

---

## 它解决什么问题

| 场景 | 之前 | 现在 |
|---|---|---|
| 网络抖动、任务中断 | 重跑 | 任务早已在云端，本地断 0 影响 |
| 要断网几小时 | 白白损耗 | 断网前派发，回来看结果 |
| 长任务想接着问 | 上下文丢了 | `continueSession` 续跑，它记得前文 |

原理：任务推到云端的 DSH `headless`，用 `setsid + nohup` 拉起，**与 SSH 会话彻底脱钩**。

---

## 安装与启用

插件已装进 `web` 和 `headless` 两个 profile：

```
~/.dsh/profiles/node_modules/dsh-remote-dispatch
~/.dsh/profiles/{web,headless}/package.json  →  bundles 里加了 dsh-remote-dispatch
```

**启用方式**：重启 DSH 桌面应用（插件在启动时加载）。
之后在任意会话里就能用下面 8 个工具，也可以在 设置 → 插件 里看到 `remote-dispatch` 并随时停用。

> 想临时不用：在 设置 → 插件 里禁用 `remote-dispatch` 行，或从 profile 的 `bundles` 里移除。

---

## 三个入口

### 1. 输入框的「推送 云」按钮（主页面）

坐在输入框右侧。点开后**默认就是「把这段对话整体搬到云端」**，不用选文件、不用填路径：

- **要搬运的会话**：下拉选择。列表直接标出每条会话的 `项目 · N 轮 · N 文件 · 时间`，
  选错一眼就能看出来；上次选过的那条会被记住。
  （插件无法得知你正在看哪条对话——编辑器槽位不提供会话 id——所以默认选最新一条，需要你确认）
- **目标设备**：卡片选择，显示 `用户@主机:端口`
- **同步相关文件**：默认勾选，但**只传本会话真正碰过的那些文件**（从工具调用记录里推导，
  保持原有相对路径），不是整个目录——不会把 node_modules、git 历史、无关文件一起搬走
- **接着做什么**（可选）：留空就让云端继续完成最后一件未完成的事
- 点「推送整段对话」→ 实时进度条
- 跑完后卡片上出现「**拉回本地**」：把云端改动同步回来，**覆盖前自动备份**

**上下文以文件形式交接，不塞进提示词。**

- 对话记录导出成云端工作目录下的 `CONVERSATION.md`（**不含工具调用流水**，只保留用户提问与助手答复）
- 本会话**涉及的文件**同步到同一目录（保持相对路径）
- 任务提示词只有约 200 字：「先读 CONVERSATION.md，再按需要看代码，然后做 X」

这样做的好处：提示词不会随对话变长而膨胀（38k 字的对话也只需要 200 字提示词），
云端 agent 自己决定要读哪些内容，和人接手时一样。

> 为什么不能直接搬会话文件：DSH 的会话日志有 `seq` 连续性校验、事件间
> `sourceEventSeqs` 交叉引用、以及 headless 不支持的 agent preset 要求，
> 改任何一处都会报 "corrupt session log"。

> 实测：16 轮对话只带 11 个相关文件，上传 0.04MB（整目录是 5.9MB），提示词 193 字；
> 云端读完记录后准确概括了项目；往返实测中云端新建的文件被「拉回本地」原样取回。

### 2. 设置 → 云端派发（设备管理 + 任务记录）

用 **SSH 关联设备**：

- 下拉选择凭据管家里已有的 SSH 凭据（显示 `用户@主机:端口` 和认证方式）
- 填显示名、设备名、备注，点「绑定设备」
- 每台设备可以「检测」：探测连通性、node/dsh/执行器是否就绪，显示「就绪 / 缺运行时 / 不可达」
- 可「设为默认」或「解绑」

**「推送的任务」卡片**是查看推送结果的地方：选设备 → 列出所有任务的 id / 状态 / 提交时间，
点「结果」直接展开云端返回的答复。这是最可靠的查看入口。

> **为什么不在云端 Web UI 里看？**
> 推送的任务在云端以 `dsh headless` 独立进程运行，工作目录是 `~/dsh-work/<项目>`。
> 云端 Web UI 的工作区是 `/root/dsh`，只列出该工作区登记的会话，所以看不到；
> 而且工作区列表是服务端内存态，改文件要重启 `dsh-web` 才生效。
> 想看的话，可以在云端 Web UI 里把 `~/dsh-work/<项目>` 添加为工作区（需重启服务），
> 或者直接在这里的任务列表里看 —— 后者不需要进云端。

**解绑只删除绑定关系，不会删掉凭据管家里的 SSH 凭据。**

设备绑定持久化在 `~/.dsh/storages/dsh-remote-dispatch/devices.json`，重启不丢。首次加载时会把旧配置里的 `hosts` 自动播种成设备。

### 3. 对话里直接说

```
把这个活派到云端跑，我马上要断网了
```
模型调 `remote_dispatch`；回来后 `remote_result` 取结果。

---

## 9 个工具

| 工具 | 作用 |
|---|---|
| `remote_devices` | **设备管理**：list / bind / unbind / setDefault / sshCredentials |
| `remote_hosts` | 探测设备连通性与运行时 |
| `remote_dispatch` | 派发任务，立刻返回 jobId |
| `remote_status` | 查任务状态 |
| `remote_result` | 取最终答复 |
| `remote_wait` | 阻塞等结果 |
| `remote_logs` | 看运行日志 |
| `remote_list` | 列出所有任务 |
| `remote_cancel` | 取消任务 |

### 显式调用示例

```jsonc
// 派发：上传本地项目 + 指定项目名
remote_dispatch({
  task: "跑通测试并修复失败项，最后汇报改了哪些文件",
  localDir: "C:/Users/you/projects/mytool",
  project: "mytool",
  host: "aliyun"
})
// → { jobId: "mytool-1110-200651", ... }

// 续跑上一轮的上下文
remote_dispatch({
  task: "按 ARCH.md 里的第 3 点开始重构",
  project: "mytool",
  continueSession: "mytool-1110-200651"
})
```

---

## 配置

配置在 `cordis.patch.yml`（也可在 设置 → 插件 里改）：

```yaml
- id: remote-dispatch
  name: dsh-remote-dispatch
  config:
    defaultHost: aliyun
    hosts:
      aliyun:
        credentialId: ssh-xxxxxxxxxxxx   # 指向凭据管家里的 ssh 记录
        label: 我的云主机 A
      tencent:
        credentialId: ssh-yyyyyyyyyyyy
        label: 我的云主机 B
    promptSummary: true        # 往系统提示里加一段"可以派发到云端"的引导
    commandTimeoutMs: 120000
    waitTimeoutMs: 3600000
    maxUploadMb: 200
```

### 加一台新主机

1. 在「凭据管家」里新建一个 **SSH** 凭据，拿到 id（`ssh-xxxxxxxx`）。
2. 在 `hosts` 下加一条：
   ```yaml
   myhost:
     credentialId: ssh-xxxxxxxx
     label: 我的新机器
   ```
3. 那台机器上需要装好 DSH CLI 和执行器（见下）。
4. 用 `remote_hosts(host="myhost", probe=true)` 验证。

**凭据永远不写进配置**：只写 `credentialId`，密码/私钥从凭据管家读取。

---

## 云端需要什么

每台云主机上需要：

| 组件 | 检查方式 |
|---|---|
| Node.js + DSH CLI | `dsh --version` |
| `headless` profile | `dsh --profile headless --dump-config` |
| 模型凭据 | `~/.dsh/.env.headless` 里 `DEEPSEEK_API_KEY=...` |
| 任务执行器 | `dsh-job`（`/usr/local/bin/dsh-job`） |

执行器脚本在插件的 `remote/dsh-job.sh`，部署到云主机（把 `__JOB_ROOT__` / `__DSH_BIN__` / `__KEY_ENV__` 替换成该机实际路径）：

```bash
install -m 755 dsh-job.sh /usr/local/bin/dsh-job
```

> 当前两台（aliyun / tencent）已全部配好并通过验证。

**常见坑**：nvm 装的 node/dsh 不在非交互式 SSH 的 PATH 里，需要软链到 `/usr/local/bin`：

```bash
sudo ln -sf ~/.nvm/versions/node/vXX/bin/node /usr/local/bin/node
sudo ln -sf ~/.nvm/versions/node/vXX/bin/dsh  /usr/local/bin/dsh
```

---

## 云端目录结构

```
~/dsh-work/<project>/      ← 任务的工作目录（上传的代码也在这）
~/dsh-jobs/<job-id>/
├── task.md        任务原文
├── status         queued | running | done | failed | cancelled
├── meta.json      工作目录、session id、提交时间
├── events.jsonl   DSH 完整事件流（含 reasoning、usage）
├── result.md      最终答复
├── run.log        执行器日志
└── err.log        stderr
```

任务按主机**串行排队**（flock），避免抢资源。

---

## 注意事项

1. **云端是独立环境**：没有你本地项目文件（除非用 `localDir` 上传）、没有浏览器登录态、没有本地凭据库。需要内网的活云端做不了。
2. **磁盘不会自动清理**：定期清 `~/dsh-jobs` 旧任务。
3. **密钥轮换**：`~/.dsh/.env.headless` 用的是 DeepSeek key，换 key 时两台都要更新，否则报 `MISSING_CREDENTIAL`。
4. **`localDir` 上传上限**默认 200MB，自动排除 `.git`、`node_modules`、`__pycache__`、`.venv`、`dist`、`build` 等。大项目建议在云端 `git clone` 一次。

## 文件结构

```
dsh-remote-dispatch/
├── index.js            插件入口（apply / inject / 配置解析）
├── client.js           Web 客户端：推送按钮、进度面板、设置页
├── cordis.patch.yml    配置行（设备、默认设备、超时、上传上限）
├── package.json
├── src/
│   ├── service.js      业务逻辑：凭据解析、派发/接力、拉回、分块上传
│   ├── sessions.js     会话读取：多帧 zstd 解码、转录导出、涉及文件识别
│   ├── devices.js      设备注册表（持久化在 ~/.dsh/storages）
│   ├── ssh.js          SSH 传输（askpass 传密码、临时 600 权限私钥）
│   ├── rpc.js          Browser ⇄ Host 接口（含 NDJSON 进度流）
│   ├── tools.js        11 个 agent 工具
│   └── validate.js     参数校验（jobId / 路径等）
├── remote/dsh-job.sh   云端执行器（装到云主机 /usr/local/bin/dsh-job）
└── docs/
    └── audit-2026-11-10/  代码审计归档（历史快照，见其中 README）
```
