#!/usr/bin/env bash
# dsh-job.sh — 云端 DSH 任务执行器（在云服务器上运行）
#
# 用法：
#   dsh-job.sh submit  <job-id> <workdir> <task-text-file> [--session <sid>]
#   dsh-job.sh status  <job-id>
#   dsh-job.sh tail    <job-id> [lines]
#   dsh-job.sh result  <job-id>
#   dsh-job.sh cancel  <job-id>
#   dsh-job.sh list
#
# 设计要点：
#   * submit 立刻返回；真正执行由 setsid + nohup 拉起的 worker 完成，
#     与 SSH 会话完全脱钩 —— 本地断网/关机不影响云端继续跑。
#   * 每个 job 一个目录：$DSH_JOB_ROOT/<job-id>/{task.md,run.log,result.md,status,meta.json}
#   * status 文件是权威状态：queued|running|done|failed|cancelled
#   * 支持 --session，用 dsh --session-id 续跑同一会话（断点延续上下文）
set -uo pipefail

DSH_JOB_ROOT="${DSH_JOB_ROOT:-__JOB_ROOT__}"
DSH_BIN="${DSH_BIN:-__DSH_BIN__}"
DSH_PROFILE="${DSH_PROFILE:-headless}"
KEY_ENV_FILE="${KEY_ENV_FILE:-__KEY_ENV__}"
LOCK="$DSH_JOB_ROOT/.queue.lock"

mkdir -p "$DSH_JOB_ROOT"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# 取消会话归档：headless 跑出来的会话会被云端 Web UI 自动归档，
# 归档后侧边栏看不到。取消归档后它会出现在「未分组」里，能在云端页面直接看进度。
unarchive_session() {
  local sid="$1"
  [[ -z "$sid" ]] && return 0
  python3 - "$sid" "${HOME}/.dsh/storages/workspace.json" <<'PYEOF' 2>/dev/null || true
import json, os, sys
sid, path = sys.argv[1], sys.argv[2]
try:
    doc = json.load(open(path, encoding="utf-8"))
except Exception:
    sys.exit(0)
g = doc.get("global") or {}
arch = g.get("archivedSessionIds") or []
if sid not in arch:
    sys.exit(0)
g["archivedSessionIds"] = [x for x in arch if x != sid]
doc["global"] = g
tmp = path + ".dshjob.tmp"
try:
    json.dump(doc, open(tmp, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    os.replace(tmp, path)
except Exception:
    try: os.unlink(tmp)
    except Exception: pass
PYEOF
}

job_dir() { echo "$DSH_JOB_ROOT/$1"; }

require_job() {
  [[ -d "$(job_dir "$1")" ]] || die "job not found: $1"
}

# ---------- submit ----------
cmd_submit() {
  local id="$1" wd="$2" taskfile="$3"; shift 3
  local session=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --session) session="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  [[ -n "$id" ]] || die "usage: submit <job-id> <workdir> <task-file> [--session sid]"
  [[ -f "$taskfile" ]] || die "task file not found: $taskfile"
  mkdir -p "$wd" 2>/dev/null || die "cannot create workdir: $wd"

  local d; d="$(job_dir "$id")"
  [[ -e "$d" ]] && die "job already exists: $id"

  mkdir -p "$d"
  cp "$taskfile" "$d/task.md"
  printf 'queued' > "$d/status"
  cat > "$d/meta.json" <<EOF
{"id":"$id","workdir":"$wd","session":"$session","submitted_at":"$(date -Iseconds)","host":"$(hostname)"}
EOF

  # 与 SSH 会话彻底脱钩
  setsid nohup "$0" __worker "$id" "$wd" "$session" \
    >>"$d/run.log" 2>&1 < /dev/null &
  echo "submitted: $id (workdir=$wd)"
}

# ---------- worker ----------
cmd_worker() {
  local id="$1" wd="$2" session="$3"
  local d; d="$(job_dir "$id")"

  # 队列串行：同一主机同一时刻只跑一个 DSH 任务，避免资源争抢
  exec 9>"$LOCK"
  flock 9

  if [[ "$(cat "$d/status" 2>/dev/null)" == "cancelled" ]]; then
    log "job $id cancelled before start"; exit 0
  fi

  printf 'running' > "$d/status"
  echo "$$" > "$d/pid"
  log "=== start $id (wd=$wd session=${session:-<new>}) ==="

  # 载入模型凭据
  if [[ -f "$KEY_ENV_FILE" ]]; then
    set -a; . "$KEY_ENV_FILE"; set +a
  fi

  # node 可能不在默认 PATH（nvm 安装），把它所在目录加进 PATH
  export PATH="$(dirname "$DSH_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
  export LANG="${LANG:-C.UTF-8}"

  local args=()
  [[ -n "$session" ]] && args+=(--session-id "$session")

  local rc=0
  # --json 事件流：既能拿到 sessionId（供后续 --session 续跑），
  # 最后一条 final 事件里带最终答复
  ( cd "$wd" && "$DSH_BIN" --profile "$DSH_PROFILE" --json ${args[@]+"${args[@]}"} - < "$d/task.md" ) \
      > "$d/events.jsonl" 2>"$d/err.log" || rc=$?

  # 提取 sessionId 回写 meta.json
  local sid
  sid="$(head -1 "$d/events.jsonl" 2>/dev/null | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')"
  if [[ -n "$sid" ]]; then
    if [[ -n "$session" ]]; then
      :
    else
      sed -i "s/\"session\":\"[^\"]*\"/\"session\":\"$sid\"/" "$d/meta.json" 2>/dev/null
    fi
    unarchive_session "$sid"
  fi

  # 提取最终答复：事件流里 type=final 的那条带 text
  python3 - "$d/events.jsonl" "$d/result.md" <<'PY' 2>/dev/null || \
    sed -n 's/.*"type":"final","text":"\(.*\)"}$/\1/p' "$d/events.jsonl" > "$d/result.md"
import json, sys
src, dst = sys.argv[1], sys.argv[2]
final = None
try:
    for line in open(src, encoding='utf-8', errors='replace'):
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get('type') == 'final':
            txt = ev.get('text')
            if isinstance(txt, str):
                final = txt
except FileNotFoundError:
    pass
if final is not None:
    open(dst, 'w', encoding='utf-8').write(final + '\n')
PY

  echo "--- dsh exit rc=$rc ---" >> "$d/run.log"
  [[ -s "$d/err.log" ]] && tail -40 "$d/err.log" >> "$d/run.log"

  if [[ "$(cat "$d/status" 2>/dev/null)" == "cancelled" ]]; then
    log "=== job $id cancelled at end ==="
  elif [[ $rc -eq 0 ]]; then
    printf 'done' > "$d/status"
    log "=== done $id ==="
  else
    printf 'failed' > "$d/status"
    log "=== failed $id rc=$rc ==="
  fi
}

# ---------- 查询 ----------
cmd_status() {
  local d; d="$(job_dir "$1")"; require_job "$1"
  local st; st="$(cat "$d/status" 2>/dev/null || echo unknown)"
  local pid; pid="$(cat "$d/pid" 2>/dev/null || echo -)"
  local alive=no
  [[ "$pid" != "-" ]] && kill -0 "$pid" 2>/dev/null && alive=yes
  echo "id       : $1"
  echo "status   : $st"
  echo "pid      : $pid (alive=$alive)"
  echo "meta     : $(cat "$d/meta.json" 2>/dev/null)"
  echo "loglines : $(wc -l < "$d/run.log" 2>/dev/null || echo 0)"
  echo "result   : $(wc -c < "$d/result.md" 2>/dev/null || echo 0) bytes"
}

cmd_tail() {
  local n="${2:-40}"
  local d; d="$(job_dir "$1")"; require_job "$1"
  tail -n "$n" "$d/run.log" 2>/dev/null
  local err; err=$(tail -n 20 "$d/err.log" 2>/dev/null)
  [[ -n "$err" ]] && { echo "--- stderr ---"; echo "$err"; }
  true
}

cmd_result() {
  local d; d="$(job_dir "$1")"; require_job "$1"
  local st; st="$(cat "$d/status" 2>/dev/null)"
  if [[ "$st" == "running" || "$st" == "queued" ]]; then
    echo "(job is $st; showing partial output)" >&2
  fi
  cat "$d/result.md" 2>/dev/null
}

cmd_cancel() {
  local d; d="$(job_dir "$1")"; require_job "$1"
  local pid; pid="$(cat "$d/pid" 2>/dev/null || echo "")"
  printf 'cancelled' > "$d/status"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    sleep 2
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  echo "cancelled: $1"
}

cmd_list() {
  printf '%-28s %-10s %s\n' ID STATUS SUBMITTED
  for d in "$DSH_JOB_ROOT"/*/; do
    [[ -d "$d" ]] || continue
    local id st at
    id="$(basename "$d")"
    st="$(cat "$d/status" 2>/dev/null || echo unknown)"
    at="$(sed -n 's/.*"submitted_at":"\([^"]*\)".*/\1/p' "$d/meta.json" 2>/dev/null)"
    printf '%-28s %-10s %s\n' "$id" "$st" "$at"
  done
}

# wait：阻塞到任务结束（供本地 CLI 轮询，也可 ssh 里直接用）
cmd_wait() {
  local id="$1" timeout="${2:-3600}"
  local waited=0
  while :; do
    local st; st="$(cat "$(job_dir "$id")/status" 2>/dev/null || echo unknown)"
    case "$st" in
      done|failed|cancelled) echo "$st"; return 0 ;;
    esac
    [[ $waited -ge $timeout ]] && { echo "timeout"; return 1; }
    sleep 5; waited=$((waited + 5))
  done
}

# push：把本地打包的 tar 解开到指定目录（工作目录同步用）
cmd_unpack() {
  local id="$1" dest="$2" tarball="$3"
  [[ -f "$tarball" ]] || die "tarball not found: $tarball"
  mkdir -p "$dest"
  tar -xzf "$tarball" -C "$dest" --no-same-owner 2>/dev/null \
    || tar -xf "$tarball" -C "$dest" 2>/dev/null \
    || die "unpack failed"
  echo "unpacked to $dest"
}

case "${1:-}" in
  submit) shift; cmd_submit "$@" ;;
  __worker) shift; cmd_worker "$@" ;;
  status) shift; cmd_status "$@" ;;
  tail)   shift; cmd_tail "$@" ;;
  result) shift; cmd_result "$@" ;;
  cancel) shift; cmd_cancel "$@" ;;
  list)   shift; cmd_list "$@" ;;
  wait)   shift; cmd_wait "$@" ;;
  unpack) shift; cmd_unpack "$@" ;;
  *) echo "usage: $0 {submit|status|tail|result|cancel|list|wait|unpack}" >&2; exit 2 ;;
esac
