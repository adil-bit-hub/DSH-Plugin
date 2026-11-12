# dsh-remote-dispatch

在中控端（本地 DSH）直接管理两台云端 DSH：**建项目、传文件、开任务、取结果**，像在本地一样操作。
任务在云端独立进程里跑，本地断网、关机都不影响它执行完。

---

## 它解决什么问题

| 场景 | 没有它 | 有了它 |
|---|---|---|
| 想在云端某个项目里跑点活 | SSH 上去敲命令、装环境 | 中控端选项目 → 写任务 → 执行 |
| 要把本地文件送到云端项目 | scp / rsync 手敲 | 界面里填本地路径 → 上传（带进度） |
| 想知道云端跑过哪些任务 | 翻目录看文件 | 项目里直接列出任务与结果 |
| 本地断网、关机 | 任务停半路 | 云端照跑，回来取结果 |

---

## 安装与启用

三个 profile（`desktop` / `web` / `headless`）都用 junction 指向本仓库目录，
改完代码重启一次 DSH 就生效，不需要再复制：

```
~/.dsh/profiles/desktop/node_modules/dsh-remote-dispatch -> <本仓库>\dsh-remote-dispatch
~/.dsh/profiles/node_modules/dsh-remote-dispatch         -> <本仓库>\dsh-remote-dispatch
```

并在对应 profile 的 `package.json` 的 `dsh.profile.bundles` 里加了 `dsh-remote-dispatch`。

**启用方式**：重启 DSH 桌面应用（插件在启动时加载）。
之后在任意会话里就能用下面 13 个工具，也可以在 设置 → 插件 里看到 `remote-dispatch` 并随时停用。

> 想临时不用：在 设置 → 插件 里禁用 `remote-dispatch` 行，或从 profile 的 `bundles` 里移除。

---

## 两个入口

### 1. 输入框旁的「云端任务」按钮

像在本地一样操作云端：

- **云端设备**：卡片选择（阿里云 / 腾讯云）
- **项目**：下拉选已有项目，或直接输入名字点「新建」
- **任务内容**：写要让它做什么

点「在云端执行」，任务就在该项目的云端目录里跑，返回 `jobId`。
不需要上传任何东西——项目里已有的文件它直接用；要传文件去设置页。

### 2. 设置 → 云端管理

上半部分是**设备**（用 SSH 关联云主机，可检测/设默认/解绑），
下半部分是**云端项目**：

- 列项目：文件数、体积、更新时间
- 新建 / 进入 / 删除（删除需要在确认框里点头）
- 进入项目后：
  - **文件列表**：每个文件可单独「下载」到本地指定目录
  - **上传**：填本地文件或目录路径 + 可选子目录，带进度
  - **开任务**：在这个项目里执行，结果直接展开
  - **任务记录**：列出该项目跑过的任务与状态，点「结果」查看

### 3. 对话里直接说

```
在 aliyun 的 blog 项目里跑个任务：统计一下有多少篇文章
```

## 13 个工具

| 工具 | 作用 |
|---|---|
| `remote_hosts` | 探测设备连通性与运行时就绪情况 |
| `remote_projects` | 项目管理：list / create / remove / files / tasks |
| `remote_upload` | 上传本地文件或目录到云端项目 |
| `remote_download` | 从云端项目下载文件或目录到本地 |
| `remote_task` | 在指定云端项目里开任务 |
| `remote_dispatch` | 派发任务（可同时上传一个本地目录） |
| `remote_status` / `remote_result` | 查状态 / 取结果 |
| `remote_wait` / `remote_logs` | 等结果 / 看日志 |
| `remote_list` / `remote_cancel` | 列出全部任务 / 取消 |
| `remote_devices` | 设备管理：list / bind / unbind / setDefault / sshCredentials |

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
│   ├── service.js      业务逻辑：凭据解析、项目/文件/任务、派发、分块上传
│   ├── devices.js      设备注册表（持久化在 ~/.dsh/storages）
│   ├── ssh.js          SSH 传输（askpass 传密码、临时 600 权限私钥）
│   ├── rpc.js          Browser ⇄ Host 接口（含 NDJSON 进度流）
│   ├── tools.js        11 个 agent 工具
│   └── validate.js     参数校验（jobId / 路径等）
├── remote/dsh-job.sh   云端执行器（装到云主机 /usr/local/bin/dsh-job）
└── docs/
    └── audit-2026-11-10/  代码审计归档（历史快照，见其中 README）
```
