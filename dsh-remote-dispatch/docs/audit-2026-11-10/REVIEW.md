# dsh-remote-dispatch — Code Review & Security Audit

| | |
|---|---|
| **Plugin** | `dsh-remote-dispatch` v0.1.0 (`C:\Users\you\plugins\DSH-Plugin\dsh-remote-dispatch`) |
| **Scope** | `index.js`, `client.js`, `package.json`, `cordis.patch.yml`, `src/*`, `remote/dsh-job.sh` — 3,107 lines, all read in full |
| **Audit date** | 2026-11-10 |
| **Method** | Static review only. Source was **not modified**. Claims marked *(verified)* were checked empirically in this session (see evidence in each finding). |
| **Threat model** | (1) an attacker who controls *remote* host output or a *remote* host, (2) the untrusted / prompt-injectable LLM agent driving these tools, (3) a remote attacker who can reach the DSH web port, (4) accidental destruction from ordinary misuse. |

---

## 1. Architecture map

### 1.1 Modules and entry points

| File | Lines | Role | Entry point |
|---|---|---|---|
| `index.js` | 116 | Host plugin manifest; `resolveSettings()` normalises `cordis.patch.yml`; wires registry + service; injects `tools`, `connection`+`webServer`, `systemPrompt` | `export const name`, `inject`, `apply(ctx, config)` |
| `src/devices.js` | 175 | `DeviceRegistry` — JSON device store at `$DSH_HOME/storages/dsh-remote-dispatch/devices.json`; seeded from config `hosts` on first load | `DeviceRegistry.{load,save,list,resolve,upsert,remove,setDefault}` |
| `src/service.js` | 701 | All business logic: credential resolution (live service, else hand-rolled YAML parser), SSH target cache, packaging, upload, `dsh-job` submit, status/result/logs/list/cancel/wait | `RemoteDispatchService.*` |
| `src/ssh.js` | 366 | OpenSSH transport via `spawn('ssh', argv)`; askpass helper (`.NET`/`sh`), temp 0600 key file, output-capped `runProcess`, `shellQuote` | `SshTarget.{exec,execWithStdin,startStdin,download}`, `runProcess`, `shellQuote` |
| `src/tools.js` | 254 | 9 agent tool definitions (thin wrappers) | `registerTools(ctx, service, settings)` |
| `src/rpc.js` | 257 | HTTP surface on the DSH web server, prefix `/remote-dispatch`, 12 endpoints, `push` streams NDJSON | `registerRpc(web, service, settings)` |
| `client.js` | 706 | Web-client half (`window.__ModuleLoader__`): composer 「推送 云」 button + 设置→云端派发 device manager | `loader.load({id, factory})` |
| `remote/dsh-job.sh` | 245 | On-host job runner: `submit/__worker/status/tail/result/cancel/list/wait/unpack` | `$1` subcommand dispatch (L234–245) |

### 1.2 Tool surface (agent-visible)

| Tool | Service call | Destructive? |
|---|---|---|
| `remote_hosts` | `probe()` — one SSH exec per host | no |
| `remote_dispatch` | `dispatch()` — pack, upload, `tar -x`, `dsh-job submit` | **writes remote workdir, overwrites files** |
| `remote_status` / `remote_result` / `remote_logs` / `remote_list` / `remote_wait` | read-only remote commands | no |
| `remote_cancel` | kills the whole remote process group | yes |
| `remote_devices` | rewrite `devices.json`, bind/unbind | yes (local state) |

### 1.3 Data flow

```
                       LOCAL (Windows host)                          │            REMOTE (aliyun / tencent)
                                                                     │
  LLM tool call ─┐                                                   │
  Browser fetch ─┼─► tools.js wrap() / rpc.js handler                │
  (POST /remote- │        │                                           │
   dispatch/push)│        ▼                                           │
                 │  RemoteDispatchService                              │
                 │   ├─ resolveHost() ──► DeviceRegistry (devices.json)│
                 │   ├─ target()      ──► readCredential()            │
                 │   │       ├─ ctx.credentials.readRecord(scope/id)  │
                 │   │       └─ fallback: hand-parsed .credentials.yaml (full plaintext secrets)
                 │   │                  └─► SshTarget(record)         │
                 │   ├─ home()        ──► ssh 'printf %s "$HOME"' ────┼─► $HOME
                 │   ├─ packDirectory()  local `tar -czf … -C dir .`  │
                 │   ├─ uploadWithProgress()                          │
                 │   │    ssh 'cat > /tmp/_dshpush-<job>.tar.gz' ◄────┼── 256 KiB chunks on stdin
                 │   ├─ ssh 'mkdir -p ROOT && tar -xzf /tmp/… -C ROOT'┼─► **extraction, no safety checks**
                 │   ├─ sshWithStdin 'cat > /tmp/_dshtask-<job>.md'   │
                 │   └─ ssh 'dsh-job submit <job> <root> <task> [--session]'
                 │                                        │           │
                 │                                        └───────────┼─► dsh-job.sh submit → setsid nohup __worker
                 │                                                    │        │ flock .queue.lock (serial)
                 │                                                    │        ▼
                 │                                                    │   dsh --profile headless --json → events.jsonl
                 │                                                    │        └── python3 → result.md
                 │  status()/result()/logs()/wait()/cancel() ◄────────┼── dsh-job status|result|tail|wait|cancel
                 │        (untrusted text parsed with regex / includes('__MISSING__'))
                 ▼                                                    │
            tool result  ──► LLM context (untrusted remote text is treated as data only — see REV-08)
```

### 1.4 HTTP surface (`src/rpc.js`)

All endpoints are `POST /remote-dispatch/<name>`, gated by `web.connection.admit(req)` (L211) and then dispatched by table lookup (L232). Endpoints: `hosts, credentials, saveDevice, removeDevice, setDefaultDevice, probe, push (streaming), status, result, list, cancel, logs`. **There is no CSRF token, no per-action authorisation, and no body key allow-list** — `saveDevice` forwards the whole request body into `registry.upsert` (REV-11).

---

## 2. Findings table

| ID | Sev | File:line | Summary |
|---|---|---|---|
| REV-01 | **Critical** | `src/service.js:396,449–453,475,478–483` + `remote/dsh-job.sh:26,31,49,199` | Unsanitised path components (project name, `$HOME`) reach unquoted/`rm`-adjacent shell; `tar -xzf` extracts attacker-controllable archives *into* the target tree → remote code execution |
| REV-02 | High | `src/service.js:591,627,643,498,676,687` (+`rpc.js:176–203`) | `jobId` / `continueSession` never validated; `..` traversal reads arbitrary remote files into the LLM context |
| REV-03 | High | `src/ssh.js:191–192` | `StrictHostKeyChecking=accept-new` → undetected MITM; with password auth the credential is handed to the impostor |
| REV-04 | High | `src/ssh.js:215,222`; `src/service.js:317,344–345`; `remote/dsh-job.sh:73` | Secrets in `process.env` of a long-lived child; ssh multiplexing/agent-forwarding env inherited from the Host process |
| REV-05 | Medium | `src/service.js:603,627–631` + `src/ssh.js:19,136–140` | Remote text trusted as protocol (`__MISSING__`, `__RC=`, `META=`, `STATE=`) and results silently **head-truncated at 200 KB** |
| REV-06 | Medium | `src/service.js:452` | jobId "sanitised" by replacing chars with `-` → silent collisions/overwrites; no strict `[A-Za-z0-9._-]+` validation |
| REV-07 | Medium | `src/service.js:126–129` | `listSshCredentials` regex-parses the plaintext credential file → **false-positive credential list** (privateKey PEM shown as an SSH host) |
| REV-08 | Medium | `src/rpc.js:99–117` | State-changing HTTP endpoints use the unauth-CORS-writable `content-type: application/json` request instead of a JSON-only content type + CSRF token |
| REV-09 | Medium | `src/service.js:471–483` | Upload-too-large is detected **after** the whole local dir is packed; `/tmp` and `~/dsh-jobs` grow without bound |
| REV-10 | Medium | `remote/dsh-job.sh:57–59,139` | `meta.json` built by string interpolation; task text / workdir with `"` produce invalid JSON that silently degrades to `{}` |
| REV-11 | Medium | `src/rpc.js:99–103` → `src/devices.js:139,126–149` | `workRoot` accepted/stored but **never used**; `project` from HTTP unvalidated; device key = `normalizeDeviceName` can silently overwrite another device |
| REV-12 | Low | `remote/dsh-job.sh:62–63,81,158,187–192` | worker pid written only *after* acquiring the global flock → `cancel` of a queued job cannot kill it; stale pid → `kill -0` false "alive"; `kill -- -pid` targets the *worker's* group |
| REV-13 | Low | `remote/dsh-job.sh:99–100,141–149` | `setsid` job can be killed remotely; `dsh` killed by SIGTERM leaves `events.jsonl` partial and status `failed`, task file already deleted |
| REV-14 | Low | `src/ssh.js:128–133` | Timeout/`close` race double-settles; timeout error discards partial stdout/stderr and exit code |
| REV-15 | Low | `src/service.js:480` | `tar -xzf … && rm -f …` — an extraction failure leaves the tarball and the partial tree |
| REV-16 | Low | `src/service.js:69–129`, `src/devices.js:19–24`, `src/ssh.js:52–57` | Same `$HOME` fallback copy-pasted three times; DRY/consistency smell |
| REV-17 | Nit | `src/ssh.js:205–228,235` | `auth()` builds a full `{...process.env}` snapshot per exec |
| REV-18 | Nit | `client.js:406,410` | Literal `C:\\Users\\…` in placeholder string |
| REV-19 | Nit | `src/tools.js:46–52` | `wrap()` discards `RemoteError.code` (only `code:` prefix survives in the message) |
| REV-20 | Nit | `src/service.js:157–169` | `target()` caches on `JSON.stringify(entry)`; `password`/key live in the heap for process lifetime |

### Non-issues (checked, deliberately not raised as findings)

- **`shellQuote` correctness.** `src/ssh.js:165–167` is the canonical `'…'\''…'` form *(verified by hexdump)*. `jobId`, `remoteRoot`, `remoteTar`, `remoteTask`, `session`, paths, and the credential-derived `username@host` are all passed as **argv** (`shell:false`) and are not shell-expanded. No command-injection sink was found in the *quoting*; the real problems are elsewhere (REV-01, REV-02).
- **`--exclude` placement.** `-czf archive …excludes -C dir .` works with bsdtar 3.8.9 *(verified)* — `sub/node_modules` was correctly excluded by a bare name pattern.
- **Temp-file ACLs.** `%TEMP%` on this host grants only `SYSTEM`, `Administrators`, `ADIL\you` *(verified)*, so the `0600` private-key file at `src/ssh.js:213–216` is not readable by other interactive users → demoted to a note inside REV-04, not its own finding.
- **`dsh-job` PATH hijack.** `remote/dsh-job.sh:90` prepends `dirname $DSH_BIN` to `PATH`. Low: the local side never runs `dsh-job.sh`; it arrives over the same SSH channel it would attack.
- **`git`/auth header leakage.** No secrets are ever placed in argv (verified: password goes via `SSH_ASKPASS` env, key via `-i <tempfile>`). `ps`-based disclosure is a non-issue.
- **`$(…)` inside double quotes in `status()`** (L594–598) is intentional command substitution and is fed already-quoted paths.
- **`rpc.js:248` returns HTTP 200 with `{ok:false}`** — unconventional, but the client checks `body.ok` (`client.js:170`), so it is cosmetic.

---

### REV-01 — Critical — Unsanitised path parts + unsafe `tar -xzf` ⇒ **remote code execution**

**Where:** `src/service.js:394–398` (`safeProject`), `:449–453` (`project`/`jobId` join `${home}/dsh-work/${project}`), `:475`, `:478–483` (extract), `remote/dsh-job.sh:26` (`mkdir -p "$DSH_JOB_ROOT"`), `:31` (`job_dir`), `:49` (`mkdir -p "$wd"`), `:199–206` (`cmd_list` glob).

**What is wrong.**
1. **`safeProject()` does not reject `..`** *(verified in Node: `safeProject("..") === ".."`, while `"a/../.."` → `"a-..-.."`)*. Only `^[-]+|[-]+$` is trimmed, so the literal `..` survives and `remoteRoot = $HOME/dsh-work/..` resolves to `$HOME`. `"a/../.."` → `a-..-..` is inert as a *single* segment, but the *remote* shell still `cd`s into `$HOME/dsh-work/a-..-..`, and the HTTP `project` field (`rpc.js:163`) is unbounded in length and content. `project` is directly agent/attacker controlled; `localDir`'s contribution is only via `basename(resolve(...))`, which is a safe single segment.
2. `$HOME` from `service.js:352` is interpolated into `remoteRoot` and later into `mkdir -p`/`tar -C`/`rm -f` **after** `shellQuote` — so quoting holds — **but** the same string reaches `dsh-job.sh` as `$wd`, where it is used unquoted in *two* places: `cmd_submit` L49 `mkdir -p "$wd"` is safe, while `cmd_worker` L99 `cd "$wd"` is safe; **however `cmd_list` L199 `for d in "$DSH_JOB_ROOT"/*/`** will happily list into any directory that `${DSH_JOB_ROOT}` was mis-pointed at. The decisive sink is extraction.
3. **`tar -xzf <archive> -C <root> --no-same-owner`** (`service.js:480`) and `dsh-job.sh:228` unpack **whatever the remote already holds at `/tmp/_dshpush-<jobId>.tar.gz`**. `jobId` is predictable (`makeJobId`, `service.js:387–392` = `<project>-MMDD-HHMMSS`) and lives in a **world-writable `/tmp`**. Any local unprivileged user on the cloud box can pre-create `/tmp/_dshpush-<jobId>.tar.gz` as a **symlink** to a file they control; GNU tar will follow it on open for reading, and the archive can contain `../../.ssh/authorized_keys`, `~/.bashrc`, or a `cron.d` drop. Because extraction targets `remoteRoot` inside `$HOME`, traversal entries land in the operator's home where the *next* `dsh` run (which executes with the operator's model key) picks them up.
4. `service.js:475`/`:509` also let two concurrent dispatches with the same `project`+timestamp share the same `/tmp` path.

**Impact.** Full RCE as the cloud user, and a pathway from *local unprivileged cloud user* → *DSH operator account* → *model API key* (`.env.headless`). Combined with REV-02 this is reachable from a single prompt-injected tool call.

**Fix sketch.**

```js
// service.js — strict allow-list, no silent mangling
const SEG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
function safeSegment(name, label) {
  const s = String(name ?? '')
  if (!SEG.test(s) || s === '.' || s === '..') {
    throw new RemoteError('invalid-name', `${label} 只能包含字母数字 . _ -，且不能是 . 或 ..`)
  }
  return s
}

// per-dispatch private remote dir, mode 700, unpredictable
const remoteDir = '$(mktemp -d "$HOME/.dsh-push.XXXXXXXX")'   // resolved remotely
// …upload to $remoteDir/payload.tar.gz …
const up = await t.exec(
  `set -e; ` +
  `mkdir -p ${shellQuote(remoteRoot)}; ` +
  `tar -xzf ${shellQuote(remoteTar)} -C ${shellQuote(remoteRoot)} ` +
  `  --no-same-owner --no-same-permissions ` +
  `  --anchored --wildcards-exclude='*' 2>/dev/null || true; ` +   // see note
  `rm -f ${shellQuote(remoteTar)}`
)
```

Practical hardening for extraction (choose one, both preferred):

```bash
# (a) verify every entry stays inside the root, reject absolute/.. /symlink targets
tar -tzf "$arc" | grep -Ev '^(\./)?([^/]+/)*[^/]+$' && die "unsafe archive"
# (b) extract into a staging dir on the same FS, then rsync --safe-links
```

Also: create `/tmp/_dshpush-*` with `umask 077` **and** verify with `[[ -f && ! -L ]]` before extracting; better, stop using `/tmp` entirely and stream the tar straight into `tar -xz -C "$root"` over stdin (the code already has `startStdin`, `ssh.js:273`), which removes the on-disk temp file from the attack surface.

---

### REV-02 — High — `jobId` / `continueSession` are never validated ⇒ remote file disclosure

**Where:** `src/service.js:591` (`status`), `:627` (`result`), `:643` (`logs`), `:498` (`continueSession`), `:676` (`cancel`), `:687` (`wait`); HTTP mirrors `src/rpc.js:176–203`; tool schemas `src/tools.js:112–118` declare `jobId` as a plain `string`.

**What is wrong.** Every one of these builds `${home}/dsh-jobs/${jobId}/result.md` (or `meta.json`, `run.log`, `err.log`) and `shellQuote`s the result. **Quoting prevents shell injection but not path traversal**: `jobId = "../../.aws/credentials"` yields `$HOME/dsh-jobs/../../.aws/credentials/result.md`… which fails, but `jobId = "x/../../../../etc"` combined with suffix-free paths such as `cmd_cancel`'s `dsh-job cancel '<jobId>'` (L676) and `cmd_wait`'s argument (L687) reach `job_dir()` → `[[ -d "$DSH_JOB_ROOT/$1" ]]` and, for `cancel`, `printf 'cancelled' > "$d/status"` — **an arbitrary-directory file write/create**. The `result()` sink is the most dangerous for exfiltration: `cat '<home>/dsh-jobs/<jobId>/result.md'`. Choosing `jobId = "../../../../home/you"` (or any dir that contains a readable `result.md`) turns `remote_result` into a *read arbitrary file* primitive; `logs()` behaves the same for any `run.log`/`err.log`. `continueSession` (`:498`) reads `…/<continueSession>/meta.json` and the matched `"session"` value is then passed verbatim into `dsh --session-id` on the cloud — so a crafted `meta.json` anywhere readable also lets an attacker **choose or hijack the resumed session id** (session fixation across jobs).

**Impact.** Disclosure of any remote file that ends in `result.md`/`meta.json`/`run.log`/`err.log`, straight into the LLM context (from where it can be exfiltrated by the model). With the traversal-capable `cancel`/`wait`, also arbitrary-directory creation and directory-existence oracles. The task brief's explicit requirement — jobId must be strictly `[a-zA-Z0-9._-]+` — is unmet.

**Fix sketch.**

```js
// service.js — one choke point, used by every public method
const JOB_ID = /^[A-Za-z0-9._-]{1,64}$/
function assertJobId(id) {
  if (typeof id !== 'string' || !JOB_ID.test(id) || id === '.' || id === '..' || id.includes('..')) {
    throw new RemoteError('invalid-job-id', `非法 jobId：${JSON.stringify(String(id)).slice(0, 80)}`)
  }
  return id
}

async result(jobId, host) {
  jobId = assertJobId(jobId)          // ← add in status/result/logs/cancel/wait/continueSession
  ...
}
```

and declare it in the schema as well (`tools.js`): `jobId: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' }`, so the model is told early. Belt and braces: on the host side, `job_dir()` in `dsh-job.sh` should `[[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || die` before it is ever used.

---

### REV-03 — High — `StrictHostKeyChecking=accept-new` defeats host-key verification

**Where:** `src/ssh.js:191–192`.

**What is wrong.** `accept-new` silently trusts *any* key presented on first connection and keeps trusting a *changed* key only if it was never recorded. A first-time target (a freshly provisioned VPS, or the very first `probe` after `remote_devices bind`) is therefore indistinguishable from an impostor. Combined with `src/ssh.js:222` — the password is exported as `DSH_REMOTE_ASKPASS` in the child env and handed to whatever the far end asks for — an on-path attacker obtains the SSH password in cleartext-for-the-session.

**Impact.** Credential theft and full control of the "cloud" the task is dispatched to; the task text (which routinely contains the operator's proprietary code and instructions) is delivered to the attacker.

**Fix sketch.**

```js
const KNOWN = join(helperDir(), 'known_hosts')          // dedicated file, not ~/.ssh
const args = [
  '-o', `UserKnownHostsFile=${KNOWN}`,
  '-o', 'StrictHostKeyChecking=yes',                    // require pinning
  ...
]
```

with an explicit, user-approved trust-on-first-use step in `remote_devices bind`: run `ssh-keyscan` → show the fingerprint → store on confirm. Never `accept-new` inside an automated dispatcher.

---

### REV-04 — High — Secret handling: secrets in long-lived child env, inherited ssh config/agent

**Where:** `src/ssh.js:208` (`const env = { ...process.env }`), `:222` (`env[ASKPASS_VAR] = r.password ?? ''`), `:278` (`spawn('ssh', args, { env })`); `src/service.js:317,344–345` (password + `privateKey` live on the `SshTarget` record); `remote/dsh-job.sh:73` (`exec 9>"$LOCK"` + `flock 9` inherited by the DSH child).

**What is wrong.**
1. `auth()` clones the **entire** Host environment into every `ssh` child: `SSH_AUTH_SOCK` (agent forwarding to an untrusted cloud box if the remote config enables `ForwardAgent`), `SSH_CONFIG`/`GIT_SSH_COMMAND`, `LD_PRELOAD`/`NODE_OPTIONS` inherited from whatever launched DSH.
2. The **password** is placed in the child's environment for the whole SSH session (`startStdin` keeps the process alive for minutes during a large upload). On Windows a process's environment block is readable by the same user (`ReadProcessMemory`/`NtQueryInformationProcess`); on Linux by root/`ptrace` scope. `%TEMP%` ACLs on this host are tight *(verified)*, which is why the key file is *not* a separate finding — but the env block has no such protection.
3. The vault record (including `privateKey`) is retained on `SshTarget` and memoised in `this.cache` (`service.js:167–168`) for the process lifetime with no TTL and no wipe.

**Impact.** Any same-user malware, any subprocess that inherits the env (all tools spawned by DSH share `process.env` unless filtered), and agent-forwardable keys leak the operator's SSH identity. Not remotely exploitable, but this is the plugin's single largest secret-bearing surface.

**Fix sketch.**

```js
function minimalEnv(extra = {}) {
  const keep = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP',
                'HOME', 'USERPROFILE', 'LANG', 'LC_ALL']
  const env = {}
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k]
  return { ...env, ...extra }
}

async auth() {
  ...
  const env = minimalEnv({ [ASKPASS_VAR]: r.password ?? '', SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0' })
  env.SSH_AUTH_SOCK = ''                       // no agent to the cloud
  ...
}
```

And wrap `runProcess`/`startStdin` with an explicit `ssh -o ForwardAgent=no -o ForwardX11=no -F /dev/null` (or `-F` a generated empty config) so `~/.ssh/config` cannot re-enable forwarding. Wipe `auth.env[ASKPASS_VAR]` in the `finally` block (`fill(0)`-style) after `close`.

---

### REV-05 — Medium — Untrusted remote output trusted as protocol; long results silently truncated

**Where:** sentinels `src/service.js:600` (`__MISSING__`), `:627–631` (`__RC=`), `:603` (`^KEY=(.*)$`); length cap `src/ssh.js:19` (`MAX_OUTPUT = 200_000`), `:135–140`.

**What is wrong.**
1. `result()` strips `__RC=\d+` from the tail and never uses it; the actual read failure is masked (see below). `status()` uses `includes('__MISSING__')` against `stdout` that also contains `META=$(cat …, 2>/dev/null)` — a `meta.json`/`status` file whose *content* contains `__MISSING__` makes a live job look missing. Same for `UPLOAD_OK` (`:481,484`) and `TASK_OK` (`:510–511`) — a remote file (task text, existing workdir file) can contain those tokens.
2. **The 200 KB cap appends raw UTF-8 chunks and cuts mid-multibyte-character**, producing U+FFFD-filled tails, and more importantly it **silently drops the rest**: a 2 MB `result.md` (very common for an agent final answer with code) is truncated to ~200 KB with **no `truncated: true` flag** in the returned object, so the model reasons over a half-sentence ending.

**Impact.** Silent partial results reported as complete; misleading status; corrupt text. This is the classic "untrusted output trusted" failure.

**Fix sketch.**

```js
// ssh.js
const MAX_OUTPUT = 8 * 1024 * 1024
let truncated = false
child.stdout?.on('data', (c) => {
  if (stdout.length >= MAX_OUTPUT) { truncated = true; return }
  stdout += c
})
// and decode with a StringDecoder so UTF-8 never splits across chunks
const { StringDecoder } = require('node:string_decoder')

// service.js result(): return the flag, and stop guessing with regexes
return { jobId, host: hostName, text, truncated, bytes: Buffer.byteLength(text) }
```

Better: have `dsh-job result` emit a length prefix / use `wc -c` (already returned as `resultBytes` in `status()`), and have `result()` refuse to read more than a configurable cap while telling the caller to page (`remote_result({from, len})`).

---

### REV-06 — Medium — jobId sanitisation silently collides

**Where:** `src/service.js:452`.

```js
const jobId = (input.jobId || this.makeJobId(project)).replace(/[^A-Za-z0-9._-]/g, '-')
```

**What is wrong.** `jobId` is *rewritten*, not rejected. `"deploy:prod"` and `"deploy/prod"` and `"deploy prod"` all become `deploy-prod` — and `"deploy-prod"` is itself valid, so three distinct user intentions land in one remote job directory. `makeJobId` has **1-second** resolution (`:387–392`) from the *local* clock, so two dispatches in the same second with the same project also collide. `dsh-job.sh:52` (`[[ -e "$d" ]] && die "job already exists"`) then fails the second submit *after* the local directory has already been packed and uploaded.

**Impact.** Silent loss of an existing job's `result.md`/`status` (second dispatch overwrites workdir, then fails submit); "did my job really run?" ambiguity; wasted upload.

**Fix sketch.**

```js
const JOB_ID = /^[A-Za-z0-9._-]{1,64}$/
makeJobId(project) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)  // YYYYMMDDHHMMSS + 'Z'
  const rand = Math.random().toString(36).slice(2, 6)
  return `${project}-${stamp}-${rand}`
}
if (input.jobId !== undefined && !JOB_ID.test(input.jobId)) {
  throw new RemoteError('invalid-job-id', 'jobId 只能包含字母数字 . _ -（≤64 字符）')
}
```

Do the same check server-side in `dsh-job submit` and add an `O_EXCL` create so two racing submits cannot both pass the `-e` test.

---

### REV-07 — Medium — Hand-rolled YAML parser yields false-positive credentials

**Where:** `src/service.js:87–128` (the `listSshCredentials` parser) — the same family of bug as the much larger parser at `:243–324`.

**What is wrong.** The block scanner only tracks `payload:` nesting and never resets on a **top-level** key, so the indented lines of a multi-line scalar in a *different* record (e.g. a PEM `privateKey` under `github`, or any block whose `host:` looks like a hostname) contribute `type: ssh`/`host:` values to the *previous* SSH record. Field `id` is taken from the header regex (`:90`) so the record is still real, but `host`/`username`/`authMethod` can silently belong to a neighbour. Conversely, `readCredentialFile` (`:243–324`) is a *second*, subtly different YAML implementation over the **same plaintext file** — two parsers, two behaviours, one truth.

**Impact.** The Settings dropdown shows a credential that will fail at auth time (or worse, points to the wrong host), and `normalizeRecord` (`:338–346`) silently defaults `username` to `root` (`:342`) for any record missing it — so a mis-parse means *logging into the wrong account on the right host*.

**Fix sketch.** Use the vault's service (`ctx.credentials.listRecords?.(...)`) when present; when falling back to the file, use a real YAML parser (`yaml` is already a DSH dependency — verify) or, at minimum, share one parser between `listSshCredentials` and `readCredentialFile`. And make `normalizeRecord` fail closed:

```js
if (!rec.username) throw new RemoteError('credential-invalid', `凭据 ${credentialId} 缺少 username`)
```

---

### REV-08 — Medium — State-changing endpoints rely on a forgeable request shape

**Where:** `src/rpc.js:41–55` (`readJson`), `:99–117` (`saveDevice`/`removeDevice`/`setDefaultDevice`), `:140–174` (`push`); client side `client.js:152–176`.

**What is wrong.** The only gate is `web.connection.admit(req)` (L211), which is a Host/Origin + session-cookie fence. `fetch` with `content-type: application/json` from `evil.example` is a *simple-ish* request — no CORS preflight is required for `text/plain`, and browsers **do** preflight `application/json`, so classic form-CSRF is blocked — but the endpoint accepts **any** content type: `readJson` never checks `req.headers['content-type']` and happily parses a `text/plain` body (fetch/form/`navigator.sendBeacon`). That makes `removeDevice`/`setDefaultDevice`/`push` reachable from a third-party page in some browser configurations (sendBeacon with `text/plain` bypasses the preflight), and reachable from any *local* process regardless. There is no CSRF token and no confirmation for `removeDevice`.

**Impact.** A malicious page or local process can unbind devices (denial of service) or push a task to the cloud under the operator's model key. Severity is capped by the `admit` fence, but the defence is one bug away from total.

**Fix sketch.**

```js
function requireJson(req) {
  const ct = String(req.headers['content-type'] ?? '')
  if (!/^application\/json\b/i.test(ct)) throw new RemoteError('unsupported-media-type', '…')
  if (req.headers['x-dsh-csrf'] !== csrfToken(web)) throw new RemoteError('forbidden', '…')
}
```

and have the client set `'x-dsh-csrf'` from a value embedded in the boot payload.

---

### REV-09 — Medium — Unbounded disk growth; size check happens too late

**Where:** `src/service.js:414–427` (`mkdtemp` + full local tar), `:470–473` (size check **after** packing), `remote/dsh-job.sh:26` (`mkdir -p`), README:200 ("磁盘不会自动清理").

**What is wrong.** `maxUploadMb` is enforced only after the local archive is complete, so a 40 GB `localDir` fills `%TEMP%` (and a failed `rm` in `packDirectory` leaks it — the `catch` at `:422–424` only cleans up on non-zero `tar` exit) before the user is told "too large". On the remote side nothing prunes `~/dsh-jobs`; each job keeps `events.jsonl` (full reasoning + usage) *and* `task.md`, `result.md`, `err.log`, `run.log` forever. One 30-conversation month at 5 MB/job ≈ 150 MB per host — modest, but `events.jsonl` for long agent runs can be hundreds of MB.

**Impact.** DoS of the local machine (disk full → DSH cannot write its own storage) and unbounded cloud disk use; a full `/tmp` on a small VPS breaks *other* services.

**Fix sketch.**

```js
// pre-check before packing: sum entry sizes with a cheap walk, abort early
const approx = await dirSize(dir)              // fs.promises + readdir, skip EXCLUDE
if (approx > this.settings.maxUploadMb * 1024 * 1024 * 1.2) throw new RemoteError('upload-too-large', ...)
// and stream instead of staging:
await this.uploadTarStream(t, dir, remoteRoot)   // tar → ssh stdin → tar -xz
```

Remote side: add `dsh-job prune <days>` and call it (best-effort) at submit time.

---

### REV-10 — Medium — `meta.json` built by shell interpolation

**Where:** `remote/dsh-job.sh:57–59`.

```sh
cat > "$d/meta.json" <<EOF
{"id":"$id","workdir":"$wd","session":"$session",…,"host":"$(hostname)"}
EOF
```

**What is wrong.** `$wd` comes from the local side and is `$HOME/dsh-work/<project>` — safe today. But `$id`/`$session`/`$wd` are *not* JSON-escaped, and `session` is derived from `meta.json` of the continued job (`service.js:498–499` regex `"session"\s*:\s*"([^"]+)"`). A `session` value containing `"` or a newline produces invalid JSON; `service.js:605` then `try { JSON.parse } catch { /* keep empty */ }` **swallows it**, so `status().session` silently becomes `undefined` and `continueSession` silently degrades to "new task" (`:503–505`) — the operator thinks they continued a conversation and they did not. Note the same hand-rolled `sed` on L109 has `\\"` inside a double-quoted string, which is a literal backslash-quote in bash — the substitution never matches, so `meta.json` never actually learns the new session id for *new* jobs (`:105–111`).

**Impact.** `continueSession` silently starts a fresh context (cost + correctness), and `status` misreports `session`.

**Fix sketch.** Use Python (already a dependency of this script, L114) or `jq` for both writes:

```sh
python3 - "$d/meta.json" "$id" "$wd" "$session" "$(hostname)" <<'PY'
import json, sys, datetime
dst, id_, wd, session, host = sys.argv[1:6]
json.dump({"id": id_, "workdir": wd, "session": session,
           "submitted_at": datetime.datetime.now().astimezone().isoformat(),
           "host": host}, open(dst, "w"), ensure_ascii=False)
PY
```

and replace the `sed` at L109 with the same Python step.

---

### REV-11 — Medium — `workRoot` accepted but ignored; device and project input not validated

**Where:** `src/devices.js:139` (stores `workRoot`), `src/service.js:453` (`remoteRoot` hard-codes `${home}/dsh-work/…` — `workRoot` is never read anywhere: `grep workRoot` finds only `devices.js:139` and `tasks/rpc` plumbing), `src/rpc.js:99–103` (whole body forwarded), `src/devices.js:127` (name derived from label), `src/service.js:449–451`.

**What is wrong.** (a) The documented `workRoot` setting has **no effect** — a user who sets it gets files in `~/dsh-work` anyway and, worse, a `workRoot` that escapes the home (e.g. `/var/www`) looks honoured in the UI. (b) `saveDevice` accepts unknown key types; `project` from HTTP is passed to `safeProject` (char-strip only) with no length cap. (c) `upsert` keys on `normalizeDeviceName(input.name ?? input.label)`, so binding a device labelled `"我的云主机 A"` and later `"aliyun"` can **silently overwrite** an existing `aliyun` binding (no "replace?" confirmation) — `devices.json` loses the old `credentialId`.

**Impact.** Configuration that lies; accidental rebinding of a device to the wrong credential; confusing file locations.

**Fix sketch.**

```js
// service.js
const remoteRoot = `${entry.workRoot ? shellQuoteSafe(entry.workRoot) : `${home}/dsh-work`}/${project}`
// devices.js
if (existing && input.overwrite !== true) throw new RemoteError('device-exists', `设备 ${name} 已存在`)
```

---

### REV-12 — Low — Queue / pid / cancel semantics

**Where:** `remote/dsh-job.sh:62–63` (submit), `:73–81` (worker), `:158` (`kill -0` liveness), `:187–192` (cancel).

**What is wrong.**
1. `pid` is written at `:81`, **after** `flock 9` succeeds. A job that is queued behind a running one has **no pid file**, so `cmd_cancel` (`:185–195`) writes `cancelled` and then finds nothing to kill. `cmd_worker:76` *does* check `cancelled` before starting — good — but if the job was already `running` (worker past the check) and the pid file has not yet been flushed, the kill is silently skipped and the job keeps running while `status` says `cancelled`.
2. `kill -0 "$pid"` at `:158` is a **stale-pid oracle**: after the worker exits, the pid may be recycled; `status` then reports `alive=yes` for an unrelated process.
3. `kill -TERM -- "-$pid"` at `:190` targets **the process group whose gid equals the worker's pid**. Because `setsid` makes the worker a session leader, that is normally the right group — but `dsh` spawns `node` children that may `setsid` themselves (job control), escaping the group. README/tool description promises "杀掉整个进程组"; this is best-effort, not a guarantee.

**Fix sketch.**

```sh
cmd_submit() {
  ...
  { setsid nohup "$0" __worker "$id" "$wd" "$session" >>"$d/run.log" 2>&1 </dev/null & echo $! > "$d/worker.pid"; }
}
cmd_cancel() {                             # kill tree, then confirm
  printf 'cancelled' > "$d/status"
  local pid; pid=$(cat "$d/worker.pid" 2>/dev/null)
  [[ -n $pid ]] && pkill -TERM -P "$pid" 2>/dev/null; kill -TERM -- "-$pid" 2>/dev/null
  for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -KILL -- "-$pid" 2>/dev/null || true
}
```

and record the *pid start time* (`ps -o lstart=`) alongside to defeat recycling.

---

### REV-13 — Low — `setsid` detach correctness / exit-code propagation

**Where:** `remote/dsh-job.sh:62–63`, `:96–100`, `:141–149`.

**What is wrong — and what is *correct*.** `setsid nohup … &` with `</dev/null` and `>>run.log 2>&1` is the right shape; the remote DSH survives SSH drops *(assumption holds: the SSH `close` never signals the detached group)* — I found **no bug** in the detach itself. Two caveats remain:
1. `rc` captured at `:100` is `dsh`'s exit code, and `:143–148` maps `0 → done`, non-zero `failed`. But `dsh --json` may exit `0` while the *agent run* failed (tool error / rate limit) — the status then says `done` with an empty `result.md`, and `service.result` throws `result-empty`. **There is no distinct "done but no answer" state**, and `remote_wait` (`service.js:692`) only fetches the result when `state === 'done'`, reporting `resultError` otherwise.
2. If the worker is SIGKILLed (reboot, OOM, cancel), `status` is stuck at `running` forever; nothing reconciles on next boot.

**Fix sketch.** Add a `done`-with-empty-result check and a `stale` reconciler:

```sh
[[ $rc -eq 0 && ! -s "$d/result.md" ]] && { printf 'failed' > "$d/status"; log "no final answer"; }
```

plus `cmd_list`/`cmd_status` reporting `state=running, alive=no, since=<mtime>` and letting `service.status` surface `likelyDead: true`.

---

### REV-14 — Low — Timeout vs. `close` double-settle; partial output discarded

**Where:** `src/ssh.js:128–154`.

**What is wrong.** The `setTimeout` callback sets `settled = true` and `reject`s, then `child.kill()`. `close` then fires and is ignored (fine). But on timeout the **partial stdout/stderr and the exit code are thrown away** — for a `remote_wait` that hit `commandTimeoutMs` the operator loses the `dsh-job wait` output that was already buffered. Also `child.on('close')` uses `code ?? 0`: a child killed by a signal reports `null` and is therefore reported as **success (0)**.

**Fix sketch.**

```js
child.on('close', (code, signal) => {
  if (settled) return
  settled = true; clearTimeout(timer)
  const effective = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)
  resolve({ code: effective, signal, stdout, stderr })
})
// on timeout: resolve({code: 124, timedOut: true, stdout, stderr})
```

---

### REV-15 — Low — Failed extraction leaves the tarball and a partial tree

**Where:** `src/service.js:478–483`. `tar … && rm …` short-circuits on failure; `mkdtemp`'d `/tmp/_dshpush-*.tar.gz` and the half-extracted `remoteRoot` remain. The next dispatch into the same project then mixes old and new files, which is exactly the "same code on both sides" contract the README makes.

**Fix sketch.** Extract into `remoteRoot.new`, then `mv -T` swap, and `rm -f` the tarball in an unconditional `finally`-style trap on the remote side.

---

### REV-16 to REV-20 — Low / Nit

| ID | Where | Note |
|---|---|---|
| REV-16 | `service.js:69–71,208–210`; `devices.js:20–22`; `ssh.js:52–55` | The `DSH_HOME ?? USERPROFILE ?? HOME ?? …` fallback is copy-pasted 4× with two different empty-string behaviours (`''` vs `'.'`). One `resolveHome()` helper. |
| REV-17 | `ssh.js:208` | Full env snapshot per exec — superseded by REV-04's `minimalEnv`. |
| REV-18 | `client.js:406,410` | `placeholder: 'C:\\Users\\…'` renders `C:\\Users` (double backslash) in the UI. |
| REV-19 | `tools.js:46–52` | `wrap()` rethrows `new Error(code + ': ' + message)`, losing `RemoteError.code` structurally — the agent cannot branch on `job-not-found` vs `timeout`. Return `{ code, message }` in the envelope instead. |
| REV-20 | `service.js:157–169` | `target()` memo keys on config entry only; a *rotated* credential is never picked up until DSH restarts (the `SshTarget` holds old `password`/`privateKey`), and secrets stay in the heap. Add a TTL (e.g. 5 min) and a `ctx.on('credentials:changed')` invalidator. |

---

## 3. Robustness review

| Scenario | Behaviour today | Verdict |
|---|---|---|
| **SSH disconnects mid-command** | `ServerAliveInterval=15`/`CountMax=4` (`ssh.js:193–194`) → ~60 s to notice. `startStdin`'s `child.stdin.on('error')` (`:305–307`) sets `failure`, the next `write()` rejects `upload-aborted`, `uploadWithProgress` calls `abort()` and rethrows. If the drop happens *after* `dsh-job submit` returned, the job is unaffected (detached) — correct. If it happens during `tar -xzf`, the remote `mkdir` may have already created `remoteRoot` with a partial tree (REV-15). | **Acceptable, with a partial-tree caveat** |
| **Host unreachable** | `ConnectTimeout=15` then `ssh` exits 255; `status/result/logs/cancel/list/wait` do **not** check `r.code` before interpreting output — `status` throws `job-not-found` (misleading) whenever `stdout` lacks the dir, `logs` returns `{log: ''}` silently, `list` throws `list-failed: dsh-job 未安装` (also misleading) | **Poor diagnostics**; distinguish 255 (`ssh-unreachable`) from 1 (`job-not-found`) |
| **Disk full (local)** | `packDirectory` tar exits non-zero → cleaned up. `devices.json` `save()` writes `.tmp` then `rename` — a full disk leaves a stale `.tmp`, but the old file survives (good). Temp archive leak on abnormal exit (REV-09). | **Mostly OK**; add the archive-size pre-check |
| **Disk full (remote)** | `cat > /tmp/_dshpush-…` fails → `startStdin.end()` returns non-zero → `upload-failed` (good). But `events.jsonl` written by `dsh` while the disk fills can silently truncate the event stream → `result.md` empty → `done` with no answer (REV-13). | **Silent data loss possible** |
| **Concurrent dispatch, same `jobId`** | `dsh-job.sh:52` `[[ -e $d ]] && die` is a **TOCTOU**: two submits racing between the test and `mkdir -p "$d"` (L54) both proceed, both `cp` `task.md`, both write `status`, both spawn workers; the `.queue.lock` flock only serialises *execution*, not creation. Locally, both dispatches also share `/tmp/_dshpush-<jobId>.tar.gz` and `/tmp/_dshtask-<jobId>.md` → one can `rm` the other's tarball mid-extract. | **Race** — fix with `mkdir "$d" 2>/dev/null \|\| die` (atomic `mkdir` is the lock) |
| **Path with spaces / non-ASCII (中文)** | Local: `runProcess('tar', [...], { shell: false })` *argv* → spaces and Chinese survive; the tar format is BYTE-level so filenames are preserved by bsdtar. Remote: every path is `shellQuote`d → spaces safe; Chinese safe under `LANG=C.UTF-8` (`dsh-job.sh:91`). **But** `project`/device name regexes (`service.js:396`, `devices.js:28`) strip CJK to `-`, so *(verified in Node)* `safeProject("项目名") === "default"` — the folder silently lands in `default` — and `normalizeDeviceName("我的云主机 A") === "2h2c"` (leading CJK eaten), while `normalizeDeviceName("我的机器")` **throws `invalid-name`**. The UI's placeholder is exactly `我的云主机 A` (`client.js:648`) and an empty device name falls back to `form.label` (`:525`), so a Chinese-only label makes binding fail with a confusing error. | **Bug**: Chinese names are unusable/mangling (see REV-11) |
| **Very large `localDir`** | Full local tar first (REV-09); 256 KiB chunking with a 120 s default `commandTimeoutMs` governs the **whole** upload (`ssh.js:313`), so ~200 MB over a 2 MB/s link ≈ 100 s — near the limit; at 1 MB/s it **times out mid-upload** and the tarball is left on the remote `/tmp`. | **Misconfigured timeout for the upload path** — pass a size-derived budget (`bytes / assumedBps`), not `commandTimeoutMs` |
| **Interrupted upload** | `abort()` destroys stdin + SIGKILLs ssh; **no local retry, no resume, no cleanup of the remote partial tarball**. `packed.cleanup()` runs in `finally` (`:488–490`), good. | **Acceptable**; add a remote `rm -f` in the abort path |
| **`remote_wait` + session expiry** | `service.wait` runs `dsh-job wait <id> <seconds>` with `budget + 120 s`; a long `wait` occupies one ssh channel but nothing blocks the job. | **OK** |
| **`remote_status` ↔ `remote_result` race** | `status()` returns `finished: true` (state read at time T), then `result()` reads `result.md` at T+Δ. Between them `result.md` may still be being written (`dsh-job.sh:114–136` writes it *before* `status` flips at `:144`, so in practice `done ⇒ result.md exists` — **I checked and the order is correct**). The real race is the opposite: `status` returns `running` + `resultBytes > 0` (a *previous* run's `result.md` in a reused project dir), and `remote_result` happily returns the **stale** answer. There is no `jobId` ↔ `result.md` binding (no content hash/`jobId` echo inside `result.md`). | **Real, medium**: stale results served as fresh — stamp `result.md` with the jobId and verify |

---

## 4. Top 5 fixes ranked by risk ÷ effort

| # | Fix | Addresses | Risk reduced | Effort | Why ranked here |
|---|---|---|---|---|---|
| **1** | **Strict `jobId` / `continueSession` / `project` validation** — one `assertSegment()` helper used by every service method *and* by `dsh-job.sh` (`job_dir`), plus a schema `pattern` | REV-02, REV-06 | ⬛⬛⬛⬛⬛ (remote file disclosure, arbitrary dir write, silent job collision) | **~1 h, ~40 LOC** | Highest severity per line of code in the whole plugin; pure validation, no design change, zero regression risk |
| **2** | **Harden extraction + remote temp files** — stop trusting `/tmp/_dshpush-*`; stream the tar into `tar -xz` over stdin; `umask 077` + `! -L` check; entry allow-list verification before extract | REV-01, REV-15 | ⬛⬛⬛⬛⬛ (remote RCE) | **~3 h** | The RCE needs a local unprivileged user on the cloud box *or* a mis-set `project`; streaming the upload is a modest refactor of `uploadWithProgress` and removes the whole class |
| **3** | **Don't hand the password to an unverified host** — pin host keys (`StrictHostKeyChecking=yes` + dedicated `known_hosts`), `minimalEnv()` with `SSH_AUTH_SOCK` cleared, `ForwardAgent=no`, wipe askpass env in `finally` | REV-03, REV-04 | ⬛⬛⬛⬛ (credential theft) | **~2 h** + one UI step to approve a fingerprint | Cheap and decisive; the only cost is a first-connect approval |
| **4** | **Make remote text non-authoritative** — read `__RC`/exit codes properly, stop relying on `includes('UPLOAD_OK')`, return `truncated`/`timedOut` flags, raise `MAX_OUTPUT` to a few MB with a `StringDecoder`, surface `ssh` exit 255 as `ssh-unreachable` | REV-05, REV-14, robustness rows 2/3 | ⬛⬛⬛ (silent corruption / wrong answers) | **~2 h** | These are the bugs the operator will actually *hit*, and they are invisible today |
| **5** | **Atomic job creation + honest `meta.json`** — `mkdir` as the lock (`mkdir "$d" 2>/dev/null \|\| die`), `meta.json` via Python/`jq`, fix the broken `sed` session rewrite, add `done-but-empty` → `failed` | REV-10, REV-12, REV-13 | ⬛⬛ (concurrency, broken `continueSession`, stuck `running`) | **~2 h**, shell-only, no Node changes | Bounded blast radius but directly breaks the advertised `continueSession` feature |

**Deliberately *not* in the top 5:** REV-08 (CSRF) and REV-11 (`workRoot`). Both are real, but the `admit()` fence currently holds for REV-08, and REV-11 is a correctness bug rather than a security one — do them in the same pass as #1/#3 respectively.

---

## Appendix A — Evidence log

| Claim | How verified |
|---|---|
| `shellQuote` is correct | `sed -n '165,167p' src/ssh.js \| od -c` → `' \ \ ' '` (canonical form). Quote-escaping is **not** a finding. |
| `--exclude` with bare names works from `.` | `tar -czf /tmp/tt.tgz --exclude node_modules -C /tmp/tt .` then `tar -tzf` → `sub/node_modules` absent. bsdtar 3.8.9. |
| `safeProject` / `normalizeDeviceName` edge cases | Node replay of the two functions: `".."→".."`, `"项目名"→"default"`, `"我的云主机 A"→"2h2c"`, `"我的机器"→ throw invalid-name`. |
| `$?` after `cat … 2>/dev/null` is unusable | `sh -c 'cat /nonexistent 2>/dev/null; echo; echo __RC=$?'` → `__RC=0`. |
| `%TEMP%` ACL is per-user | `icacls …\AppData\Local\Temp` → only `SYSTEM`, `Administrators`, `ADIL\you` (no `Users`/`Everyone`). |
| Every remote shell command | `grep -n "startStdin\|execWithStdin\|shellQuote(\|\.exec("` on `service.js` → 21 sites, all reviewed at L352–L687. |
| `workRoot` unused | `grep -n workRoot` → only `devices.js:139` and `src/tasks`/`rpc` plumbing; never read in `service.js`. |

## Appendix B — Scope limits of this review

- **Static only.** No remote host was contacted and no DSH app was restarted, so the runtime behaviour of `web.connection.admit()` and of the `dsh --json` event schema is taken from the source comments, not observed.
- The exact credential-file layout was reviewed against the parser in `service.js:243–324`; the file itself was **not opened** (it contains plaintext secrets) — the false-positive analysis in REV-07 is by code-path inspection.
- `dsh` CLI internals (`--session-id` semantics, whether it exits non-zero on agent-level failure) are assumed from `README.md:157–160` and were not exercised.
