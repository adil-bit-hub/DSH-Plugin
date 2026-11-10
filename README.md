# DSH-Plugin

自用的 [DeepSeek Harness](https://github.com/deepseek-ai) 插件集合。

每个插件一个目录，可以单独安装、单独更新。

## 插件列表

| 插件 | 目录 | 说明 |
| --- | --- | --- |
| `dsh-remote-dispatch` | [`dsh-remote-dispatch/`](./dsh-remote-dispatch/) | 把 DSH 任务派发到云端执行。本地断网、关机都不影响云端继续跑；支持整段对话接力、只同步涉及的文件、结果拉回本地 |

## dsh-remote-dispatch 简介

一句话：**本地断网 / 关机，云端的活照样干完。**

- **主页面按钮**：输入框右侧「推送 云」，选设备 → 推送整段对话 + 相关文件 → 云端口读文件后继续
- **上下文以文件交接**：对话记录写成云端 `CONVERSATION.md`，任务提示词只有 200 字左右，不会把上下文撑爆
- **只传相关文件**：从工具调用记录里推导本次会话真正碰过的文件，不是整个目录
- **设备可管理**：用 SSH 凭据绑定云主机，能检测、设默认、解绑
- **双向同步**：任务跑完可把云端改动拉回本地，覆盖前自动备份
- **11 个 agent 工具**：派发 / 查询 / 取结果 / 等结果 / 日志 / 列表 / 取消 / 设备管理 / 接力 / 拉回

详见 [dsh-remote-dispatch/README.md](./dsh-remote-dispatch/README.md)。

## 安装方式

1. 把对应目录链接到 DSH profile 的 `node_modules`：

   ```bash
   # Windows（junction）
   mklink /J "%USERPROFILE%\.dsh\profiles\node_modules\dsh-remote-dispatch" "<本仓库路径>\dsh-remote-dispatch"
   ```

2. 在该 profile 的 `package.json` 里把它加进 `dsh.profile.bundles`：

   ```json
   "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-remote-dispatch"]
   ```

3. 重启 DSH（或在 设置 → 插件 里启停一次让它重新加载）。

云端还需要装执行器 `remote/dsh-job.sh`，具体见插件 README。

## 许可

MIT，见 [LICENSE](./LICENSE)。