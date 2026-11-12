# dsh-remote-dispatch — API Reference

> Scope: every surface the plugin exports — the ten agent tools, the internal service
> class and transport helpers, the browser⇄host RPC endpoints, the device registry,
> and the cloud-side `dsh-job` runner CLI.
>
> Everything here is derived from the source at `dsh-remote-plugin/`. Citations use
> `path:line`. Where the code makes a *guarantee* weaker than its doc comment
> suggests, that is called out explicitly in a **⚠ Caveat** block.

---

## Table of contents

1. [Concepts and vocabulary](#1-concepts-and-vocabulary)
2. [Error model](#2-error-model)
3. [Agent tools](#3-agent-tools)
   - [remote_hosts](#31-remote_hosts)
   - [remote_dispatch](#32-remote_dispatch)
   - [remote_status](#33-remote_status)
   - [remote_result](#34-remote_result)
   - [remote_wait](#35-remote_wait)
   - [remote_logs](#36-remote_logs)
   - [remote_list](#37-remote_list)
   - [remote_cancel](#38-remote_cancel)
   - [remote_devices](#39-remote_devices)
4. [Host-side JavaScript API](#4-host-side-javascript-api)
5. [Browser ⇄ Host RPC](#5-browser--host-rpc)
6. [Cloud-side runner CLI (`dsh-job`)](#6-cloud-side-runner-cli-dsh-job)
7. [Plugin configuration schema](#7-plugin-configuration-schema)
8. [On-disk formats](#8-on-disk-formats)
9. [Limits and constants](#9-limits-and-constants)

---

## 1. Concepts and vocabulary

| Term | Meaning in this codebase |
|---|---|
| **device** | A cloud machine *bound* to the plugin. Stored in `devices.json` as `{name, label, credentialId, workRoot, project, note, createdAt, updatedAt, source}` (`src/devices.js:126-149`). A device holds **no secret** — only the credential id. |
| **host** / **host name** | The string you pass as `host:` to a tool. It is the *device name* (e.g. `aliyun`), **not** a DNS name and **not** the label. Resolution order: exact device name → else the default device (`src/devices.js:107-120`). |
| **job** | One task pushed to one host. Identified by `jobId`. Lives in `$HOME/dsh-jobs/<jobId>/` on the cloud host (`remote/dsh-job.sh:31`). |
| **project** | Directory component that selects the cloud working directory `$HOME/dsh-work/<project>` (`src/service.js:453`). Auto-derived from `localDir`'s basename when not given (`src/service.js:449-451`). |
| **session** | A DSH session id on the cloud (`meta.json` → `"session"`). `continueSession` reuses it so the cloud model keeps prior context (`src/service.js:496-506`, `remote/dsh-job.sh:94`). |
| **remoteRoot** | Absolute cloud path `$HOME/dsh-work/<project>`; this is the cwd the cloud agent runs in (`remote/dsh-job.sh:99`). |

Two different "home" directories exist and are easy to confuse:

- **Harness home** (`DSH_HOME`, else `$USERPROFILE`/`$HOME` + `/.dsh`) holds `devices.json` and the
  askpass helper (`src/devices.js:19-24`, `src/ssh.js:52-57`).
- **Cloud home** (`$HOME` on the server, discovered by running `printf %s "$HOME"` over SSH,
  `src/service.js:350-356`) holds `dsh-work/` and `dsh-jobs/`.

---

## 2. Error model

All failures inside the plugin are thrown as `RemoteError`:

```js
export class RemoteError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
```

`src/ssh.js:45-50`

**How the code surfaces per channel**

| Channel | Shape |
|---|---|
| Agent tool | The tool wrapper re-throws `new Error("${code}: ${message}")` — a plain `Error`, **not** structured (`src/tools.js:46-52`). So an agent sees the literal string `job-not-found: aliyun 上没有任务 foo。可用 remote_list 查看。` |
| RPC (non-streaming) | HTTP **200** with `{ok:false, error:{code, message}}` (`src/rpc.js:33-39, 246-250`). Non-`RemoteError` throws are reported as `code:"internal"`. |
| RPC `push` | NDJSON line `{"type":"error","error":{code,message}}` (`src/rpc.js:169-170`). |
| RPC transport-level | 401 `unauthorized`, 403 `forbidden`, 405 `method not allowed` (non-POST or multi-segment path), 404 `{ok:false,error:{code:"not-found"}}` (`src/rpc.js:218-236`). |

**Complete error-code table**

| `code` | Thrown at | Trigger |
|---|---|---|
| `unknown-host` | `src/service.js:147-151` (fallback only) | No registry mounted and `host` is not a key in `settings.hosts`. |
| `unknown-device` | `src/devices.js:113-117`, `155-157`, `170` | Device name not in the registry (including `unbind`/`setDefault` of a missing device). |
| `invalid-name` | `src/devices.js:29` | Device name empty after sanitising. |
| `credential-required` | `src/devices.js:129-131` | `bind` without `credentialId`. |
| `no-credential` | `src/service.js:162-164` | Host entry has no `credentialId`. |
| `credential-file-missing` | `src/service.js:225` | No credentials service **and** neither `.credentials.yaml` nor `.credentials.yml` exists. |
| `credential-missing` | `src/service.js:256` | Credential id not found in the credentials file. |
| `credential-invalid` | `src/service.js:327`, `336` | `id` mismatch inside the record, or no `host` field. |
| `askpass-unavailable` | `src/ssh.js:96-100` | Windows without `csc.exe`, needed for password auth. |
| `no-home` | `src/service.js:354` | `printf %s "$HOME"` returned empty. |
| `spawn-failed` | `src/ssh.js:120`, `146` | `ssh` (or the target binary) could not be started. |
| `timeout` | `src/ssh.js:132`, `317` | Local process (`ssh` / `tar` / `csc`) exceeded its timeout. |
| `empty-task` | `src/service.js:443` | `task` empty after trim. |
| `dir-missing` / `not-a-directory` | `src/service.js:410`, `412` | `localDir` doesn't exist / isn't a directory. |
| `pack-failed` | `src/service.js:422-425` | System `tar` exited non-zero. |
| `upload-too-large` | `src/service.js:471-473` | Packed archive in MB > `maxUploadMb`. |
| `upload-failed` | `src/service.js:484-486`, `578`, `340` | Remote unpack didn't print `UPLOAD_OK`; or the upload stream failed. |
| `upload-aborted` | `src/ssh.js:323`, `330` | A write to a dead ssh stdin (EPIPE / timeout killed the child). |
| `task-upload-failed` | `src/service.js:511-513` | Task text heredoc didn't print `TASK_OK`. |
| `submit-failed` | `src/service.js:520-522` | `dsh-job submit` exited non-zero. |
| `job-not-found` | `src/service.js:600-602` | `$HOME/dsh-jobs/<jobId>` directory absent. |
| `result-read-failed` | `src/service.js:628-630` | `cat` of `result.md` failed AND stdout was empty. |
| `result-empty` | `src/service.js:632-634` | `result.md` missing or blank (typically: still running). |
| `list-failed` | `src/service.js:657-659` | `dsh-job list` exited non-zero (usual cause: runner not installed). |
| `cancel-failed` | `src/service.js:677` | `dsh-job cancel` exited non-zero. |
| `too-large` | `src/rpc.js:46` | RPC request body > 1 MiB. |
| `invalid` | `src/rpc.js:53`, `108`, `115`, `178`, `184`, `195`, `201` | Malformed JSON or a missing `jobId`/`name`. |
| `internal` | `src/rpc.js:38` | Any non-`RemoteError` exception. |
| `not-found` | `src/rpc.js:234` | Unknown RPC endpoint. |

---

## 3. Agent tools

Registered by `registerTools()` (`src/tools.js:45-254`). Each tool declares
`output: { schema: {}, render: JSON_RENDER }`, so the model sees
`JSON.stringify(result, null, 2)` (`src/tools.js:12`). Before rendering, a `clean()`
pass drops `undefined` properties and converts non-finite numbers to `null`
(`src/tools.js:15-27`) — so **optional fields that are absent simply do not appear
in the JSON**, and `pid: undefined` disappears rather than showing `null`.

**Shared parameter**

```jsonc
host: string   // optional, all tools except remote_dispatch's use of it is the same
// "目标云主机名（config.hosts 的键，如 aliyun、tencent）。省略则用 defaultHost。"
```

`src/tools.js:34-37`. Omitted ⇒ the registry's `defaultDevice`
(`src/service.js:132-136`). ⚠ The description mentions only `config.hosts` keys; since
the device registry ships, the effective namespace is *device names*
(`src/local` resolution in §4).

---

### 3.1 `remote_hosts`

> "列出可用的云主机，并检查每台的连通性与运行时就绪情况（node/dsh/dsh-job 是否装好）。"
> — `src/tools.js:56-57`

**Purpose** — enumerate hosts, and optionally SSH into each to report reachability and
runtime readiness.

**Parameters**

| Name | Type | Required | Default | Description (verbatim) | Source |
|---|---|---|---|---|---|
| `host` | string | no | all devices | "只检查这一台；省略则检查全部。" | `src/tools.js:61` |
| `probe` | boolean | no | `true` | "是否真正 SSH 连上去探测（默认 true）。" | `src/tools.js:62` |

**Return shape**

```jsonc
{
  "defaultHost": "aliyun",          // string — current default device name
  "count": 2,                       // number — how many entries in hosts[]
  "hosts": [
    // probe:true + success  → merged probe() output (src/service.js:371-383)
    {
      "host": "aliyun",             // string — config/device name (this is what tools accept)
      "label": "我的云主机 A",        // string|undefined — from the device entry
      "hostname": "iZbp1...",       // string — the machine's own `hostname`
      "ssh": "root@203.0.113.10:22", // string — `user@host:port` label (src/ssh.js:183-185)
      "reachable": true,            // boolean — remote command exit code === 0
      "node": "/usr/local/bin/node",// string — path, or "missing"
      "dsh": "/usr/local/bin/dsh",  // string — path, or "missing"
      "runner": "/usr/local/bin/dsh-job", // string — path, or "missing"
      "home": "/root",              // string — remote $HOME
      "ready": true,                // boolean — node AND dsh both resolved
      "runnerInstalled": true,      // boolean — dsh-job resolved
      "warnings": []                // string[] — whitespace-trimmed stderr, or []
    },
    // probe:false           → { host, label, credentialId } only (src/tools.js:71-75)
    // probe:true + failure  → { host, reachable:false, error:"<code>: <msg>" } (src/tools.js:79-81)
    { "host": "tencent", "reachable": false, "error": "timeout: 命令超时（120s）：ssh" }
  ]
}
```

`pid`-style omissions apply: with `probe:false`, `label`/`credentialId` are omitted
when undefined; on failure no `label` is included.

**Status semantics**

- `reachable` — simply `r.code === 0` of the probe command (`src/service.js:375`).
  It is **not** a TCP/handshake test: an auth failure also yields `reachable:false`.
- `ready` — `node` and `dsh` both present (`src/service.js:380`). It does **not** require
  `dsh-job`; check `runnerInstalled` separately. A host can be `ready:true,
  runnerInstalled:false`, in which case `remote_dispatch` will fail later with
  `submit-failed`.
- `warnings` — the whole stderr, not just warnings; a banner printed to stderr shows up here.

**Error modes**

- `unknown-device` — when `host` names nothing.
- Per-host failures are **swallowed** into `{reachable:false, error}` (`src/tools.js:79-81`);
  the tool itself only fails when `resolveHost` throws before the `try`
  (i.e. `service.deviceNames()` itself fails) — in practice, a bad `host` argument.

**Example call**

```json
{ "host": "aliyun" }
```

**Example response** (probe failure variant)

```json
{ "host": "tencent", "reachable": false, "error": "timeout: 命令超时（120s）：ssh" }
```

---

### 3.2 `remote_dispatch`

> "把一个任务派发到云服务器的 DSH 上执行，立刻返回 jobId，不阻塞。"
> — `src/tools.js:89-92`

**Parameters**

| Name | Type | Required | Default | Description (verbatim) | Source |
|---|---|---|---|---|---|
| `task` | string | **yes** (`required:['task']`) | — | "任务内容（自然语言，云端 DSH 会作为一次完整任务执行）。" | `src/tools.js:96,103` |
| `host` | string | no | `defaultDevice` | shared §3 header | `src/tools.js:97` |
| `project` | string | no | basename of `localDir`, else `"default"` | "项目名，决定云端工作目录 ~/dsh-work/<project>。" | `src/tools.js:98`, `src/service.js:449-451` |
| `localDir` | string | no | — | "可选：本地目录绝对路径。会打包（排除 node_modules/.git 等）上传到云端工作目录后再执行。" | `src/tools.js:99` |
| `continueSession` | string | no | — | "可选：上一次任务的 jobId，续跑它的会话，云端模型会记得前文。" | `src/tools.js:100` |
| `jobId` | string | no | `<project>-<MMDD-HHMMSS>` | "可选：自定义 jobId，便于识别。默认 <project>-<月日-时分秒>。" | `src/tools.js:101`, `src/service.js:386-392` |

**Derived values**

- **`project` sanitisation**: every run of characters outside `[A-Za-z0-9._-]` becomes `-`,
  then leading/trailing dashes are stripped; empty ⇒ `"default"`
  (`src/service.js:395-398`). Verified behaviours: `"my tool!" → "my-tool"`,
  `"我的项目" → "default"`. ⚠ **A wholly non-ASCII project name silently becomes `default`.**
- **`jobId` sanitisation**: every character outside `[A-Za-z0-9._-]` becomes `-` —
  a **single** dash, no collapsing (`src/service.js:452`): `"my tool/1-x" → "my-tool-1-x"`.
  ⚠ This substitution is applied to a user-supplied `jobId` too, but `continueSession`
  is **not** sanitised (`src/service.js:498`) — so a `continueSession` containing
  characters that a custom `jobId` would have rewritten will not find its `meta.json`.
- **`remoteRoot`** = `${home}/dsh-work/${project}` (`src/service.js:453`).
- **Timestamp** uses *local* time of the **host process**, so the `MMDD-HHMMSS` suffix is
  the operator's local clock, not UTC (`src/service.js:388-391`).

**Return shape**

```jsonc
{
  "jobId": "mytool-1110-200651",     // string — sanitised job id
  "host": "aliyun",                  // string — resolved device name
  "ssh": "root@203.0.113.10:22",   // string — `user@host:port`
  "project": "mytool",               // string — sanitised project
  "remoteRoot": "~/dsh-work/mytool", // string — cloud cwd
  "session": "ses_abc123",           // string — present ONLY when continueSession resolved
  "notes": [                         // string[] — human-readable audit trail
    "已上传本地目录 C:\\...\\mytool（6.50MB）到 ~/dsh-work/mytool",
    "续跑 session ses_abc123",
    "未找到 <old-job> 的 session，按新任务执行"
  ],
  "message": "mytool-1110-200651 已在 aliyun 上开始执行；本地断网或关机都不会影响它，稍后用 remote_status / remote_result 取结果。"
}
```

`src/service.js:524-533`. All three `notes` variants are constructed at
`src/service.js:487`, `502`, `504`.

**Notes semantics**

| Note text | Meaning |
|---|---|
| `已上传本地目录 <dir>（<n>MB）到 <remoteRoot>` | Upload + unpack succeeded (`src/service.js:487`). |
| `续跑 session <sid>` | `meta.json` of `continueSession` contained a session id (`src/service.js:500-502`). |
| `未找到 <id> 的 session，按新任务执行` | The `continueSession` job has no `meta.json`/no `session` key. **Not an error** — the job runs as a brand-new session (`src/service.js:503-505`). |

**Progress phases** (relevant for the RPC stream; tool calls emit none):

| phase | percent | detail | Source |
|---|---|---|---|
| `connecting` | 0 | `连接 <host>` | `src/service.js:463` |
| `packing` | 2 | `打包本地目录` | `src/service.js:467` |
| `uploading` | 4 → 92 | `打包完成 <n>MB，开始上传`, then `上传中 <sent> / <total> MB` | `src/service.js:474, 549-575` |
| `unpacking` | 93 | `云端解包中` | `src/service.js:477` |
| `submitting` | 96 | `提交任务` | `src/service.js:493` |

Upload progress uses 256 KiB chunks, throttled to one report per 120 ms, and spans
5→92 % so the bar still moves during unpack/submit (`src/service.js:550-557`).

**Error modes** — `empty-task`, `unknown-device`, `no-credential`,
`credential-*`, `dir-missing`, `not-a-directory`, `pack-failed`,
`upload-too-large`, `upload-failed`, `upload-aborted`, `task-upload-failed`,
`submit-failed`, `timeout`, `spawn-failed`, `askpass-unavailable`, `no-home`.
See §2 for triggers.

**Example call**

```json
{
  "task": "跑通测试并修复失败项，最后汇报改了哪些文件",
  "localDir": "C:/Users/you/projects/mytool",
  "project": "mytool",
  "host": "aliyun"
}
```

**Example response**

```json
{
  "jobId": "mytool-1110-200651",
  "host": "aliyun",
  "ssh": "root@203.0.113.10:22",
  "project": "mytool",
  "remoteRoot": "~/dsh-work/mytool",
  "notes": [
    "已上传本地目录 C:\\Users\\you\\projects\\mytool（6.50MB）到 ~/dsh-work/mytool"
  ],
  "message": "mytool-1110-200651 已在 aliyun 上开始执行；本地断网或关机都不会影响它，稍后用 remote_status / remote_result 取结果。"
}
```

---

### 3.3 `remote_status`

> "查询云端任务的执行状态（queued/running/done/failed/cancelled）与元信息。"
> — `src/tools.js:111`

**Parameters**

| Name | Type | Required | Default | Source |
|---|---|---|---|---|
| `jobId` | string | **yes** | — | `src/tools.js:115,118` |
| `host` | string | no | `defaultDevice` | `src/tools.js:116` |

**Return shape**

```jsonc
{
  "jobId": "mytool-1110-200651",
  "host": "aliyun",
  "state": "running",            // see state table below
  "finished": false,             // boolean — state ∈ {done, failed, cancelled}
  "pid": "18231",                // string — worker pid; ABSENT until the worker writes pid
  "workdir": "~/dsh-work/mytool", // string|undefined — meta.workdir
  "session": "ses_abc123",       // string — absent when meta.session is ""
  "submittedAt": "2026-11-10T20:06:51+08:00", // string|undefined — meta.submitted_at
  "resultBytes": 1024,           // number — `wc -c` of result.md, 0 if absent
  "logLines": 12                 // number — `wc -l` of run.log, 0 if absent
}
```

`src/service.js:608-619`.

**`state` values**

| `state` | Written by | Meaning |
|---|---|---|
| `queued` | `submit` before the worker starts (`remote/dsh-job.sh:56`) | Job registered, worker spawned, **waiting for the host-wide flock**. |
| `running` | worker after acquiring the lock (`remote/dsh-job.sh:80`) | `dsh` is executing. `pid` is now present. |
| `done` | worker, `rc == 0` (`remote/dsh-job.sh:143-145`) | `dsh` exited 0; `result.md` normally holds the final answer. |
| `failed` | worker, `rc != 0` (`remote/dsh-job.sh:146-148`) | `dsh` exited non-zero. `result.md` may still exist (partial). |
| `cancelled` | `dsh-job cancel` (`remote/dsh-job.sh:188`), or worker observing it (`:141-142`) | Killed (or never started). |
| `unknown` | none | Fallback when the `status` file is unreadable (`src/service.js:607`). |

⚠ **`queued` is the normal state for a long time.** The runner serialises *every* job on
a host behind one lock file, so a second dispatch on `aliyun` shows `queued` until the
first finishes, no matter how small it is (`remote/dsh-job.sh:72-74`).

⚠ **`done` does not mean "the work succeeded"** — it means `dsh` exited 0. A task whose
agent decided to fail still exits 0. `failed` is reserved for CLI-level failures.
Because of this, `state` alone is not a success signal; read `remote_result`.

**Error modes** — `job-not-found` (directory absent), plus transport errors.

**Example call**

```json
{ "jobId": "mytool-1110-200651", "host": "aliyun" }
```

**Example response**

```json
{
  "jobId": "mytool-1110-200651",
  "host": "aliyun",
  "state": "done",
  "finished": true,
  "pid": "18231",
  "workdir": "~/dsh-work/mytool",
  "session": "ses_abc123",
  "submittedAt": "2026-11-10T20:06:51+08:00",
  "resultBytes": 1834,
  "logLines": 14
}
```

---

### 3.4 `remote_result`

> "取回云端任务的最终答复。任务仍在运行时返回错误提示，请改用 remote_status 或 remote_wait。"
> — `src/tools.js:126`

**Parameters**

| Name | Type | Required | Default | Source |
|---|---|---|---|---|
| `jobId` | string | **yes** | — | `src/tools.js:130,133` |
| `host` | string | no | `defaultDevice` | `src/tools.js:131` |

**Return shape**

```jsonc
{
  "jobId": "mytool-1110-200651",  // string
  "host": "aliyun",               // string
  "text": "..."                   // string — result.md, trimmed
}
```

`src/service.js:635`.

**Behaviour details**

- The remote command is
  `cat <result.md> 2>/dev/null; echo; echo __RC=$?` (`src/service.js:627`).
  ⚠ `$?` is the exit status of `echo`, not `cat`, so `__RC` is always `0`. The
  `result-read-failed` branch (`:628-630`) is therefore effectively unreachable;
  **missing results always surface as `result-empty`.**
- Only the *last* `__RC=<n>` token is stripped (`src/service.js:631`).
- `text` is `.trim()`-ed (`src/service.js:635`).
- `result.md` is written by the worker's `python3` extraction of the `{"type":"final"}`
  event, falling back to a `sed` one-liner if `python3` is absent
  (`remote/dsh-job.sh:114-136`). The fallback **cannot decode JSON escapes**
  (`\"`, `\n`, `\uXXXX` survive literally) and only matches when `"type":"final"`
  is immediately followed by `"text":"…"}` on the same line.

**Error modes**

- `result-empty` — file missing or whitespace only. This is what you get while the job is
  `queued`/`running`, and also when a `done` job produced no final event.
- `job-not-found` is **not** thrown here; a missing directory produces `result-empty`.

**Example call**

```json
{ "jobId": "mytool-1110-200651" }
```

**Example response**

```json
{
  "jobId": "mytool-1110-200651",
  "host": "aliyun",
  "text": "修复了 3 个失败用例：test_parse.py 的时区处理、test_cli.py 的退出码、test_io.py 的编码。改动文件：src/parse.py、src/cli.py、src/io.py。"
}
```

---

### 3.5 `remote_wait`

> "等待云端任务跑完并直接返回最终答复。注意：这会让本地一直连着…打算断网时不要用这个。"
> — `src/tools.js:141-143`

**Parameters**

| Name | Type | Required | Default | Description (verbatim) | Source |
|---|---|---|---|---|---|
| `jobId` | string | **yes** | — | | `src/tools.js:147,151` |
| `host` | string | no | `defaultDevice` | | `src/tools.js:148` |
| `timeoutSeconds` | number | no | `waitTimeoutMs / 1000` (default 3600) | "最长等待秒数，默认 3600，上限 21600。" | `src/tools.js:149,155` |

**Clamping** — `Math.max(30, Math.min(21600, Number(v) || settings.waitTimeoutMs/1000))`
(`src/tools.js:155`). So `< 30` becomes `30`, `> 21600` becomes `21600`, and a
non-numeric value falls back to the setting. The service then re-clamps with
`Math.max(30_000, timeoutMs || waitTimeoutMs)` (`src/service.js:685`).

**Return shape**

```jsonc
{
  "jobId": "mytool-1110-200651",
  "host": "aliyun",
  "state": "done",          // done | failed | cancelled | timeout | unknown
  "result": "..."           // string — ONLY when state === "done" and the read succeeded
  // "resultError": "..."   // string — ONLY when state === "done" but result.md was empty
}
```

`src/service.js:690-699`.

**State values**

| `state` | Source |
|---|---|
| `done` | `dsh-job wait` printed `done` (`remote/dsh-job.sh:216`). |
| `failed` | printed `failed` (`:216`). |
| `cancelled` | printed `cancelled` (`:216`). |
| `timeout` | **printed by the runner on timeout but exits 1** (`remote/dsh-job.sh:218`). The service takes the *last stdout line* regardless of exit code, so you get `state:"timeout"` — not an error. |
| `unknown` | fallback if stdout was empty (`src/service.js:690`). |

⚠ `timeout` is only a **host-side** decision: the runner polls `status` every 5 s up to
the budget. Separately, the local `ssh` call gets `budget + 120_000 ms`
(`src/service.js:686-689`); if that expires you get a `timeout` **error**, not a
`"timeout"` **state**.

⚠ `remote_wait` polls; it does not stream. Because the runner holds the host lock, a
waiter on a queued job burns its whole budget waiting for the lock holder.

**Example call**

```json
{ "jobId": "mytool-1110-200651", "timeoutSeconds": 600 }
```

**Example response (timeout)**

```json
{ "jobId": "mytool-1110-200651", "host": "aliyun", "state": "timeout" }
```

---

### 3.6 `remote_logs`

> "查看云端任务的运行日志（run.log 与 stderr 末尾），任务失败时用它排错。"
> — `src/tools.js:162`

**Parameters**

| Name | Type | Required | Default | Description (verbatim) | Source |
|---|---|---|---|---|---|
| `jobId` | string | **yes** | — | | `src/tools.js:166,170` |
| `host` | string | no | `defaultDevice` | | `src/tools.js:167` |
| `lines` | number | no | `40` | "run.log 取末尾多少行，默认 40。" | `src/tools.js:168` |

**Clamping** — `Math.max(1, Math.min(2000, Number(lines) || 40))` (`src/service.js:644`).
Note `0` is falsy, so `lines:0` gives 40, not 1.

**Return shape**

```jsonc
{
  "jobId": "mytool-1110-200651",
  "host": "aliyun",
  "log": "=== start ... ===\n--- dsh exit rc=1 ---\n--- stderr ---\n..."
}
```

`src/service.js:645-649`. `log` is `r.stdout.trim()`.

**Layout of `log`** (literal markers, emitted by the host, not the runner):

```
--- run.log ---
<last N lines of run.log>
--- stderr ---
<last 40 lines of err.log>
```

`src/service.js:646-647`. Note the em-dash-free ASCII markers; and note that the
runner itself *also* appends the last 40 stderr lines into `run.log` at job end
(`remote/dsh-job.sh:139`), so a finished job's stderr often appears **twice**.

**`lines` only governs `run.log`** — the stderr tail is hard-coded to 40 lines
(`src/service.js:647`).

**Error modes** — a missing directory or unreadable files do **not** raise
(`2>/dev/null` on both `tail`s); you get markers with empty bodies. Only transport
errors fail the call.

**Example call**

```json
{ "jobId": "mytool-1110-200651", "lines": 10 }
```

**Example response**

```json
{
  "jobId": "mytool-1110-200651",
  "host": "aliyun",
  "log": "--- run.log ---\n[2026-11-10 20:06:52] === start mytool-1110-200651 (wd=~/dsh-work/mytool session=<new>) ===\n--- dsh exit rc=1 ---\nError: MISSING_CREDENTIAL: no API key found\n--- stderr ---\nError: MISSING_CREDENTIAL: no API key found"
}
```

---

### 3.7 `remote_list`

> "列出某台云主机上的所有任务及其状态，忘了 jobId 时用它找回来。"
> — `src/tools.js:178`

**Parameters**

| Name | Type | Required | Default | Source |
|---|---|---|---|---|
| `host` | string | no | `defaultDevice` | `src/tools.js:181` |

**Return shape**

```jsonc
{
  "host": "aliyun",
  "count": 2,
  "jobs": [
    { "jobId": "mytool-1110-200651", "state": "done",    "submittedAt": "2026-11-10T20:06:51+08:00" },
    { "jobId": "report-1110-184402", "state": "failed",  "submittedAt": "2026-11-10T18:44:02+08:00" }
  ]
}
```

`src/service.js:669`.

**Parsing rules** — the first line of `dsh-job list` output is always dropped as a
header (`src/service.js:662`); each remaining line is whitespace-split into
`[id, state, ...rest]` and `rest` is re-joined with single spaces into `submittedAt`
(`src/service.js:665-668`). ⚠ The runner's `printf` pads columns, so `submittedAt` is
usually the ISO timestamp but may carry extra padding when a field is blank.

**Ordering** — glob order of `$DSH_JOB_ROOT/*/`, i.e. effectively sorted by job id
(lexicographic), **not** by submission time (`remote/dsh-job.sh:199`).

**Error modes** — `list-failed` when `dsh-job` is missing or errors.

---

### 3.8 `remote_cancel`

> "取消云端任务（杀掉整个进程组）。"
> — `src/tools.js:189`

**Parameters**

| Name | Type | Required | Default | Source |
|---|---|---|---|---|
| `jobId` | string | **yes** | — | `src/tools.js:193,196` |
| `host` | string | no | `defaultDevice` | `src/tools.js:194` |

**Return shape**

```jsonc
{
  "jobId": "mytool-1110-200651",
  "host": "aliyun",
  "cancelled": true,          // always true on success (literal)
  "message": "cancelled: mytool-1110-200651"  // stdout of dsh-job cancel, trimmed
}
```

`src/service.js:678`.

**What actually happens on the host** (`remote/dsh-job.sh:185-195`)

1. `status` is set to `cancelled` **before** signalling — so even if the kill fails,
   the job will never be reported as running again.
2. If `pid` is non-empty and alive: `kill -TERM -- -<pid>`, wait 2 s, then
   `kill -KILL -- -<pid>`. The negative pid targets the **process group**, so the
   whole `dsh` subtree dies.
3. Jobs that were still `queued` have **no `pid` file** — the worker checks
   `status == cancelled` before starting and exits immediately
   (`remote/dsh-job.sh:76-78`). Cancel therefore works pre-emptively.
4. ⚠ `cancelled:true` is unconditional — `dsh-job cancel` returns 0 even for a job
   whose process was already gone. A `job-not-found` is signalled through the
   runner's `die` and surfaces here as `cancel-failed`.

**Error modes** — `cancel-failed` (typically: job id unknown).

---

### 3.9 `remote_devices`

> "管理已绑定的云端设备（云服务器）…删除设备不会删除凭据。"
> — `src/tools.js:204-206`

**Parameters**

| Name | Type | Required | Default | Description (verbatim) | Source |
|---|---|---|---|---|---|
| `action` | string enum `list\|bind\|unbind\|setDefault\|sshCredentials` | **yes** | `"list"` (if omitted, `String(args.action ?? 'list')`) | see below | `src/tools.js:210-213, 226` |
| `name` | string | conditional | — | "设备名（字母数字-_），bind/unbind/setDefault 用。" | `src/tools.js:215` |
| `label` | string | no | `name` | "显示名，如「我的云主机 A」。" | `src/tools.js:216` |
| `credentialId` | string | **yes for `bind`** | — | "绑定的 SSH 凭据 id（从 sshCredentials 获取）。" | `src/tools.js:217` |
| `workRoot` | string | no | `""` | "云端工作根目录，留空则用 ~/dsh-work。" | `src/tools.js:218` |
| `note` | string | no | `""` | "备注。" | `src/tools.js:219` |

**Return shape per action**

```jsonc
// action:"list"  (src/tools.js:227-230 → src/devices.js:98-104)
{
  "defaultDevice": "aliyun",
  "devices": [
    {
      "name": "aliyun",                       // string — sanitised, lowercase
      "label": "我的云主机 A",                  // string
      "credentialId": "ssh-xxxxxxxxxxxx",     // string
      "workRoot": "",                          // string — stored but see caveat
      "project": "default",                    // string — stored but see caveat
      "note": "",                              // string
      "createdAt": "2026-11-10T12:00:00.000Z", // ISO string
      "updatedAt": "2026-11-10T12:05:00.000Z", // ISO string — absent on config-seeded rows
      "source": "config"                       // "config" | "user"
    }
  ]
}

// action:"sshCredentials"  (src/tools.js:231-233 → src/service.js:118-126)
{
  "credentials": [
    {
      "id": "ssh-xxxxxxxxxxxx",
      "name": "阿里云2H2C",
      "host": "203.0.113.10",
      "port": 22,
      "username": "root",
      "authMethod": "password",   // "password" | "key"
      "note": ""
    }
  ]
}

// action:"bind"  (src/tools.js:234-244)
{
  "device": { /* the upserted device, as above */ },
  "message": "设备「aliyun」已绑定到凭据 ssh-xxxxxxxxxxxx"
}

// action:"unbind"  (src/devices.js:152-164)
{ "removed": "aliyun", "defaultDevice": "tencent" }

// action:"setDefault"  (src/devices.js:167-174)
{ "defaultDevice": "aliyun" }
```

**`name` normalisation** — `trim → lowercase → [^a-z0-9._-]+ ⇒ '-' → strip edge '-'`
(`src/devices.js:27-31`). So `"Aliyun Prod"` becomes `"aliyun-prod"`.
On `bind`, `name` falls back to `label` (`src/devices.js:127`).
⚠ `remote_hosts`/`remote_dispatch` etc. resolve by the normalised name, so
`host:"Aliyun"` works (lowercased) but `host:"Aliyun Prod"` only works if a device
literally named `aliyun-prod` exists.

**`makeDefault` quirk** — the tool passes
`makeDefault: args.name ? undefined : true` (`src/tools.js:241`), i.e. **a bind with an
explicit `name` does not become default**; a bind without a name does. The registry
also promotes when there is no default at all (`src/devices.js:146`).

⚠ **`workRoot` and `project` are persisted but never consulted.**
`dispatch()` always builds `remoteRoot` as `${home}/dsh-work/${project}` from the
`project` *argument* (`src/service.js:449-453`); `entry.workRoot` / `entry.project`
are not read anywhere in `service.js`. Setting `workRoot: /data/jobs` has no effect
on where files land.

**Error modes** — `credential-required`, `invalid-name`, `unknown-device`,
`credential-*` (for `bind`, only if a probe is later attempted), and
`未知 action：<x>` (a plain `Error`, rendered without a code prefix,
`src/tools.js:251`).

**Example call**

```json
{ "action": "bind", "name": "aliyun", "label": "我的云主机 A", "credentialId": "ssh-xxxxxxxxxxxx", "note": "主力跑测试" }
```

**Example response**

```json
{
  "device": {
    "name": "aliyun",
    "label": "我的云主机 A",
    "credentialId": "ssh-xxxxxxxxxxxx",
    "workRoot": "",
    "project": "default",
    "note": "主力跑测试",
    "createdAt": "2026-11-10T12:00:00.000Z",
    "updatedAt": "2026-11-10T12:39:12.441Z",
    "source": "user"
  },
  "message": "设备「aliyun」已绑定到凭据 ssh-xxxxxxxxxxxx"
}
```

---

## 4. Host-side JavaScript API

`package.json` exports `.` (host entry) and `./client` (browser half)
(`package.json:8-12`).

### 4.1 Plugin module — `index.js`

```js
export const name = 'remote-dispatch'          // index.js:20
export const inject = ['tools', 'systemPrompt'] // index.js:23
export function apply(ctx, config)              // index.js:67
```

`apply` wires four things, each guarded:

| Wiring | Guard | Source |
|---|---|---|
| `DeviceRegistry` + `RemoteDispatchService` construction | always | `index.js:73-74` |
| `registerTools(ctx, service, settings)` | `ctx.inject(['tools'], …)` | `index.js:77-79` |
| `registerRpc(web, service, settings)` | `ctx.inject(['connection','webServer'], …)` — headless never gets it | `index.js:83-85` |
| System-prompt section | `settings.promptSummary` **and** `ctx.inject(['systemPrompt'])` inside `try/catch` | `index.js:89-113` |

### 4.2 `RemoteDispatchService` (`src/service.js`)

Constructor: `new RemoteDispatchService(ctx, settings, registry)` (`src/service.js:45-50`).
`ctx.credentials` is accessed through a `try` because cordis throws on un-injected
services (`src/service.js:172-180`).

| Method | Signature | Returns | Notes |
|---|---|---|---|
| `hostNames()` | `() => string[]` | configured keys | `src/service.js:53-55` |
| `deviceNames()` | `async () => string[]` | registry names, or config keys without a registry | `src/service.js:58-62` |
| `listSshCredentials()` | `async () => Array<{id,name,host,port,username,authMethod,note}>` | metadata only | Parses `.credentials.yaml` textually; only `type === 'ssh'` with a `host` survive (`src/service.js:116-117`) |
| `defaultDeviceName()` | `async () => string` | | `src/service.js:132-136` |
| `resolveHost(name)` | `async (name?) => {name, entry}` | falls back to default | `src/service.js:139-154` |
| `target(hostName)` | `async => SshTarget` | cached per name + JSON stamp of the entry | `src/service.js:157-169` |
| `readCredential(id)` | `async => normalized record` | live service first, file fallback | `src/service.js:172-204` |
| `readCredentialFile(id)` | `async => normalized record` | hand-rolled YAML subset | `src/service.js:207-330` |
| `normalizeRecord(id, rec)` | `=> {id,host,port,username,authMethod,password,privateKey}` | defaults `port:22`, `username:'root'`; `privateKey` present ⇒ `authMethod:'key'` | `src/service.js:333-347` |
| `home(hostName)` | `async => string` | **one extra SSH round-trip per call** — not cached | `src/service.js:350-356` |
| `probe(hostName)` | `async => probe object` | see §3.1 | `src/service.js:359-384` |
| `makeJobId(project)` | `=> string` | `<project>-MMDD-HHMMSS` | `src/service.js:387-392` |
| `safeProject(name)` | `=> string` | sanitised or `'default'` | `src/service.js:395-398` |
| `packDirectory(localDir)` | `async => {path, bytes, dir, cleanup}` | system `tar`, 300 s budget | `src/service.js:404-428` |
| `dispatch(input)` | `async => dispatch result` | see §3.2 | `src/service.js:441-534` |
| `uploadWithProgress(t, localPath, totalBytes, remotePath, report)` | `async` | 256 KiB chunks | `src/service.js:549-584` |
| `status(jobId, host)` | `async` | see §3.3 | `src/service.js:587-620` |
| `result(jobId, host)` | `async` | see §3.4 | `src/service.js:623-636` |
| `logs(jobId, host, lines=40)` | `async` | see §3.6 | `src/service.js:639-650` |
| `list(host)` | `async` | see §3.7 | `src/service.js:653-670` |
| `cancel(jobId, host)` | `async` | see §3.8 | `src/service.js:673-679` |
| `wait(jobId, host, timeoutMs)` | `async` | see §3.5 | `src/service.js:682-700` |

`dispatch(input)` accepts `{task, host?, project?, localDir?, continueSession?, jobId?,
onProgress?}`; `onProgress` receives `{phase, percent, detail, bytes?, total?}` and is
wrapped so a throwing sink cannot fail the dispatch (`src/service.js:455-461`).

### 4.3 `DeviceRegistry` (`src/devices.js`)

Constructor: `new DeviceRegistry(ctx, settings)`; `this.path` =
`<DSH_HOME>/storages/dsh-remote-dispatch/devices.json` (`src/devices.js:19-24, 41`).

| Method | Returns | Notes |
|---|---|---|
| `load()` | `Promise<doc>` | Cached in memory. If the file is missing/corrupt, **seeds from `settings.hosts`** with `source:'config'` and writes the file (`src/devices.js:46-80`). |
| `save(doc)` | `Promise<doc>` | Writes `devices.json.tmp` then `rename` (atomic on the same volume) (`src/devices.js:83-90`). |
| `invalidate()` | `void` | Drops the in-memory cache (`src/devices.js:93-95`). |
| `list()` | `{defaultDevice, devices[]}` | Devices sorted by `name.localeCompare` (`src/devices.js:98-104`). |
| `resolve(name?)` | `entry` | Throws `unknown-device` (`src/devices.js:107-120`). |
| `upsert(input)` | `device` | See fields above (`src/devices.js:126-149`). |
| `remove(name)` | `{removed, defaultDevice}` | Reassigns default to the first remaining name (`src/devices.js:152-164`). |
| `setDefault(name)` | `{defaultDevice}` | `src/devices.js:167-174`. |

`normalizeDeviceName(name)` is exported for direct use (`src/devices.js:27-31`).

### 4.4 SSH transport (`src/ssh.js`)

| Export | Signature | Notes |
|---|---|---|
| `RemoteError` | `new RemoteError(code, message)` | `src/ssh.js:45-50` |
| `runProcess` | `(command, args, options, timeoutMs=120000, input?) => Promise<{code,stdout,stderr}>` | Output capped at `MAX_OUTPUT = 200_000` chars per stream (`src/ssh.js:19, 135-140`). Timeout ⇒ `SIGKILL` + `RemoteError('timeout')` (`src/ssh.js:128-133`). |
| `shellQuote` | `(value) => string` | Single-quote wrapping with `'\''` escaping (`src/ssh.js:165-167`). |
| `SshTarget` | `new SshTarget(record, options)` | See below. |

`SshTarget` members: `label` getter → `` `${username}@${host}:${port}` `` (`src/ssh.js:183-185`);
`baseArgs(extra)` (`:188-203`); `auth()` (`:206-228`); `exec(cmd, timeoutMs?)` (`:235-245`);
`execWithStdin(cmd, data, timeoutMs?)` (`:252-261`); `startStdin(cmd, timeoutMs?)` (`:273-352`);
`download(remotePath, timeoutMs?)` (`:355-365`, **`cat -- <path>`, never called by the service**).

**SSH options always applied** (`src/ssh.js:190-200`):

```
-o BatchMode=no
-o StrictHostKeyChecking=accept-new
-o ServerAliveInterval=15
-o ServerAliveCountMax=4
-o ConnectTimeout=15
-o LogLevel=ERROR
-o PreferredAuthentications=<publickey | publickey,password,keyboard-interactive>
-p <port>
```

**Auth strategy**

- **Key**: private key written to a `mkdtemp` directory (`os.tmpdir()/dsh-remote-key-*`)
  with mode `0600`, passed as `-i <path> -o IdentitiesOnly=yes`, and the directory is
  `rm -rf`'d in a `finally` after every command (`src/ssh.js:211-219, 242-244`).
- **Password**: an askpass helper. On POSIX it is `askpass.sh` (mode `0700`) that
  `printf`s `$DSH_REMOTE_ASKPASS` (`src/ssh.js:41-43, 80-85`); on Windows it is a C#
  program compiled once to `askpass.exe` with `csc.exe` (`src/ssh.js:25-39, 87-104`).
  The password is passed **as an environment variable**, with
  `SSH_ASKPASS_REQUIRE=force` and a synthetic `DISPLAY=:0` when unset
  (`src/ssh.js:221-227`).

Because every `exec()` calls `auth()` afresh, an SSH connection is established **per
command** — there is no connection multiplexing (`src/ssh.js:235-245`).

---

## 5. Browser ⇄ Host RPC

Route prefix `RPC_CHANNEL = '/remote-dispatch'` (`src/rpc.js:20`), registered on the
host web server as `{kind:'prefix', path:'/remote-dispatch'}` (`src/rpc.js:253-256`).

**Admission** — `web.connection.admit(req)`; a `rejection` value is returned verbatim
as the HTTP status with a plain-text body (`unauthorized` for 401, else `forbidden`)
(`src/rpc.js:208-222`). Anything that is not `POST` with exactly one path segment is
**405** (`src/rpc.js:226-230`). Unknown endpoints are **404** JSON
(`src/rpc.js:232-236`). Bodies are limited to 1 MiB (`src/rpc.js:22, 46`).

| Endpoint | Request | Response |
|---|---|---|
| `hosts` | `{}` | `{defaultHost, defaultDevice, hosts:[{name,label}], devices:[{…device, ssh:{host,port,username,authMethod}\|{error}}], maxUploadMb}` (`src/rpc.js:70-90`) |
| `credentials` | `{}` | `{credentials:[…]}` (`src/rpc.js:93-96`) |
| `saveDevice` | device fields | `{device}` (`src/rpc.js:99-103`) |
| `removeDevice` | `{name}` | `{removed, defaultDevice}` (`src/rpc.js:106-110`) |
| `setDefaultDevice` | `{name}` | `{defaultDevice}` (`src/rpc.js:113-117`) |
| `probe` | `{host?}` | `{hosts:[{name,label,…probe}]}` (`src/rpc.js:119-132`) |
| `status` | `{jobId, host?}` | status object (`src/rpc.js:176-180`) |
| `result` | `{jobId, host?}` | result object (`src/rpc.js:182-186`) |
| `list` | `{host?}` | list object (`src/rpc.js:188-191`) |
| `cancel` | `{jobId, host?}` | cancel object (`src/rpc.js:193-197`) |
| `logs` | `{jobId, host?, lines?}` | logs object (`src/rpc.js:199-203`) |
| **`push`** | `{task, host?, project?, localDir?, continueSession?}` | **NDJSON stream** (`src/rpc.js:140-174`) |

**`push` stream framing** — `content-type: application/x-ndjson`, `x-accel-buffering: no`:

```jsonl
{"type":"progress","phase":"connecting","percent":0,"detail":"连接 aliyun"}
{"type":"progress","phase":"uploading","percent":47,"detail":"上传中 3.25 / 6.50 MB","bytes":3407872,"total":6815744}
{"type":"done","result":{ …the dispatch() return object… }}
```

or, on failure, a final `{"type":"error","error":{"code","message"}}`
(`src/rpc.js:151-173`). ⚠ If writing a progress line fails (browser gone) the error is
swallowed and **the dispatch keeps running** (`src/rpc.js:151-157`).

⚠ `push` does not accept a `jobId` even though the service supports it
(`src/rpc.js:160-167`).

---

## 6. Cloud-side runner CLI (`dsh-job`)

Installed from `remote/dsh-job.sh`. Four environment variables are baked in at deploy
time via placeholders:

| Var | Placeholder | Default when unset | Source |
|---|---|---|---|
| `DSH_JOB_ROOT` | `__JOB_ROOT__` | literally `__JOB_ROOT__` | `remote/dsh-job.sh:20` |
| `DSH_BIN` | `__DSH_BIN__` | literally `__DSH_BIN__` | `:21` |
| `DSH_PROFILE` | — | `headless` | `:22` |
| `KEY_ENV_FILE` | `__KEY_ENV__` | literally `__KEY_ENV__` | `:23` |

⚠ **If you install the script without replacing the placeholders it will still run**,
creating a directory named `__JOB_ROOT__` in `$HOME` and failing at the `dsh` call.
There is no placeholder validation.

**Commands**

| Command | Args | Behaviour | Source |
|---|---|---|---|
| `submit` | `<job-id> <workdir> <task-file> [--session <sid>]` | Creates `mkdir -p <workdir>`, refuses if the job dir exists, writes `task.md`/`status=queued`/`meta.json`, then `setsid nohup "$0" __worker … >>run.log 2>&1 < /dev/null &`. Prints `submitted: <id> (workdir=<wd>)`. | `:38-65` |
| `__worker` | `<job-id> <wd> <session>` | Internal. Takes `flock` on `$DSH_JOB_ROOT/.queue.lock`, honours a pre-set `cancelled`, writes `running`+`pid`, sources `KEY_ENV_FILE`, prepends `dirname $DSH_BIN` to `PATH`, runs `dsh --profile headless --json [--session-id <sid>] - < task.md` with cwd `$wd`, captures `events.jsonl`/`err.log`, extracts the session id and the final text, then sets `done`/`failed`. | `:68-150` |
| `status` | `<job-id>` | Human-readable multi-line dump (id/status/pid/meta/loglines/result). Unused by the plugin. | `:153-165` |
| `tail` | `<job-id> [lines=40]` | `run.log` tail + last 20 stderr lines. Unused by the plugin. | `:167-174` |
| `result` | `<job-id>` | `cat result.md`; warns on stderr when still queued/running. Unused. | `:176-183` |
| `cancel` | `<job-id>` | Sets `cancelled`, TERM then KILL the process group. Prints `cancelled: <id>`. | `:185-195` |
| `list` | — | `printf '%-28s %-10s %s\n' ID STATUS SUBMITTED` then one row per dir. | `:197-207` |
| `wait` | `<job-id> [timeout=3600]` | Polls every 5 s; prints the terminal state and returns 0, or prints `timeout` and returns **1**. | `:210-221` |
| `unpack` | `<job-id> <dest> <tarball>` | `tar -xzf` with a `.tar` fallback. Unused (the dispatcher unpacks inline). | `:224-232` |

Unknown subcommand ⇒ usage on stderr, exit 2 (`:244`).
`die()` writes `ERROR: …` to stderr and exits 1 (`:29`). The script is
`set -uo pipefail` — **note the absence of `-e`**, so individual failures do not abort
the worker (`:18`).

---

## 7. Plugin configuration schema

`resolveSettings()` (`index.js:30-60`) normalises the `cordis.patch.yml` row. There is
no Schemastery schema; unknown keys are ignored and bad types fall back.

| Key | Type | Default | Clamp | Source |
|---|---|---|---|---|
| `hosts` | `{[name]: {credentialId, label?}}` | `{}` | Entries without a non-empty `credentialId` are **silently dropped**; `label` defaults to the key | `index.js:34-45` |
| `defaultHost` | string | first key of `hosts` | Trimmed; empty ⇒ first key | `index.js:47-50` |
| `promptSummary` | boolean | `true` | Only `false` disables | `index.js:55` |
| `commandTimeoutMs` | number | `120000` | `[10_000, 600_000]` | `index.js:56` |
| `waitTimeoutMs` | number | `3_600_000` | `[30_000, 21_600_000]` | `index.js:57` |
| `maxUploadMb` | number | `200` | `[1, 2048]` | `index.js:58` |

With zero hosts the plugin still loads and logs a warning; the prompt section renders
as an empty string (`index.js:69-71, 97`).

---

## 8. On-disk formats

### 8.1 Harness side

```
<DSH_HOME>/storages/dsh-remote-dispatch/
├── devices.json        device registry (src/devices.js:23)
├── devices.json.tmp    transient, renamed over devices.json (src/devices.js:86-87)
├── askpass.sh          POSIX askpass helper, mode 0700 (src/ssh.js:81-84)
├── askpass.cs          Windows C# source (src/ssh.js:101-102)
└── askpass.exe         Windows compiled helper (src/ssh.js:87-104)
```

`DSH_HOME` resolution is identical in all four places: `DSH_HOME`, else
`$USERPROFILE`/`$HOME` + `/.dsh` (`src/devices.js:20-22`, `src/ssh.js:53-55`,
`src/service.js:69-71, 208-210`).

Transient, outside `DSH_HOME`:

- `os.tmpdir()/dsh-remote-pack-*/payload.tar.gz` — the upload archive, removed in a
  `finally` (`src/service.js:414-415, 488-490`).
- `os.tmpdir()/dsh-remote-key-*/id` — the 0600 private key, removed in a `finally`
  (`src/ssh.js:213-217, 242-244`).

### 8.2 Cloud side

```
$HOME/
├── dsh-work/<project>/          # job cwd; uploaded sources land here
└── dsh-jobs/
    ├── .queue.lock              # host-wide flock
    └── <jobId>/
        ├── task.md              # verbatim task text (remote/dsh-job.sh:55)
        ├── status               # queued|running|done|failed|cancelled, no newline
        ├── meta.json            # {"id","workdir","session","submitted_at","host"}
        ├── pid                  # worker pid, string (remote/dsh-job.sh:81)
        ├── events.jsonl         # full dsh --json event stream
        ├── result.md            # extracted final text
        ├── run.log              # runner log, append-only
        └── err.log              # dsh stderr, overwritten per run
```

Transient on the cloud: `/tmp/_dshpush-<jobId>.tar.gz` (removed at `:481`) and
`/tmp/_dshtask-<jobId>.md` (removed after a successful submit at `:518`; **leaked if
submit fails**, `src/service.js:515-521`).

`meta.json` is emitted by a `cat > … <<EOF` heredoc with values written raw
(`remote/dsh-job.sh:57-59`) — a `workdir` or `session` containing `"` or `$` would
produce invalid JSON. In practice `workdir` is derived from the sanitised project name
and `session` is a UUID, so this is theoretical.

---

## 9. Limits and constants

| Constant | Value | Where | Effect |
|---|---|---|---|
| `MAX_OUTPUT` | 200 000 chars / stream | `src/ssh.js:19` | stdout & stderr are silently truncated past this. |
| Upload chunk | 256 KiB | `src/service.js:550` | progress granularity. |
| Progress throttle | 120 ms | `src/service.js:564` | UI flush rate. |
| Upload bar range | 5 % – 92 % | `src/service.js:556-557` | leaves room for unpack/submit. |
| `tar` budget | 300 s | `src/service.js:421` | packing a huge tree times out ⇒ `pack-failed`/`timeout`. |
| Unpack budget | `max(commandTimeoutMs, 600_000)` | `src/service.js:482` | always ≥ 10 min. |
| `dsh-job wait` allowance | `budget + 120_000` ms | `src/service.js:686-689` | local ssh timeout for waiting. |
| `logs` line range | 1 – 2000 for run.log; stderr fixed 40 | `src/service.js:644, 647` | |
| `waitTimeoutMs` clamp | 30 s – 6 h | `index.js:57` | |
| RPC body cap | 1 MiB | `src/rpc.js:22` | |
| Job lock | one per host | `remote/dsh-job.sh:24, 73-74` | strict serial execution. |
| `wait` poll interval | 5 s | `remote/dsh-job.sh:219` | |
| `cancel` TERM→KILL delay | 2 s | `remote/dsh-job.sh:191` | |
| Job-id column width (`list`) | 28 chars | `remote/dsh-job.sh:198` | cosmetic; longer ids still print, shifted. |
