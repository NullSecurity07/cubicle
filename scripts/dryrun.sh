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
case "${1:-status}" in
  init)
    if [[ -d "$V" ]]; then mv "$V" "$V-$(date +%Y%m%d-%H%M%S)"; fi
    pnpm cubicle init "$V" >/dev/null && echo "scratch vault at $V" ;;
  start)
    [[ -d "$V" ]] || { echo "no scratch vault; run: scripts/dryrun.sh init"; exit 1; }
    mkdir -p "$V/.cubicle/run" "$V/.cubicle/logs"
    if [[ -f "$PIDF" ]] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then echo "already running (pid $(cat "$PIDF"))"; exit 0; fi
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
