# dsh-remote-dispatch — FAQ

Answers are derived from the source, not from the README. Every non-obvious claim
carries a `path:line` citation. §22 lists places where the shipped `README.md` is wrong
or stale.

---

## 1. What actually survives a local reboot?

**The job survives; your local knowledge of it does too, but only via the cloud.**

| Thing | Survives local reboot? | Why |
|---|---|---|
| The running cloud job | ✅ Yes | The worker is `setsid nohup`-detached at submit time (`remote/dsh-job.sh:61-64`). The local machine is not part of the job's lifecycle after `submit` returns. |
| The job's `jobId` | ⚠️ Only if you recorded it or you keep the cloud directory | Nothing is written locally per job. There is no local job cache — the service's only `Map` caches `SshTarget` objects (`src/service.js:49, 157-169`). Recover with `remote_list` (`src/service.js:653-670`). |
| Your **device bindings** | ✅ Yes | `devices.json` under `DSH_HOME/storages/dsh-remote-dispatch/` (`src/devices.js:19-24`). |
| Your **default device** | ✅ Yes | Same file (`src/devices.js:57-60`). |
| In-flight upload progress | ❌ No | Progress exists only in the NDJSON stream (`src/rpc.js:140-174`). If the browser or laptop dies mid-upload, the tar half-written at `/tmp/_dshpush-<jobId>.tar.gz` is orphaned and the job is never submitted. |
| Local temp state | ❌ No | `os.tmpdir()` pack dirs and key dirs are per-process (`src/service.js:414`, `src/ssh.js:213`). |

What does **not** survive is a cloud reboot: the worker is a normal process, so a host
reboot kills a running job. Its `status` file will stay `running` forever — nothing
rewrites it — and `pid` will point at a dead process. You must `remote_cancel` it (or
`rm -rf` the directory) before that id can be reused.

---

## 2. Where exactly do files land on the server?

Two independent trees, both under the cloud `$HOME`:

```
$HOME/dsh-work/<project>/        ← the job's cwd; uploaded code lands here  (src/service.js:453)
$HOME/dsh-jobs/<jobId>/          ← per-job records                            (src/service.js:591)
```

`<project>` is derived, in order, from: the `project` argument, then
`basename(resolve(localDir))`, then the literal `default`
(`src/service.js:449-451`), then sanitised to `[A-Za-z0-9._-]` with everything else
collapsed to `-` (`src/service.js:395-398`).

⚠ **A non-ASCII project name silently becomes `default`.** `"我的项目"` sanitises to
`""`, which the fallback turns into `default`. Verified against the regex at
`src/service.js:396`.

⚠ **`workRoot` on the device record is stored but never used.** `dispatch()` builds the
path from `home + "/dsh-work/" + project` unconditionally (`src/service.js:453`);
`entry.workRoot` is written by `upsert` (`src/devices.js:139`) and read nowhere.

The cloud `$HOME` is discovered by running `printf %s "$HOME"` over SSH each time —
it is **not** cached (`src/service.js:350-356`), so each tool call pays one extra SSH
round-trip before the real command.

---

## 3. How is an uploaded directory packaged?

With the **system `tar`**, not a JS archiver:

```js
const args = ['-czf', archive, ...excludes, '-C', dir, '.']
await runProcess('tar', args, {}, 300_000)
```

`src/service.js:419-421`

- Archive: `os.tmpdir()/dsh-remote-pack-XXXX/payload.tar.gz` (`src/service.js:414-415`),
  removed in a `finally` (`src/service.js:488-490`).
- Contents: `.` — the *contents* of the directory, not the directory itself. So
  `localDir/mytool/src/a.js` unpacks to `<remoteRoot>/src/a.js`.
- Excludes are passed as repeated `--exclude <name>` (`src/service.js:417`):
  `.git`, `node_modules`, `.venv`, `venv`, `__pycache__`, `.next`, `dist`, `build`,
  `.dsh`, `dsh-jobs`, `.cache`, `.DS_Store`, `target`, `.pytest_cache`, `.idea`,
  `.vscode` (`src/service.js:22-25`).
  These are **bare basenames**, so GNU/bsdtar match them at any depth: a `src/build/`
  or a nested `lib/node_modules/` is also skipped.
- Upload goes to `/tmp/_dshpush-<jobId>.tar.gz` in 256 KiB chunks (`src/service.js:475, 550`),
  then `tar -xzf … --no-same-owner` into the remote root (`src/service.js:478-483`).
- Unpacking **overlays**; it does not clear the destination first. Deleted local files
  stay on the cloud, and two uploads accumulate.
- Packing has a 300 s budget (`src/service.js:421`); unpacking gets
  `max(commandTimeoutMs, 600_000)` (`src/service.js:482`).
- Size gate: `bytes / 1024 / 1024 > maxUploadMb` throws `upload-too-large`
  **before** any network traffic (`src/service.js:470-473`).
- `.tar.gz` uses the local `tar`'s default compression — on Windows that is the
  bundled bsdtar, which is fine for GNU `tar` on the receiving end.

---

## 4. What happens if the `jobId` already exists?

The submit fails, and the tool call throws.

`remote/dsh-job.sh:52`:

```bash
[[ -e "$d" ]] && die "job already exists: $id"
```

`die` writes `ERROR: job already exists: <id>` to stderr and exits 1
(`remote/dsh-job.sh:29`). The dispatcher then throws
`RemoteError('submit-failed', '提交失败：…')` (`src/service.js:519-522`), which the
agent sees as `submit-failed: 提交失败：ERROR: job already exists: mytool-1110-200651`.

Both the default id `<project>-MMDD-HHMMSS` (`src/service.js:387-392`) and a
custom `jobId` go through the same path.

Practical consequences:

- **Same project, two dispatches in the same second** collide. The second fails; retry a
  second later or pass an explicit `jobId`.
- A **custom `jobId` is sanitised** by `src/service.js:452` (every character outside
  `[A-Za-z0-9._-]` → `-`, not collapsed). `"My Run #1"` becomes `My-Run--1`.
- The failed attempt still leaves `/tmp/_dshtask-<jobId>.md` behind: the task file is
  deleted only when `submit` succeeds (`src/service.js:515-518`).
- Reusing an **existing job's id to retry it** is impossible — you must either cancel and
  pick a new id, or delete the directory on the host first:
  `rm -rf ~/dsh-jobs/<jobId>`.

---

## 5. How are logs bounded?

**They aren't, on the cloud — only in what is returned to you.**

| Layer | Bound | Source |
|---|---|---|
| `run.log` on disk | **unbounded**, append-only across runs (`>>`) | `remote/dsh-job.sh:63` |
| `err.log` on disk | **unbounded within one run**, but truncated at the start of every run (`>`) | `remote/dsh-job.sh:100` |
| `events.jsonl` on disk | **unbounded** — the full event stream including reasoning and usage | `remote/dsh-job.sh:100` |
| `remote_logs` `lines` | clamped to `[1, 2000]`, default `40` | `src/service.js:644` |
| stderr tail inside `remote_logs` | hard-coded `tail -n 40` — **not** affected by `lines` | `src/service.js:647` |
| any single SSH stdout/stderr | truncated at 200 000 chars | `src/ssh.js:19, 135-140` |
| `remote_status` | only counts: `resultBytes` (`wc -c`), `logLines` (`wc -l`) | `src/service.js:597-598` |

Two subtleties:

- The worker **copies the last 40 stderr lines into `run.log`** at the end of the run
  (`remote/dsh-job.sh:139`). A finished job therefore shows its stderr inside
  `run.log` *and* again in the `--- stderr ---` section.
- `lines: 0` yields 40, not 1, because the clamp is
  `Number(lines) || 40` and `0` is falsy (`src/service.js:644`).

For very long jobs `events.jsonl` is the real disk consumer; compress or delete old job
directories (see §12).

---

## 6. Do credentials ever touch the remote disk?

**No.** The SSH credential never leaves the local machine.

- The device record stores only a `credentialId` (`src/devices.js:135-145`).
- The credential is read from the DSH credential store — the live service if mounted,
  else a textual parse of `$DSH_HOME/.credentials.yaml`
  (`src/service.js:172-204, 207-330`).
- For **password** auth the secret is handed to `ssh` through an **environment
  variable** (`DSH_REMOTE_ASKPASS`) consumed by an askpass helper; it never appears in
  argv or a file (`src/ssh.js:20, 221-227`).
- For **key** auth the private key is written to a `0600` temp file under
  `os.tmpdir()/dsh-remote-key-*`, used as `-i`, and `rm -rf`'d in a `finally`
  (`src/ssh.js:211-219, 242-244`). That is **local** disk, not remote.

What *does* go over the wire and land remotely:

- The task text, at `/tmp/_dshtask-<jobId>.md`, copied into `~/dsh-jobs/<jobId>/task.md`
  (`src/service.js:509-510`, `remote/dsh-job.sh:55`). **Anything you type into the task
  becomes a world-readable-by-default file under `/tmp` for the duration of the submit**,
  and a permanent `task.md` afterwards. Don't put secrets in the prompt.
- The uploaded tarball, briefly at `/tmp/_dshpush-<jobId>.tar.gz`.

The model API key is different: it is *not* sent by the plugin at all — the worker
sources `KEY_ENV_FILE` **already on the host** (`remote/dsh-job.sh:85-87`), e.g.
`~/.dsh/.env.headless`. So the DeepSeek key does live on the remote disk, by design, but
not because of this plugin.

---

## 7. What happens if the host becomes unreachable mid-run?

Nothing happens to the job — that is the entire point.

- The dispatch already returned; the worker was detached with `setsid nohup` and
  `< /dev/null` (`remote/dsh-job.sh:62-63`). Losing the local network, or even killing
  the host's `sshd`, does not signal the worker.
- Each *local* plugin operation, however, is a fresh `ssh` process with
  `ServerAliveInterval=15`, `ServerAliveCountMax=4`, `ConnectTimeout=15`
  (`src/ssh.js:190-200`). A black-holed TCP connect fails at ~15 s; a dead link is
  detected in roughly 60 s.
- The calls that fail are the *observing* ones: `remote_status`, `remote_result`,
  `remote_logs`, `remote_list`, `remote_cancel`, `remote_wait`. Each surfaces as
  `spawn-failed` or `timeout` (`src/ssh.js:120, 132, 146`).
- **Upload is the exception.** If connectivity dies during `localDir` upload, the write
  to `ssh` stdin raises EPIPE, `write()` rejects with `upload-aborted`
  (`src/ssh.js:321-333`), the stream is aborted (`src/service.js:580-583`) and the
  dispatch throws — **but the partially written `/tmp/_dshpush-<jobId>.tar.gz` stays
  on the host**. No job was created.
- If you were in the middle of `remote_wait`, interrupting it locally does not kill the
  job; you can always re-query with `remote_result` later.

If the **host itself** goes unreachable because it was *shut down or rebooted*, the job
dies (see §1): status stays `running`, pid is dead, `result.md` never appears.

---

## 8. How do I clean up server disk?

Nothing is pruned automatically — neither the plugin nor the runner removes old jobs.

What accumulates:

| Path | Growth | Notes |
|---|---|---|
| `~/dsh-jobs/<jobId>/` | one dir per job | `events.jsonl` dominates; `run.log` and `err.log` are unbounded per §5 |
| `~/dsh-work/<project>/` | one tree per project | overlay-uploaded code + build artifacts; **never** cleaned by deleting jobs |
| `/tmp/_dshpush-*.tar.gz` | orphaned on a failed/aborted upload | removed on success (`src/service.js:481`) |
| `/tmp/_dshtask-*.md` | orphaned when `submit` fails | removed on success (`src/service.js:518`) |

Safe sweep (only touches jobs whose own `status` file says they are finished):

```bash
cd ~/dsh-jobs || exit 0
for d in */; do
  id=${d%/}
  st=$(cat "$id/status" 2>/dev/null)
  case "$st" in
    done|failed|cancelled)
      [ -n "$(find "$id" -maxdepth 0 -mtime +14 -print -quit)" ] && rm -rf -- "$id" ;;
  esac
done
rm -f /tmp/_dshpush-*.tar.gz /tmp/_dshtask-*.md
du -sh ~/dsh-work/* 2>/dev/null | sort -h | tail
```

Do **not** delete `~/dsh-jobs/.queue.lock` while any worker is alive — it is the
host-wide serialisation lock (`remote/dsh-job.sh:24, 73-74`). Deleting the *file* is
harmless once nothing holds it (a new one is created on the next submit), but deleting
it mid-flight can let two workers run concurrently.

Deleting a job directory is **permanent**: `remote_status` will answer `job-not-found`
(`src/service.js:600-602`) and `remote_result` will answer `result-empty`
(`src/service.js:632-634`).

---

## 9. Why is my job stuck in `queued`?

Because the runner serialises **all jobs on a host** behind one `flock`:

```bash
exec 9>"$LOCK"      # $DSH_JOB_ROOT/.queue.lock
flock 9
```

`remote/dsh-job.sh:73-74`

`status` is written as `queued` at submit (`:56`) and only becomes `running` **after**
the lock is acquired (`:80`). So a job submitted behind a 3-hour job sits at `queued`
for 3 hours.

Find the blocker:

```bash
ssh root@<host> 'fuser -v ~/dsh-jobs/.queue.lock; ps -eo pid,etime,cmd | grep "dsh-job\|dsh --profile"'
```

Cancel it with `remote_cancel`, or just wait. Hosts are independent: work on `tencent`
runs in parallel with work on `aliyun`.

---

## 10. Does `state: "done"` mean the task succeeded?

**No.** It means `dsh` exited with code 0 (`remote/dsh-job.sh:143-145`).

- `done` — CLI exit 0. The agent may still have given up, produced a refusal, or done
  only part of the work.
- `failed` — CLI exit non-zero (`:146-148`). Usually a real infrastructure problem
  (missing key, missing binary, OOM).

There is no per-task success signal in the protocol: the runner has no way to
distinguish "task accomplished" from "model answered". Read `remote_result().text`.

Also, if a `done` job produced **no** `{"type":"final"}` event, `result.md` stays
empty; `remote_result` then throws `result-empty` even though the state is `done`
(`src/service.js:632-634`).

---

## 11. How do I cancel, and does cancelling actually stop the work?

`remote_cancel({jobId, host?})` → `{jobId, host, cancelled: true, message:"cancelled: <id>"}`
(`src/service.js:673-679`).

On the host (`remote/dsh-job.sh:185-195`):

1. `status` is set to `cancelled` **first** — a job can never revert to `running` after
   this point.
2. If `pid` exists and is alive: `kill -TERM -- -<pid>`, `sleep 2`,
   `kill -KILL -- -<pid>`. The **negative pid** targets the whole process group, so the
   `dsh` child and anything it spawned die too.
3. A job still `queued` has no `pid` file yet; the worker checks the status right after
   taking the lock and exits immediately (`:76-78`). Pre-emptive cancel works.

Caveats:

- `cancelled: true` is a literal — the field does not report whether the process was
  actually still alive (`src/service.js:678`).
- The plugin's own `exec` of `dsh-job cancel` gets `cancel-failed` only if the runner
  exits non-zero (e.g. `ERROR: job not found`).
- A process that detaches into its own session *after* the kill would escape — but the
  worker itself is the group leader (`setsid` at `:62`), and `dsh` is its child, so the
  normal case is fully covered.

---

## 12. Two dispatches on the same host — do they run at the same time?

No. One `flock` per `DSH_JOB_ROOT` covers every job on that host, and it is held from
before `dsh` starts until after it exits (`remote/dsh-job.sh:72-74, 141-149`).

- Order is **submission order** as observed by the kernel's lock queue — effectively
  FIFO for `flock`.
- Different hosts = different lock files = full parallelism.
- If you need two heavy tasks concurrently, dispatch one to `aliyun` and one to `tencent`.

---

## 13. What is the upload size limit, and what happens at the boundary?

`maxUploadMb`, default **200**, clamped to `[1, 2048]` by config
(`index.js:58`) and surfaced in the settings UI (`src/rpc.js:88`).

The check is `packed.bytes / 1024 / 1024 > maxUploadMb` (`src/service.js:470-473`) —
comparing the **post-exclusion, post-compression** archive size, so `node_modules` does
not count against you. It runs **after** packing but **before** any upload, so an
oversized directory costs you a local `tar` run (up to 300 s) and nothing else.

Exceeding it throws `upload-too-large`: *"目录打包后 X MB，超过上限 Y MB。"*

For projects larger than the limit, `git clone` on the host and dispatch a text-only
task — the cloud repo lives in `~/dsh-work/<project>` and persists between jobs.

---

## 14. Can I use `continueSession` across different projects or hosts?

**Across projects: yes mechanically, but it will surprise you.**
`continueSession` only reads `<home>/dsh-jobs/<id>/meta.json` for the session id
(`src/service.js:497-506`). The new job's cwd is independently derived from `project`
(`src/service.js:449-453`). Omit `project` and the continuation runs in
`~/dsh-work/default` while remembering a conversation about `~/dsh-work/mytool`.
**Always pass the same `project` (or the same `localDir`).**

**Across hosts: no.** The session id lives in the cloud DSH's own session store. A
`continueSession` pointing at a job id that exists only on `aliyun`, while `host` is
`tencent`, will find no `meta.json`, silently fall back to a new session, and return the
note `未找到 <id> 的 session，按新任务执行` (`src/service.js:503-505`). That is a
**successful dispatch**, not an error — check the `session` field in the response.

**If the old job never produced a session id**, the same fallback happens. The runner
writes the id into `meta.json` only if the first line of `events.jsonl` contains
`"sessionId":"…"` (`remote/dsh-job.sh:104-111`).

---

## 15. Why does `remote_result` say "还没有结果" when the status is `done`?

Three distinct causes, in order of likelihood:

1. **The job is still `queued`/`running`** and a `result.md` does not exist yet. The
   error message is the same for both (`src/service.js:632-634`) — always pair it with
   `remote_status`.
2. **`dsh` exited 0 without emitting a final event.** `result.md` is only written when
   a line with `"type":"final"` and a string `text` is found
   (`remote/dsh-job.sh:114-136`). No event ⇒ no file ⇒ `result-empty`.
3. **`python3` is missing on the host and the `sed` fallback failed.**
   The fallback is `sed -n 's/.*"type":"final","text":"\(.*\)"}$/\1/p'` (`:115`). It
   only matches when `type` is immediately followed by `text`, and it cannot decode JSON
   escapes — a final text containing `\"` will not match at all.

Diagnose with `remote_logs` (look for the extraction failing) and by checking
`events.jsonl` directly on the host.

---

## 16. How are the target host's SSH host keys handled? Is `accept-new` safe?

The plugin always runs `ssh` with:

```
-o StrictHostKeyChecking=accept-new
-o ServerAliveInterval=15  -o ServerAliveCountMax=4
-o ConnectTimeout=15       -o LogLevel=ERROR
-o BatchMode=no
```

`src/ssh.js:190-200`

- `accept-new` = **trust on first use**. The first connection to a host/port writes the
  key into `~/.ssh/known_hosts`; every later connection is verified, and a *changed* key
  aborts the connection.
- That gives you protection against a mid-life MITM, but not against a poisoned first
  connection. If you care, pre-populate `known_hosts`:
  `ssh-keyscan -p <port> <host> >> ~/.ssh/known_hosts` (verify the fingerprint first).
- `LogLevel=ERROR` hides `known_hosts` warnings, so a *changed* key shows up as a
  generic `submit-failed`/`timeout` rather than a loud warning. Run `ssh` manually once
  if you suspect it.
- `PreferredAuthentications` is forced: key credentials use `publickey` only; password
  credentials use `publickey,password,keyboard-interactive`
  (`src/ssh.js:197`). A password credential on a host that only permits hardware-token
  auth will fail.

---

## 17. Why are there several SSH connections for one `remote_status` call?

Because there is **no connection multiplexing** and no repeated-call caching:

- `dispatch()` → `resolveHost` → `target` → `home()` (one SSH) → upload (one SSH)
  → task upload (one SSH) → submit (one SSH). That is 4 SSH handshakes for a typical
  dispatch with `localDir`, 3 without.
- `status()` → `home()` (one SSH) + the status command (one SSH) = **2**.
- `result()`, `logs()`, `list()`-with-home = **2** each.
- `wait()` is different: it issues one long-lived `dsh-job wait <id> <secs>` SSH
  call and then, on `done`, one more for `result()` (`src/service.js:682-700`).

`home()` is the culprit — it shells out every single time (`src/service.js:350-356`).
On a high-latency link this doubles the wall-clock of every status poll. If you are
polling, poll every 30–60 s rather than in a tight loop, or use `remote_wait` once.

---

## 18. What agent / environment does the cloud task actually run in?

The worker executes:

```bash
( cd "$wd" && "$DSH_BIN" --profile "$DSH_PROFILE" --json [--session-id "$sid"] - < "$d/task.md" )
```

`remote/dsh-job.sh:99-100`

So:

- Profile: `DSH_PROFILE`, default **`headless`** (`remote/dsh-job.sh:22`).
- Prompt source: the `task` text only. `--json` produces the event stream.
- cwd: `~/dsh-work/<project>` — that is why `localDir` upload matters.
- `PATH`: `dirname "$DSH_BIN"` prepended, then a conventional system `PATH`
  (`remote/dsh-job.sh:90`).
- Locale: `LANG` defaults to `C.UTF-8` (`:91`).
- Secrets: `KEY_ENV_FILE` is sourced with `set -a` (exported) before the run
  (`:85-87`).

The cloud environment is **independent of your laptop**: no local project files unless
uploaded, no browser sessions, no local credential vault, no intranet access. If the task
needs your local network, it cannot run there.

---

## 19. What is the job `session` field, and does reusing a job id re-run it?

`meta.json` carries a `"session"` key (`remote/dsh-job.sh:57-59`). It is `""` at submit
when no `--session` was passed, and is rewritten afterwards with the id parsed out of the
first line of `events.jsonl` (`remote/dsh-job.sh:104-111`). `remote_status` exposes it
when non-empty (`src/service.js:615`).

Reusing a job id does **not** re-run anything — `submit` refuses outright with
`job already exists` (§4). To re-run with the same conversation, dispatch a *new* job
with `continueSession: "<old id>"`.

Note: when `--session <sid>` **was** passed, the worker deliberately does **not**
overwrite `meta.json`'s session (`remote/dsh-job.sh:106-108` — the `if [[ -n "$session" ]]`
branch is a no-op). The stored session is therefore the *original* one, which is what
you want for chaining.

---

## 20. Is there any way to run two jobs at once on one host, or change the queue?

Not from the plugin. The lock file is `$DSH_JOB_ROOT/.queue.lock` created inside the
worker (`remote/dsh-job.sh:24, 73-74`), and the plugin only ever invokes
`submit/status/result/list/cancel/wait` (`src/service.js:515-518, 656, 676, 687`).
The `unpack`, `status`, `tail`, and `result` subcommands exist but are unused by the
plugin (`remote/dsh-job.sh:234-244` — the plugin only calls `submit`, `status` via its
own `cat`, `list`, `cancel` and `wait`; see `src/service.js:515-518, 656, 676, 687`).

To raise parallelism you would have to edit `dsh-job.sh` on the host — e.g. use a
per-project lock instead of a global one. That is a supported-looking but **unsupported**
change: nothing in the plugin depends on the lock's semantics, but the README's "串行排队"
guarantee would no longer hold.

---

## 21. What do the settings-page tags mean, and why is "就绪" green while dispatch still fails?

| Tag | Condition | Source |
|---|---|---|
| 检测中 | probe in flight | `client.js:579` |
| 就绪 | `probe.reachable && probe.ready` | `client.js:581-582` |
| 缺运行时 | reachable but `ready` false (i.e. `node` or `dsh` missing) | `client.js:583` |
| 不可达 | `reachable === false` | `client.js:583` |

`ready` requires only `node` and `dsh` (`src/service.js:380`). It deliberately does
**not** include `runnerInstalled` (`src/service.js:381`), even though the composer panel
text claims the probe reports "node/dsh/执行器是否就绪"
(`src/tools.js:56-57`, `README.md`). **A host can show 就绪 and still fail every dispatch
with `submit-failed` because `dsh-job` is missing.** Check `runnerInstalled` in the JSON,
or run `remote_list`, which fails with `list-failed` when the runner is absent
(`src/service.js:657-659`).

`reachable` is just `r.code === 0` of the probe command (`src/service.js:375`) — an auth
failure also yields `reachable:false`, with the ssh error in `warnings`
(`src/service.js:382`).

---

## 22. Where the shipped README is wrong or stale

These were found by comparing `dsh-remote-plugin/README.md` against the code. (README
line numbers refer to the shipped 216-line file.)

| # | README claim | Reality | Evidence |
|---|---|---|---|
| 1 | Two contradictory counts in the same document: "之后在任意会话里就能用下面 **8 个**工具" (README.md:29) and the `src/` file map says `tools.js` holds "**8 个** agent 工具定义" (README.md:214) — while the table header says "**9 个工具**" (README.md:77). | `registerTools` registers exactly **9** tools: `remote_hosts`, `remote_dispatch`, `remote_status`, `remote_result`, `remote_wait`, `remote_logs`, `remote_list`, `remote_cancel`, `remote_devices`. | `src/tools.js:55, 88, 110, 125, 140, 161, 177, 188, 203` |
| 2 | The "9 个工具" table omits any mention that `remote_hosts` returns a *probe* object whose `ready` flag ignores the runner (see #8) — and the table's `remote_hosts` blurb "探测设备连通性与运行时" overstates it. | `ready = node && dsh`; `runnerInstalled` is a separate field. | `src/service.js:380-381` |
| 3 | "`src/`" has 3 files: `service.js`, `ssh.js`, `tools.js` (README.md:210-215) | `src/` also contains `devices.js` (device registry) and `rpc.js` (browser⇄host channel). `README.md` never mentions either file, nor `client.js`, even though `package.json` exports it. | `src/devices.js:1`, `src/rpc.js:1`, `package.json:10` |
| 4 | (No explicit claim; the config table gives `waitTimeoutMs: 3600000` with no unit.) | That value is **milliseconds**; the `remote_wait` `timeoutSeconds` default is `waitTimeoutMs / 1000` = **3600 s**, clamped to `[30, 21600]`. Recorded because the unit mix-up is the most common confusion — *not* an error in the README. | `src/tools.js:149, 155`, `index.js:57` |
| 5 | "`localDir` 上传上限默认 200MB，自动排除 `.git`、`node_modules`、`__pycache__`、`.venv`、`dist`、`build` **等**" (README.md:202) | The list is 16 names, not 6: also `.next`, `.dsh`, `dsh-jobs`, `.cache`, `.DS_Store`, `target`, `.pytest_cache`, `.idea`, `.vscode`. The "等" hides a meaningful gap — `target/` and `.vscode/` are excluded but `vendor/`, `out/`, `log/` are **not**. | `src/service.js:22-25` |
| 6 | "首次加载时会把旧配置里的 `hosts` 自动播种成设备" (README.md:66) | Only when `devices.json` is **absent or unparsable**. Once the file exists, `hosts` in `cordis.patch.yml` is **ignored** for device resolution. Editing the YAML after first run is a no-op — a real trap. | `src/devices.js:46-80` |
| 7 | Settings form offers a **workRoot** field ("云端工作根目录，留空则用 `~/dsh-work`") (tool description, `src/tools.js:218`; also `client.js:468`) | `workRoot` is persisted but **never read**. `remoteRoot` is always `$HOME/dsh-work/<project>`. | `src/service.js:453`, `src/devices.js:139` |
| 8 | "每台设备可以『检测』：探测连通性、node/dsh/**执行器**是否就绪，显示『就绪 / 缺运行时 / 不可达』" (README.md:61) | The 就绪/缺运行时 decision ignores the runner. `ready` = node && dsh only. A host missing `dsh-job` still shows 就绪. | `src/service.js:380-381`, `client.js:581-583` |
| 9 | README config block shows `hosts` as the sole way to add a host (README.md:135-147) — "加一台新主机: 在 `hosts` 下加一条" | After the device registry shipped, the **primary** path is `remote_devices({action:"bind"})` / the Settings page, writing `devices.json`. `hosts` is now only a cold-start seed (see #6). Following the README on an existing install silently does nothing. | `src/devices.js:55-76`, `src/service.js:58-62` |
| 10 | "**9 个工具**" table lists `remote_devices` first, implying it is registered like the others | It is registered in the same `registerTools`, so that part is fine — but README's "显式调用示例" only covers `remote_dispatch` and never shows `host:` being **required again on follow-up calls**. Users lose jobs by omitting `host` on `remote_result`. | `src/service.js:132-136`, `src/tools.js:34-37` |
| 11 | "云端目录结构 … `meta.json` 工作目录、session id、提交时间" (README.md:186) | Also contains `id` and `host` (`hostname` of the machine). And the README omits the per-job `pid` file entirely. | `remote/dsh-job.sh:57-59, 81` |
| 12 | "`status  queued \| running \| done \| failed \| cancelled`" (README.md:185) — presented as exhaustive | `remote_status` can also return **`unknown`** when the `status` file is unreadable, and `remote_wait` can return **`timeout`**. | `src/service.js:607, 690` |
| 13 | "任务按主机串行排队（flock），避免抢资源" (README.md:193) | Correct, but the implication people miss is that `queued` is normal and can last hours. Worth stating explicitly; the README does not. | `remote/dsh-job.sh:72-74` |
| 14 | "`dsh --profile headless --dump-config`" as the way to check the headless profile (README.md:158) | Nothing in the plugin runs this; it is advice only. Harmless, but note that the profile actually used is `$DSH_PROFILE`, defaulting to `headless` and **overridable on the host** — the plugin never checks it. | `remote/dsh-job.sh:22` |
| 15 | "3. 密钥轮换：… 换 key 时两台都要更新，否则报 `MISSING_CREDENTIAL`" (README.md:201) | ✓ Accurate, and confirmed: `dsh` is sourced `KEY_ENV_FILE` before running, and its stderr is copied into `run.log` at the end (`remote/dsh-job.sh:85-87, 139`). Listed as a *verified* item rather than an inaccuracy. | — |

**Additional stale details not in the README at all:**

- The README's "安装与启用" hard-codes `~/.dsh/profiles/node_modules/dsh-remote-dispatch`
  and both profiles; the real location is `DSH_HOME`-relative, and `headless` does not
  get the composer button (no `connection`/`webServer` services), only the tools
  (`index.js:81-85`).
- `remote_dispatch` via the composer button cannot set `jobId` or read the conversation
  history — the button sends only `{task, host, project, localDir}` (`client.js:279-286`,
  `src/rpc.js:160-167`).

---

## 23. Quick answers (misc)

- **Does the plugin need any npm dependencies?** No. `package.json` has no `dependencies`
  block at all; `ssh`, `tar`, `csc.exe` and `python3` are shelled out to
  (`package.json:1-42`, `src/ssh.js:240`, `src/service.js:421`, `remote/dsh-job.sh:114`).
- **What happens if I pass `probe:false`?** `remote_hosts` returns `{host, label,
  credentialId}` per device with zero SSH traffic (`src/tools.js:71-75`).
- **Can two devices point at the same SSH credential?** Yes; nothing enforces
  uniqueness, and each keeps its own `SshTarget` cache entry keyed by device name
  (`src/service.js:157-169`).
- **What if the credential record has no `port`?** Defaults to `22`
  (`src/service.js:341`).
- **What if `username` is empty?** Defaults to `root` (`src/service.js:342`).
- **Does deleting a device delete jobs on the server?** No — unbind only rewrites
  `devices.json` (`src/devices.js:151-164`).
- **Is there a way to download a file from the cloud?** Not exposed as a tool. The
  transport has `SshTarget.download()` (`src/ssh.js:355-365`) but no tool or RPC endpoint
  calls it, so you must `scp`/`ssh` manually.
