#!/usr/bin/env bash
# Starts the stage: the api server (with reload on change) and the web page, from this checkout.
#   ./start.sh          the page at http://localhost:7420, open it in a browser
#   ./start.sh --shell  the same, plus the desktop window (needs a built shell: `pnpm shell:build` in app/)
# Keys live in .env at the repo root; the app reads them itself. Stop with Ctrl+C: both halves stop together.
set -euo pipefail
cd "$(dirname "$0")/app"

if ! command -v pnpm >/dev/null 2>&1; then
  export PATH="$HOME/.local/bin:$PATH"
fi
if [ ! -e node_modules ]; then
  pnpm install
fi

port="${STAGE_PORT:-7420}"
if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$port" 2>/dev/null | grep -q ":$port"; then
  echo "Something already listens on port $port. The stage may be running already: http://localhost:$port"
  echo "Stop it first, or start this one elsewhere with STAGE_PORT=7430 STAGE_API_PORT=7431 ./start.sh"
  exit 1
fi

if [ "${1:-}" = "--shell" ]; then
  if [ ! -x shell/target/release/stage-shell ]; then
    echo "The desktop shell is not built yet. Run: cd app && pnpm shell:build"
    exit 1
  fi
  # The web view on this machine's graphics card needs software rendering, or the window comes up blank.
  export WEBKIT_DISABLE_DMABUF_RENDERER=1
  pnpm dev &
  dev=$!
  trap 'kill "$dev" 2>/dev/null' EXIT INT TERM
  for _ in $(seq 1 60); do
    curl -fsS "http://localhost:$port" >/dev/null 2>&1 && break
    sleep 0.5
  done
  pnpm shell:dev
  exit 0
fi

echo "Stage: http://localhost:$port"
exec pnpm dev
