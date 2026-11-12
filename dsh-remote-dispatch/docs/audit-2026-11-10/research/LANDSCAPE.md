# Landscape: Running Long Agent/Coding Tasks on a Remote Server So They Survive Local Disconnection

**Scope:** competitive analysis of `dsh-remote-plugin` (internal) vs. state-of-the-art approaches.
**Date:** 2026-11-10
**Method:** documentation review (primary sources preferred) + source-code read of the internal plugin. Claims that could not be confirmed against a primary source are explicitly marked **unverified**.
**Caveat on tooling:** `web_search` was non-functional in this environment (fetch failure to its messages endpoint); research used `web_fetch` against primary docs plus an alternate search index. Where a page refused programmatic extraction (e.g. `devin.ai` docs, `openai.com/index/...`) I cite the search result that surfaced the claim and mark the specific detail **unverified**.

---

## 0. What the internal plugin actually does (baseline)

Read from [`dsh-remote-plugin/README.md`](../../dsh-remote-plugin/README.md) and [`dsh-remote-plugin/remote/dsh-job.sh`](../../dsh-remote-plugin/remote/dsh-job.sh).

| Mechanism | Implementation |
|---|---|
| Transport | SSH from the DSH desktop agent to a cloud host, credentials pulled from a local credential vault (never written into config) |
| Launch | `setsid nohup "$0" __worker … >>run.log 2>&1 </dev/null &` — detached from the SSH session |
| Work dir | `~/dsh-work/<project>/`, jobs under `~/dsh-jobs/<job-id>/` |
| State | A plain `status` file (`queued\|running\|done\|failed\|cancelled`) is the source of truth |
| Concurrency | One serial queue per host via `flock` on `$DSH_JOB_ROOT/.queue.lock` |
| Output | `events.jsonl` (full DSH event stream), `result.md` (extracted `type=final` event), `run.log`, `err.log` |
| Resume | `--session-id <sid>` re-attaches DSH conversation context |
| Cancel | `kill -TERM -- -$pid` then `kill -KILL -- -$pid` on the process group |

Notably absent from the code: any `systemd`/`supervisor` integration, restart-on-crash, retry, resource limits, TTL cleanup, and notify-on-complete. `grep` across the plugin for `notify|telegram|mail|systemd|supervis|cron|retry|checkpoint|resume` returned only a single incidental JS-doc comment match.

---

## 1. Comparison table

Legend for **setup cost**: S = minutes, M = an afternoon, L = days/ongoing ops.

| Approach | Survives disconnect | Survives reboot | Multi-host | Resumable logs | Setup cost | Best fit |
|---|---|---|---|---|---|---|
| **Internal `dsh-remote-plugin`** (`setsid`+`nohup`) | ✅ Yes — detached from SSH session | ❌ No — no unit, no respawn | ⚠️ Per-host binding list only; no fan-out, no cross-host queue | ✅ `events.jsonl` + `result.md` + `run.log` | S | One interactive agent task on one known box, fire-and-forget |
| **tmux / screen / abduco** | ✅ Yes — server survives client detach | ❌ No (tmux server dies with the box) | ❌ No | ⚠️ Only via scrollback; `pipe-pane` to a file | S | Human-in-the-loop interactive sessions |
| **`nohup` + `setsid` plain** | ✅ Yes — SIGHUP ignored, new session | ❌ No | ❌ No | ⚠️ Only what you redirect to files | S | Throwaway one-shot jobs |
| **`systemd-run --scope/--transient unit`** | ✅ Yes — managed by PID 1 / user manager | ⚠️ Not for `--scope` or transient units; ✅ if written as an enabled `.service` + `enable-linger` | ❌ No | ✅ `journalctl -u <unit>` | M | First real upgrade from `nohup`; supervision + logs + cgroup limits |
| **Ansible** | ❌ No — the connection *is* the execution; task dies with it | ❌ No | ✅ Yes — inventory-wide, `serial`, `throttle` | ❌ No native job log retrieval | M | Environment provisioning and fan-out, **not** long-task execution |
| **SSH-MCP / remote MCP tool servers** | ❌ Usually no — tool call is the session | ❌ No | ⚠️ Per-server | ❌ No | S | Giving an agent ad-hoc shell access, not durable jobs |
| **GitHub Actions self-hosted runner** | ✅ Yes — runner daemon owns the job | ✅ Yes — runner restarts as a service | ✅ Yes | ✅ Job logs + artifacts | M | Git-triggered, auditable, repeatable tasks |
| **Slurm** | ✅ Yes | ✅ Yes (jobs requeue) | ✅ Yes — true cluster scheduler | ✅ `slurm-%j.out` + job accounting | L | Multi-node compute with real queueing and resource limits |
| **Celery / RQ workers** | ✅ Yes (broker holds the message) | ✅ Yes (worker reconnects) | ✅ Yes | ⚠️ Result backend, not a live log tail | M | App-integrated fan-out where you own the code |
| **Cloud agent runners** (Codex Cloud, Cursor Cloud Agents, Claude Code Remote Control/web, Devin, OpenHands, Coder Agents) | ✅ Yes — designed for it | ✅ Yes (managed) or ⚠️ (self-hosted) | ✅ Yes — parallel agents | ✅ Yes — durable transcript, artifacts, remote desktop | S (SaaS) / L (self-host) | The actual SOTA target for "background agent on a VM" |
| **SWE-ReX / SWE-agent / Aider** | ⚠️ SWE-ReX: managed shell sessions; Aider: local CLI | ❌ No | ✅ SWE-ReX (100s in parallel) | ⚠️ Partial | S–M | Research/eval harnesses; SWE-ReX is the closest architectural sibling |
| **Mosh** | ✅ Yes — roams across IP changes, laptop sleep | ❌ No (it's a transport, not a supervisor) | ❌ No | ❌ No | S | Flaky mobile/long-haul links |
| **tmux-resurrect / tmux-continuum** | ✅ (tmux) | ⚠️ Restores *layout and program command lines*, not process state | ❌ No | ⚠️ Optional pane-content capture | S | Human comfort after a reboot, not task durability |

---

## 2. Per-approach analysis

### 2.1 tmux / screen / abduco

**Strengths.** These are the original answer to "my SSH session died". `abduco` is explicit about the contract: it "allows programs to be run independently from their controlling terminal … programs can be detached … and then later reattached" ([brain-dump.org/projects/abduco](https://www.brain-dump.org/projects/abduco/)). `abduco` also keeps and reports **session exit status** across disconnects, and supports read-only attach — both useful properties an agent harness wants.

**Weaknesses.** They solve *client* detach only. The server process tree still lives on the box; nothing restarts it. Logs are terminal scrollback unless you explicitly `pipe-pane`/redirect. There is no exit code, no artifact directory, no structured status — precisely the things an orchestration layer needs.

**Failure modes.** Reboot/OOM-kill/cloud host reschedule ⇒ session gone with no record. Attaching from an automated process is awkward (needs a pty, produces escape sequences). tmux's default prefix keys and terminal handling can corrupt captured output.

**When it's right.** A human is going to look at this later and wants to type into it. For agent dispatch, tmux is strictly worse than `nohup` for capture, and strictly worse than systemd for durability. Its one genuine niche: an escape hatch for interactive debugging on a box you already have.

### 2.2 `nohup` + `setsid` plain background jobs

**Strengths.** Zero dependencies, works on any POSIX box, trivially scriptable, and it genuinely solves the primary stated requirement. This is what the internal plugin does, and the plugin's README claim — "本地断网、关机、休眠都不影响云端继续跑完" — is correct for the disconnect case.

**Weaknesses.** A detached process is *unsupervised*. If it segfaults, gets OOM-killed, or the host reboots, the `status` file is left at `running` forever and no one is told. There is no cgroup, so one runaway agent can starve a 2-core VPS. There is no retry, no queue semantics beyond a `flock`, no resource accounting, and no event stream into any supervisor.

**Failure modes.** (a) **Stale `running`** — the single most likely real-world bug in the current design; the job looks alive forever. (b) `KillUserProcesses=yes` in `/etc/systemd/logind.conf` makes logind reap *all* the user's processes at logout including `nohup` jobs, which is a documented hazard ([systemd issue #8486](https://github.com/systemd/systemd/issues/8486), [ucartz KB on nohup + logind](https://www.ucartz.com/clients/knowledgebase/1995-Run-a-Linux-Command-in-the-Background-with-nohup-and-disown.html)). (c) PID reuse makes `kill -0 $pid` in `cmd_status` unreliable.

**When it's right.** Prototyping, single-shot scripts, environments where systemd isn't available or can't be modified. It is a reasonable *floor*, not a design.

### 2.3 `systemd-run` — transient units and `--scope`

**Strengths.** `systemd-run` "may be used to create and start a transient .service or .scope unit and run the specified COMMAND in it" ([freedesktop.org man page](https://www.freedesktop.org/software/systemd/man/systemd-run.html)). That buys cgroup-based resource limits (`MemoryMax=`, `CPUQuota=`), automatic log capture into the journal (`journalctl -u <unit>`), structured exit status, `--collect` garbage collection, and restart policy — all the supervision the `nohup` approach lacks — with a **one-line** change.

**Weaknesses / the critical trap.** A `--scope` or transient unit is *still not boot-persistent*, and by default the per-user manager dies with the last session. The ArchWiki is blunt: "Using `systemd-run` will keep the process running after logout only while the user is logged in at least once somewhere else in the system and `user@.service` is still running"; and after all sessions close, `user@.service` terminates "unless the user has 'lingering' enabled" ([wiki.archlinux.org/title/Systemd/User](https://wiki.archlinux.org/title/Systemd/User)). So `systemd-run --user` **without** `loginctl enable-linger` is *not* equivalent to a system service and can be *less* reliable than setsid+nohup.

**Failure modes.** Forgetting `enable-linger` ⇒ silent death at logout. Transient units vanish on reboot ⇒ same. Unit name collisions between concurrent jobs. User units `can not reference or depend on system units or units of other users` (same source), so you can't order after `network-online.target` from a user unit.

**When it's right.** The correct next step for this plugin: `systemd-run --user --unit=dsh-<jobid> --collect -p MemoryMax=…` once `loginctl enable-linger` is set, or better a real boot-persistent `.service`. This is the highest value-per-line-of-code upgrade available.

### 2.4 Ansible

**Strengths.** The best tool in this list for *convergent, inventory-driven, multi-host* work: `serial` batches, `throttle` for CPU-heavy tasks, `any_errors_fatal`, per-host role application ([docs.ansible.com – strategies](https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_strategies.html)). Its inventory model (a host's connection details as data) is exactly the right shape for a "device registry" and is worth copying conceptually.

**Weaknesses.** It is a **configuration management** tool, not a job scheduler. A playbook task is bound to the SSH connection that executes it; there is no durable task record the way there is for Slurm or a runner. A long `command:` task that outlives the connection is a known anti-pattern, and there is no built-in "fetch job N's log".

**Failure modes.** Long-running task + flaky connection ⇒ partial application with no clean resume. Using Ansible as the *executor* for an agent task means re-inventing detached launch inside a `shell:` task — you end up back at `nohup`, but with more layers.

**When it's right.** Provisioning *the boxes* (install node/DSH/`dsh-job`, ensure directories, set `linger`) and for one-shot fan-out commands across many hosts. Use it to make the environment ready; do not use it to carry the long task.

### 2.5 SSH-MCP / remote MCP tool servers

**Strengths.** These expose SSH operations to an LLM agent as structured MCP tools, commonly with `~/.ssh/config` host discovery and key/password auth ([Lobehub: MCP SSH Agent](https://lobehub.com/mcp/aiondadotcom-mcp-ssh), [MCP SSH Server listing](https://mcpservers.org/servers/shaike1/mcp-server-ssh)). The architectural win is the same one the internal plugin already has: the agent gets *tools*, not a shell — which keeps credentials out of the prompt.

**Weaknesses.** Almost all of them are synchronous wrappers: `execute(command)` returns output and the call ends. They give you reach, not durability. None in the surveyed set implement submit/status/result/cancel semantics over detached jobs (i.e. exactly the surface the internal plugin already implements).

**Failure modes.** Long command + tool timeout ⇒ the agent sees failure while the remote process keeps running (or gets killed). No idempotency. Output truncation on large results.

**When it's right.** When the agent only needs short, interactive commands. The internal plugin is *ahead* of the generic SSH-MCP ecosystem here, because it already separates dispatch from retrieval. The MCP angle is still worth adopting — shipping the job control surface as an MCP server would make it reusable outside DSH.

### 2.6 GitHub Actions self-hosted runners

**Strengths.** A runner is a long-lived daemon; jobs dispatched to it outlive the triggering client by construction. GitHub documents that self-hosted runners "Are free to use with GitHub Actions, but you are responsible for the cost of maintaining the runner machines" and "Don't need to have a clean instance for every job execution" ([docs.github.com – self-hosted runners](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners)). That last property is exactly what you want for a stateful agent workspace.

**Weaknesses.** You must express work as a workflow in a repo, with GitHub as the control plane — a heavy yoke for "run this ad-hoc task". Runner isolation is described elsewhere as weak ("implemented as regular processes with no virtualization or isolation from the OS", [Stack Overflow](https://stackoverflow.com/questions/65071861/where-does-self-hosted-github-runner-executes-the-code-is-having-multiple-runners)); running an agent with write access on a persistent runner is a real security question. Requires a GitHub dependency and outbound connectivity from the VPS.

**Failure modes.** Runner goes offline → job stuck in "Waiting for a hosted runner to come online" (this is the *hosted* pool message, but the same class of stall applies to a self-hosted runner that vanishes mid-job; **unverified** for the self-hosted case specifically). Workflow cancel semantics are coarse.

**When it's right.** Scheduled/repo-scoped automation — nightly dependency bumps, issue-triage agents — where the trigger is a git event anyway and you want audit trails for free.

### 2.7 Job schedulers: Slurm, Celery, RQ

**Slurm strengths.** The only option here with *real* queue semantics: priorities, fair-share, walltime limits, `--requeue`, dependencies (`afterok`/`afterany`), and per-job stdout/stderr files (`slurm-%j.out`) ([slurm.schedmd.com/sbatch](https://slurm.schedmd.com/sbatch.html)). Requeue on preemption/timeout is a first-class concept ([scontrol](https://slurm.schedmd.com/scontrol.html), [Utah CHPC requeue guide](https://it.sci.utah.edu/slurm-job-re-queuing/)). Checkpoint-and-self-requeue is the standard pattern for very long jobs ([Cedana: Slurm time limits](https://cedana.com/blog/slurm-time-limit/)).

**Slurm weaknesses.** Enormous operational cost for two VPSes. It assumes shared storage and a cluster. Total overkill.

**Celery/RQ.** The broker holds the message until acknowledged; "A worker can reserve many messages in advance and even if the worker is killed … the message will be redelivered to another worker" ([docs.celeryq.dev – Tasks](https://docs.celeryq.dev/en/stable/userguide/tasks.html)). That is genuine at-least-once delivery and real multi-host fan-out. But it requires you to own a Python service, add Redis/RabbitMQ, and Celery's own docs warn about non-idempotent redelivery, hot failure loops, and OOM-prone tasks — all of which an LLM agent exhibits. RQ is simpler but "Celery with the right message broker can achieve better reliability than RQ with Redis alone" ([judoscale](https://judoscale.com/blog/choose-python-task-queue)).

**When it's right.** Slurm: only if you already have a cluster. Celery/RQ: if the plugin ever becomes a *service* with many submitters and you need real queueing — otherwise `flock` + a directory is a better cost/benefit.

### 2.8 Cloud agent runners (the SOTA target)

This is the category the plugin is competing with, and the design patterns are consistent across products:

- **Cursor Cloud Agents** (formerly Background Agents): "run in isolated VMs in the cloud with full development environments"; they "do not require your local machine to be connected to the internet"; Cursor "manages VM provisioning, isolation, snapshots, startup, artifacts, and capacity"; agents emit "screenshots, videos, and logs"; a working `Remote desktop control` lets a human take over the same VM ([cursor.com/docs/cloud-agent](https://cursor.com/docs/cloud-agent)).
- **OpenAI Codex Cloud**: runs coding tasks on OpenAI-managed computers, "so work can continue while your computer is asleep" ([help.openai.com](https://help.openai.com/en/articles/20001545-using-codex-cloud)); environments are now reusable/persistent rather than per-task sandboxes ([TechCrunch](https://techcrunch.com/2026/09/29/openai-gives-codex-reusable-cloud-environments-that-work-across-devices/), date on that URL is **unverified**).
- **Claude Code**: dev-container execution with a documented way to persist state across rebuilds (a named volume at `~/.claude` plus `CLAUDE_CONFIG_DIR`) ([code.claude.com/docs/en/devcontainer](https://code.claude.com/docs/en/devcontainer)); and Remote Control, which explicitly markets "**Survive interruptions**: if your laptop sleeps or your network drops, Claude Code reconnects automatically" and keeps terminal/browser/phone in sync ([code.claude.com/docs/en/remote-control](https://code.claude.com/docs/en/remote-control)).
- **Devin**: parallel cloud agents in per-session sandboxes/VMs, tasked via Slack/Teams ([devin.ai](https://devin.ai/), [augmentcode comparison](https://www.augmentcode.com/tools/intent-vs-devin)). Exact VM-snapshot/resume mechanics: **unverified**.
- **Coder Agents**: the most architecturally instructive — the **agent loop runs in the control plane, not the workspace**; workspaces have "no LLM API keys, no agent harnesses, and no special software"; "All chat state is stored in the Coder database, not in the workspace. If a workspace is stopped, deleted, or rebuilt, the full conversation history survives"; and messages sent mid-run are queued and delivered at the next step ([coder.com/docs/ai-coder/agents](https://coder.com/docs/ai-coder/agents)).
- **OpenHands**: Agent Canvas is a self-hosted control center that "can connect to multiple 'agent backends', e.g. running agents in Docker containers, on VMs, or within your company infrastructure", with an Agent Server REST API per host and a separate Automation Server for scheduling ([github.com/OpenHands/openhands](https://github.com/OpenHands/openhands)). Multi-backend switching from one frontend is the key idea.

**Weaknesses of the whole category.** SaaS versions cost money and put your code on someone else's disk; self-hosted versions (OpenHands, Coder) are days of setup. They also assume git as the handoff medium — a poor fit for the ad-hoc "run this task on my box" use case the internal plugin targets.

**Failure modes.** Snapshot/env drift ("works locally, not in the cloud"); agents that can't run tests in their env produce unverifiable work — Cursor's own docs call environment setup "the most important step"; credential leakage into long-lived VMs.

**When it's right.** Whenever you can accept a managed VM. For this project, the point is not to replace the plugin with Cursor — it's that the plugin should match their *UX properties*: durable state outside the process, artifacts, queued follow-ups, and notification.

### 2.9 SWE-ReX / SWE-agent / Aider

**SWE-ReX** is the closest architectural sibling to what the plugin does and deserves attention: it is "a runtime interface for interacting with sandboxed shell environments, allowing you to effortlessly let your AI agent run any command on any environment", supporting local, Docker, AWS, and Modal backends with the same agent code; it "will recognize when commands are finished, extract the output and exit code and return them to your agent", supports interactive tools like `gdb`/`ipython`, and runs hundreds of agents in parallel ([swe-rex.com](https://swe-rex.com/)). That is the abstraction the plugin is currently hand-rolling over SSH.

**SWE-agent itself is now in maintenance mode** in favour of mini-swe-agent ([swe-agent.com](https://swe-agent.com/latest/)) — a reminder that the harness churns while the *transport* layer (SWE-ReX) is the durable part.

**Aider** is a local, git-native terminal pair programmer ([aider.chat](https://aider.chat/)); it has no remote/durable execution story. Its valuable idea for us is different: **every change is a git commit**, which gives crash recovery for free.

**When it's right.** SWE-ReX if you want a maintained multi-backend execution layer instead of maintaining `dsh-job.sh` yourself.

### 2.10 Mosh

**Strengths.** Mosh "allows roaming, supports intermittent connectivity": change IP, sleep the laptop, resume later ([mosh.org](https://mosh.org/)). It is structurally more robust than TCP — "an attacker can end an SSH connection with a single phony 'RST' segment. By contrast, Mosh applies its security at a different layer (authenticating every datagram)".

**Weaknesses.** Mosh is a *transport*. The FAQ-level caveat across the field: "Mosh keeps the connection alive; tmux keeps the session alive. They solve different halves of the problem" ([getmoshi.app](https://getmoshi.app/articles/mosh-vs-ssh)); and "You will need to use a tmux session (or similar) on the server" ([Reddit r/programming discussion](https://www.reddit.com/r/programming/comments/8dntae/mosh_the_mobile_shell_an_ssh_replacement_that/)). Mosh is also "No privileged code. No daemon" — which means it cannot help an agent that has no human attached at all.

**Failure modes.** Needs UDP ports; some corporate networks/CGNAT break it. UTF-8-only. Interactive-only — of no use to a headless dispatcher.

**When it's right.** For the *human console* debugging a stuck job on a bad link. For the plugin's automated path it is irrelevant — the plugin's `remote_dispatch` already returns immediately, which beats any interactive transport.

### 2.11 tmux-resurrect / tmux-continuum

**Strengths.** "Restore `tmux` environment after system restart" — saves sessions, windows, panes, cwd, and pane layouts, and optionally pane contents and vim/neovim sessions ([github.com/tmux-plugins/tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect)); continuum adds periodic auto-save and auto-restore ([tmux-continuum](https://github.com/tmux-plugins/tmux-continuum)).

**Weaknesses.** The critical limitation is in the resurrect docs themselves: it restores **"programs running within a pane"**, and only "a conservative list of programs is restored by default: `vi vim nvim emacs man less more tail top htop irssi weechat mutt`". An agent process is not on that list, and even for listed programs it's a *re-launch*, not a restore of mid-flight state. So "survives reboot" is an illusion: you get the shell back, not the work.

**When it's right.** Human comfort and context restoration. Do not rely on it for task durability.

---

## 3. Gap analysis: internal plugin vs. the best of the above

### 3.1 What it has that others lack

Worth stating first, because the recommendations should preserve these:

1. **Credential indirection done right.** Only a `credentialId` appears in config; passwords/keys never enter the prompt or the config file. Most SSH-MCP servers are weaker here.
2. **Status-with-partial-result semantics.** `remote_result` on a running job returns partial output with a warning rather than blocking — better ergonomics than Ansible, comparable to cloud runners.
3. **Context-level resume.** `continueSession` maps to `dsh --session-id`, so "task continuity" is at the conversation level, not just the process level. Coder Agents explicitly cites chat persistence as a feature; this plugin already has a rougher version of it.
4. **A real event stream.** `events.jsonl` capture of the full DSH event stream (reasoning + usage) is closer to what a serious harness records than `run.log` alone.

### 3.2 Gaps, with severity

| # | Gap | Evidence in code / docs | Why it matters | Severity |
|---|---|---|---|---|
| G1 | **No survival across host reboot** | `submit` launches a bare `setsid nohup`; no unit, no crontab, no boot hook | A VPS reboot or cloud host reschedule silently orphans every `running` job. Requirement stated in the task brief is unmet. | **High** |
| G2 | **No process supervision / stale `running`** | `status` is a file written by the worker; if the worker dies, nothing rewrites it. `cmd_status` uses `kill -0 $pid` which is PID-reuse-prone | Jobs appear alive forever; `remote_result` returns "(job is running; showing partial output)" indefinitely. The most common real failure. | **High** |
| G3 | **No notify-on-complete** | No notification code anywhere in the plugin | Defeats the entire product premise: you dispatch, disconnect, and then must *poll*. Cloud runners all push (Slack/PR/email). | **High** |
| G4 | **No crash-resume / retry** | No retry logic; on `rc!=0` the job is just marked `failed` | An agent task that dies at 90% (OOM, transient API error) loses all work. Slurm's `--requeue` and Celery's redelivery exist precisely for this. | **High** |
| G5 | **No resource limits** | No `MemoryMax`, no `CPUQuota`, no cgroup, no ulimit | A runaway agent OOMs a 2 GB VPS, potentially killing the SSH daemon and locking you out. `systemd-run` solves this in one flag. | **Med-High** |
| G6 | **Queue is capacity-1 and per-host only** | `flock` single lock per host; one job at a time; no cross-host placement | Two hosts = two independent queues with no routing. Users must pick a host manually (`host` param), so no failover and no load-aware placement. | **Med** |
| G7 | **No TTL / disk cleanup** | README explicitly: "磁盘不会自动清理：定期清 `~/dsh-jobs` 旧任务" | `events.jsonl` grows unbounded; a 2H2C disk fills and jobs start failing enigmatically. | **Med** |
| G8 | **No structured lifecycle events / observability** | Plain-text `status` file, no timestamps per transition, no metrics | Cannot answer "how long did it queue vs. run", "what's my failure rate", "did it get OOM-killed". | **Med** |
| G9 | **No mid-run input** | `dsh-job.sh` has no way to feed additional messages into a running job | Cursor/Claude/Coder all support steering. In the plugin, steering requires killing and re-dispatching with `continueSession`. | **Med** |
| G10 | **No isolation / sandboxing** | Job runs as the login user, full FS access, network open | A misbehaving or prompt-injected agent can `rm -rf` the host. Cloud runners use per-task VMs/containers; the plugin has nothing. | **Med** (Low for a trusted single-user box) |
| G11 | **Narrow adapter surface** | Tied to the `dsh-job.sh` script and the DSH CLI's `--json` event format | Cannot drive the same job model over Docker/Modal/K8s; SWE-ReX already abstracts this. | **Low-Med** |
| G12 | **Cancel is racy** | `cmd_cancel` writes `cancelled` then kills the process group; worker may already have written `done` | A cancelled job can end up `done`, and `kill -TERM -- -$pid` requires the worker to be a process-group leader | **Low** |

### 3.3 Ranked recommendations

Ranked by (user-visible value × frequency of pain) ÷ effort. Effort: **S** ≤ half a day, **M** ≈ 1–3 days, **L** ≥ 1 week.

| Rank | Recommendation | Addresses | Effort | Sketch |
|---|---|---|---|---|
| **1** | **Supervise jobs with `systemd` and make liveness authoritative** — replace `setsid nohup` with `systemd-run --user --unit=dsh-<jobid> --collect -p MemoryMax=…` (plus `loginctl enable-linger`), and treat `systemctl --user show -p ActiveState,ExecMainStatus -p Result` as the truth instead of a hand-written `status` file | G1 (partial), G2, G5, G8 | **S–M** | The unit either is or isn't active; `Result=oom-kill` gives you G5 attribution for free; `journalctl --user-unit` gives G8 for free. This single change retires three high-severity gaps. Note the lingering caveat from [ArchWiki](https://wiki.archlinux.org/title/Systemd/User). |
| **2** | **Push notification on terminal state** — one `curl` to a webhook (or `apprise -t … -b … <url>`, which supports Telegram/Discord/Slack/email and 100+ services, [github.com/caronc/apprise](https://github.com/caronc/apprise)) fired from a systemd `ExecStopPost=` or from the worker's exit path | G3 | **S** | Turns the product from "dispatch and remember to poll" into "dispatch and get pinged". This is the single highest UX-per-byte change. Cursor/Claude/Coder all treat this as table stakes. |
| **3** | **Crash-resume and bounded retry** — persist the DSH session id and last completed step; on abnormal exit, auto re-dispatch with `continueSession=<sid>` up to N times before giving up | G4 | **M** | The plugin already has `--session-id` resume; this only wires the death path into it. Slurm's `--requeue` and Celery's redelivery are the reference semantics ([Celery docs](https://docs.celeryq.dev/en/stable/userguide/tasks.html)). Must guard against hot retry loops (Celery's documented failure mode). |
| **4** | **Boot-persistent recovery sweep** — a `dsh-job-recover` oneshot service/timer that on boot scans `status==running` jobs whose unit is dead and either resumes or marks them `crashed` | G1 (full), G2 | **S–M** | 20 lines of shell on top of #1. This is the "what the cloud runners get by having a control plane" answer, at VPS scale. |
| **5** | **Queue with cross-host placement + TTL cleanup** — replace the per-host `flock` with a small placement policy in the client (host health + running count) and add an age-based reaper for `~/dsh-jobs` and `~/dsh-work` | G6, G7 | **M** | Not urgent for two boxes, but it is the difference between "a script" and "a scheduler". Keep the `flock` as the in-host guard; add placement above it. |
| 6 | **Structured lifecycle** — write `meta.json` transitions with timestamps (`submitted_at`, `started_at`, `ended_at`, `exit_code`, `result_kind ∈ {done, failed, oom, cancelled, crashed}`) and expose `remote_stats` | G8, and makes #1/#3 verifiable | **S** | Cheap; makes every later claim measurable. |
| 7 | **Mid-run steering** — a FIFO/inbox file per job the worker drains between steps, exposed as `remote_send` | G9 | **M** | Matches Cursor follow-ups and Coder's "Messages are queued and delivered when the agent completes its current step" ([Coder docs](https://coder.com/docs/ai-coder/agents)). |
| 8 | **Containerise the job** — run the worker in `docker run --rm --memory=… --network=…` instead of as the login user | G10 | **M** | Needed the moment an agent runs untrusted code. Also makes the environment reproducible (Cursor's "environment setup is the most important step" lesson). |
| 9 | **Extract the transport into an adapter interface** — `submit/status/logs/result/cancel` over pluggable backends (SSH-systemd, Docker, Modal, K8s) | G11 | **L** | SWE-ReX has already proven this abstraction ([swe-rex.com](https://swe-rex.com/)); the plugin could implement the same interface rather than invent a parallel one. |

---

## 4. Prior art we should crib from

1. **Coder Agents — keep agent state out of the execution host.** "All chat state is stored in the Coder database, not in the workspace. If a workspace is stopped, deleted, or rebuilt, the full conversation history survives." → *Our `meta.json`/session id should live on the client side (or a durable store) so a rebuilt host doesn't erase task identity.* ([coder.com/docs/ai-coder/agents](https://coder.com/docs/ai-coder/agents))
2. **Coder Agents — message queuing during a run.** "Messages are queued and delivered when the agent completes its current step." → *Directly informs recommendation #7; it makes the job interactive without a persistent connection.* (same link)
3. **Cursor Cloud Agents — artifacts as the output contract.** Agents "produce screenshots, videos, and logs so you can see exactly what changed and how the agent verified its work." → *`result.md` alone is thin; the plugin should always collect a standard artifact bundle.* ([cursor.com/docs/cloud-agent](https://cursor.com/docs/cloud-agent))
4. **Cursor Cloud Agents — remote desktop takeover of the same VM.** "Take control of the agent's desktop to test the software yourself … Release control back to the agent." → *Suggests an `remote_attach` affordance: drop a human into the same workspace without forking it.* (same link)
5. **Claude Code Remote Control — reconnect, don't resubmit.** "if your laptop sleeps or your network drops, Claude Code reconnects automatically when your machine comes back online." → *The client should poll/resume by job id transparently, never ask the user to restart the task.* ([code.claude.com/docs/en/remote-control](https://code.claude.com/docs/en/remote-control))
6. **Claude Code devcontainers — persist the agent's own state dir explicitly.** Mount a named volume at `~/.claude` and set `CLAUDE_CONFIG_DIR` so auth/session history survives rebuilds. → *The analogue: persist `~/.dsh` (or the headless profile) on the remote host so `--session-id` resume actually works after a rebuild.* ([code.claude.com/docs/en/devcontainer](https://code.claude.com/docs/en/devcontainer))
7. **SWE-ReX — disentangle agent logic from infrastructure.** Same agent code runs local/Docker/AWS/Modal; it "will recognize when commands are finished, extract the output and exit code". → *Blueprint for recommendation #9; also a candidate to just adopt instead of maintaining `dsh-job.sh`.* ([swe-rex.com](https://swe-rex.com/))
8. **Slurm — requeue as a first-class lifecycle state.** `--requeue`, `scontrol requeue`, and the checkpoint-then-`scontrol requeue` pattern for walltime-bounded long jobs. → *Normative vocabulary for a `crashed`/`requeued` status and for bounded auto-resume.* ([sbatch](https://slurm.schedmd.com/sbatch.html), [scontrol](https://slurm.schedmd.com/scontrol.html), [Cedana](https://cedana.com/blog/slurm-time-limit/))
9. **Celery — at-least-once delivery with an explicit idempotency contract.** Message isn't removed until acknowledged; redelivery after worker death; explicit warnings about non-idempotent/looping/OOM tasks. → *Copy the vocabulary even if you don't copy the stack: our resume-on-crash must be explicitly idempotent and rate-limited.* ([docs.celeryq.dev](https://docs.celeryq.dev/en/stable/userguide/tasks.html))
10. **abduco — persist and report exit status across disconnects.** "the session exit status of the command being run is always kept and reported either upon command termination or on reconnection". → *Small but precise: a job viewed after 8 hours should still report its true exit status and termination cause.* ([brain-dump.org/projects/abduco](https://www.brain-dump.org/projects/abduco/))
11. **systemd — supervision primitives, done.** `systemd-run` transient units, `--collect`, journal capture, cgroup limits; `systemd` credentials (`LoadCredential=`, `$CREDENTIALS_DIRECTORY`) as a better secret channel than env vars, since "by default [env vars] are inherited down the process tree". → *Adopt creds for the model API key: the plugin currently sources `~/.dsh/.env.headless` with `set -a`, exporting the key into every child process.* ([systemd-run](https://www.freedesktop.org/software/systemd/man/systemd-run.html), [systemd.io/CREDENTIALS](https://systemd.io/CREDENTIALS/))
12. **Apprise — one-line, multi-channel completion notification.** → *Cheapest implementation of recommendation #2.* ([github.com/caronc/apprise](https://github.com/caronc/apprise))
13. **Ansible — inventory-as-data.** Host connection metadata as declarative inventory with `serial`/`throttle` semantics. → *The device-registry shape is right; borrow the semantics (batches, throttling) for the placement policy in #5, not the engine.* ([docs.ansible.com](https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_strategies.html))
14. **GitHub Actions self-hosted runners — a long-lived daemon that "Don't need to have a clean instance for every job execution".** → *Validates the persistent-workspace design; the runner model (daemon pulls work) is an alternative to our push model if we ever need NAT'd or firewalled hosts.* ([docs.github.com](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners))

---

## 5. Bottom line

The internal plugin has already made the **correct core decision** — detach execution from the connection and make state a directory of files keyed by job id. That is the same insight the cloud runners sell. Its gap is entirely in the **lifecycle**: it has submit/status/result/cancel but no *supervision*, no *push*, no *recovery*, and no *limits*.

The 80/20 move is **not** a rewrite and **not** adopting Celery or Slurm. It is: put the worker under `systemd --user` with `enable-linger` and a `MemoryMax`, add an `ExecStopPost` notification, and add a boot-time recovery sweep that resumes dead-`running` jobs via the `--session-id` machinery that already exists. Three changes, roughly **S + S + S–M**, and the plugin matches the *observable* behavior of the SaaS runners for the single-user/multi-VPS case it actually targets.

---

## Appendix: source index

Primary documentation used (all fetched during this analysis unless marked):
[systemd-run(1)](https://www.freedesktop.org/software/systemd/man/systemd-run.html) · [ArchWiki systemd/User](https://wiki.archlinux.org/title/Systemd/User) · [systemd credentials](https://systemd.io/CREDENTIALS/) · [systemd issue #8486](https://github.com/systemd/systemd/issues/8486) · [abduco](https://www.brain-dump.org/projects/abduco/) · [mosh.org](https://mosh.org/) · [mosh vs ssh](https://getmoshi.app/articles/mosh-vs-ssh) · [tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) · [tmux-continuum](https://github.com/tmux-plugins/tmux-continuum) · [Ansible strategies](https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_strategies.html) · [GH self-hosted runners](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners) · [sbatch](https://slurm.schedmd.com/sbatch.html) · [scontrol](https://slurm.schedmd.com/scontrol.html) · [Celery tasks](https://docs.celeryq.dev/en/stable/userguide/tasks.html) · [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent) · [Claude Code devcontainers](https://code.claude.com/docs/en/devcontainer) · [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) · [Coder Agents](https://coder.com/docs/ai-coder/agents) · [OpenHands](https://github.com/OpenHands/openhands) · [OpenHands Agent SDK](https://github.com/OpenHands/software-agent-sdk) · [SWE-ReX](https://swe-rex.com/) · [SWE-agent](https://swe-agent.com/latest/) · [Aider](https://aider.chat/) · [Apprise](https://github.com/caronc/apprise) · [Codex Cloud](https://help.openai.com/en/articles/20001545-using-codex-cloud)

Secondary / corroborating:
[Utah CHPC Slurm requeue](https://it.sci.utah.edu/slurm-job-re-queuing/) · [Cedana Slurm time limits](https://cedana.com/blog/slurm-time-limit/) · [Judoscale task queue comparison](https://judoscale.com/blog/choose-python-task-queue) · [ucartz nohup/logind](https://www.ucartz.com/clients/knowledgebase/1995-Run-a-Linux-Command-in-the-Background-with-nohup-and-disown.html) · [SO: self-hosted runner isolation](https://stackoverflow.com/questions/65071861/where-does-self-hosted-github-runner-executes-the-code-is-having-multiple-runners) · [Lobehub MCP SSH Agent](https://lobehub.com/mcp/aiondadotcom-mcp-ssh) · [MCP SSH Server](https://mcpservers.org/servers/shaike1/mcp-server-ssh) · [TechCrunch on Codex environments](https://techcrunch.com/2026/09/29/openai-gives-codex-reusable-cloud-environments-that-work-across-devices/)

**Unverified items** (explicitly flagged in-line): exact Devin VM-snapshot/resume mechanics; the TechCrunch URL's publication date; the claim that a self-hosted GitHub runner mid-job disappearance produces the same "waiting for runner" stall as the hosted pool.
