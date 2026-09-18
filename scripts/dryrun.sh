#!/usr/bin/env bash
# The coordinator's live dry-run: a second daemon on a scratch vault, real cloud models, no tray, a free port.
# The standing gate before any handover: run the whole owner journey here and read it as the owner would.
#   scripts/dryrun.sh init          # fresh scratch vault at ~/Vaults/Cubicle-dryrun (old one moved aside)
#   scripts/dryrun.sh start         # daemon on port 7600 (office at 7601); logs in the vault's .cubicle/logs
#   scripts/dryrun.sh stop | status | url
set -euo pipefail
cd "$(dirname "$0")/.."
V="${DRYRUN_VAULT:-$HOME/Vaults/Cubicle-dryrun}"; PORT="${DRYRUN_PORT:-7600}"
PIDF="$V/.cubicle/run/dryrun.pid"

# The same two helpers `scripts/run.sh` builds with, and deliberately the same words: a dry-run that tested a
# different office from the one the owner's launcher serves is not a dry-run of anything.
# newest mtime under a set of paths, 0 when none exist
newest() { find "$@" -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1 | cut -d. -f1; }
stale() { # stale <artifact> <src...>  → 0 when artifact is missing or older than any source
  local art="$1"; shift; [[ -e "$art" ]] || return 0
  local a s; a="$(stat -c %Y "$art")"; s="$(newest "$@")"; [[ -z "$s" ]] && return 1; [[ "$s" -gt "$a" ]]
}
case "${1:-status}" in
  init)
    if [[ -d "$V" ]]; then mv "$V" "$V-$(date +%Y%m%d-%H%M%S)"; fi
    pnpm cubicle init "$V" >/dev/null && echo "scratch vault at $V" ;;
  start)
    [[ -d "$V" ]] || { echo "no scratch vault; run: scripts/dryrun.sh init"; exit 1; }
    mkdir -p "$V/.cubicle/run" "$V/.cubicle/logs"
    if [[ -f "$PIDF" ]] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then echo "already running (pid $(cat "$PIDF"))"; exit 0; fi
    # `packages/daemon/src/static.ts` serves `packages/viewer/dist`, which is gitignored — so with no build step
    # here every dry-run silently tested whatever the viewer happened to have been built from last. Dry-run 3
    # opened an office three days older than the branch it was meant to be reading (defect W5-2). Same check,
    # same inputs as `scripts/run.sh`'s `build`, so the two can never serve different offices.
    if stale packages/viewer/dist/index.html packages/viewer/src packages/viewer/index.html config/world scripts/gen-world.ts; then
      echo "viewer is stale — building it before the office is served"
      pnpm --filter @cubicle/viewer build >/dev/null
    fi
    set -a; [[ -f .env ]] && . ./.env; set +a
    # The owner's standing rule: the local model is theirs to lend. Cloud only unless DRYRUN_OLLAMA=1.
    [[ "${DRYRUN_OLLAMA:-0}" = 1 ]] || export CUBICLE_DISABLE_PROVIDERS="${CUBICLE_DISABLE_PROVIDERS:-ollama}"
    CUBICLE_VAULT="$V" nohup node --import tsx/esm --conditions=development packages/daemon/src/cli.ts start "$V" --port "$PORT" >"$V/.cubicle/logs/daemon.log" 2>&1 &
    echo $! >"$PIDF"; sleep 4
    kill -0 "$(cat "$PIDF")" 2>/dev/null && echo "dry-run daemon pid $(cat "$PIDF") on port $PORT; office: $(grep -o 'http://127.0.0.1:[0-9]*/?token=[a-f0-9]*' "$V/.cubicle/logs/daemon.log" | tail -1)" || { tail -20 "$V/.cubicle/logs/daemon.log"; exit 1; } ;;
  stop)
    [[ -f "$PIDF" ]] && kill "$(cat "$PIDF")" 2>/dev/null && rm -f "$PIDF" && echo "stopped" || echo "not running" ;;
  status)
    if [[ -f "$PIDF" ]] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then echo "running (pid $(cat "$PIDF"))"; pnpm --silent cubicle status "$V" 2>/dev/null || true; else echo "not running"; fi ;;
  url) grep -o 'http://127.0.0.1:[0-9]*/?token=[a-f0-9]*' "$V/.cubicle/logs/daemon.log" | tail -1 ;;
  *) echo "usage: scripts/dryrun.sh init|start|stop|status|url"; exit 2 ;;
esac
