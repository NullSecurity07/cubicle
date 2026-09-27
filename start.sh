#!/usr/bin/env bash
# Starts the stage: the api server (with reload on change) and the web page, from this checkout.
#   ./start.sh          the page at http://localhost:7420, open it in a browser
#   ./start.sh --shell  the same, plus the desktop window (needs a built shell: `pnpm shell:build` in app/)
#   ./start.sh --showcase           Kindling, the made-up showcase company, in a fresh copy on http://localhost:7440
#   ./start.sh --shell --showcase   the same in the desktop window
# The showcase never touches your own workspace: it runs on a copy of app/showcase made under the temp folder.
# Keys live in .env at the repo root; the app reads them itself. Stop with Ctrl+C: both halves stop together.
set -euo pipefail
cd "$(dirname "$0")/app"

if ! command -v pnpm >/dev/null 2>&1; then
  export PATH="$HOME/.local/bin:$PATH"
fi
if [ ! -e node_modules ]; then
  pnpm install
fi

shell=0
showcase=0
for arg in "$@"; do
  case "$arg" in
    --shell) shell=1 ;;
    --showcase) showcase=1 ;;
    *) echo "Unknown option: $arg (try --shell, --showcase)"; exit 1 ;;
  esac
done

if [ "$showcase" = 1 ]; then
  # Its own ports, so it can run beside your own stage.
  export STAGE_PORT="${STAGE_PORT:-7440}"
  export STAGE_API_PORT="${STAGE_API_PORT:-$((STAGE_PORT + 1))}"
fi
port="${STAGE_PORT:-7420}"
if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$port" 2>/dev/null | grep -q ":$port"; then
  echo "Something already listens on port $port. The stage may be running already: http://localhost:$port"
  echo "Stop it first, or start this one elsewhere with STAGE_PORT=7430 STAGE_API_PORT=7431 ./start.sh"
  exit 1
fi

if [ "$showcase" = 1 ]; then
  folder="$(node scripts/showcase.ts --copy-only | sed -n 's/^Kindling.s workspace is a fresh copy in //p')"
  if [ -z "$folder" ]; then echo "The showcase could not be copied."; exit 1; fi
  echo "Kindling's workspace is a fresh copy in $folder"
  export STAGE_WORKSPACE="$folder" STAGE_BACKUP_DIR="$folder-backups"
fi

if [ "$shell" = 1 ]; then
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
  shell/target/release/stage-shell --url "http://localhost:$port"
  exit 0
fi

echo "Stage: http://localhost:$port"
exec pnpm dev
