# DSH-Plugin

自用的 [DeepSeek Harness](https://github.com/deepseek-ai) 插件集合。

每个插件一个目录，可以单独安装、单独更新。

## 插件列表

| 插件 | 目录 | 说明 |
| --- | --- | --- |
| `dsh-remote-dispatch` | [`dsh-remote-dispatch/`](./dsh-remote-dispatch/) | 在中控端直接管理云端 DSH：建项目、传文件、开任务、取结果，像本地一样操作。任务在云端独立进程跑，本地断网/关机不影响 |

## dsh-remote-dispatch 简介

一句话：**在中控端像操作本地一样操作云端，且本地断网、关机都不影响云端执行。**

- **云端任务按钮**：输入框旁选设备 → 选/建项目 → 写任务 → 执行
- **项目管理**：列出云端项目（文件数/体积/时间），可新建、进入、删除
- **文件操作**：单个文件下载到本地；本地文件或目录上传到项目（带进度）
- **任务管理**：在项目里开任务、看历史任务与结果
- **设备可管理**：用 SSH 凭据绑定云主机，能检测、设默认、解绑
- **13 个 agent 工具**：项目 / 上传 / 下载 / 任务 / 派发 / 状态 / 结果 / 等待 / 日志 / 列表 / 取消 / 设备

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