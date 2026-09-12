#!/usr/bin/env bash
# Phase 11: the whole Verification block on a fresh clone with only GEMINI_API_KEY (and Ollama) available.
# Usage: scripts/acceptance-all.sh [clone-dir]
set -u
SRC="$(cd "$(dirname "$0")/.." && pwd)"
# A live daemon usually holds the default port; the sweep's own daemons take a free one so the two never collide.
export CUBICLE_PORT="${CUBICLE_PORT:-$(( 7500 + RANDOM % 400 ))}"
DST="${1:-$(mktemp -d /tmp/cubicle-fresh-XXXX)}"
PASS=0; FAIL=0; RESULTS=()
step() { local name="$1"; shift; echo; echo "=== $name ==="; if "$@"; then PASS=$((PASS+1)); RESULTS+=("PASS  $name"); else FAIL=$((FAIL+1)); RESULTS+=("FAIL  $name"); fi; }
# The machine's 1-minute load and its core count, read once. Several steps here are wall-clock sensitive — the
# tools package drives a Docker sandbox, office:shot measures a frame rate — and `pnpm -r test` runs the packages
# in parallel on top of whatever else the box is doing. Above half the cores, the sweep runs the workspace tests
# one package at a time instead of racing them: slower, and the difference between a real failure and a timeout.
LOAD1="$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo 0)"
CORES="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
if awk -v l="$LOAD1" -v c="$CORES" 'BEGIN { exit !(l > c / 2) }'; then
  TEST_ARGS=(--workspace-concurrency=1)
  echo "1-min load $LOAD1 on $CORES cores: running the workspace tests one package at a time"
else
  TEST_ARGS=()
  echo "1-min load $LOAD1 on $CORES cores: running the workspace tests in parallel"
fi
export GROQ_API_KEY= OPENROUTER_API_KEY= BREVO_API_KEY= CLOUDFLARE_API_TOKEN= STRIPE_SECRET_KEY= GOATCOUNTER_API_TOKEN= IMAP_PASS=
git clone -q "$SRC" "$DST" && cd "$DST" || { echo "clone failed"; exit 1; }
echo "fresh clone at $DST ($(git rev-parse --short HEAD))"
step "pnpm install"        pnpm install --frozen-lockfile
step "pnpm -r build"       pnpm -r build
step "pnpm -r test"        pnpm "${TEST_ARGS[@]}" -r test
step "viewer build"        pnpm --filter @cubicle/viewer build
step "cubicle init"        bash -c 'rm -rf /tmp/cubicle-fresh-vault && pnpm cubicle init /tmp/cubicle-fresh-vault >/dev/null && test -f /tmp/cubicle-fresh-vault/Memory/constitution.md && git -C /tmp/cubicle-fresh-vault log --oneline | grep -q "cubicle: init"'
step "providers test"      bash -c 'pnpm cubicle providers test --only ollama 2>&1 | grep -q "qwen2.5:7b.*yes"'
step "cascade (no key)"    bash -c 'env -u GEMINI_API_KEY pnpm cubicle chat --tier strong "pong" 2>&1 | grep -q "router.downgraded"'
step "test:kill9"          pnpm test:kill9
step "test:sleep"          pnpm test:sleep
step "test:acceptance"     pnpm test:acceptance
step "test:replay"         pnpm test:replay
step "office:shot"         pnpm office:shot /tmp/cubicle-fresh-shots
step "org drawer"          bash -c 'grep -q "Org" packages/viewer/dist/index.html'
step "doctor"              bash -c 'pnpm cubicle doctor >/tmp/cubicle-doctor.txt 2>&1 && grep -q "ollama model .* pulled" /tmp/cubicle-doctor.txt'
step "run.sh"             bash -c 'rm -rf /tmp/cubicle-run-vault && scripts/run.sh start /tmp/cubicle-run-vault --headless --no-open --skip-checks </dev/null | grep -q "daemon running" && scripts/run.sh status /tmp/cubicle-run-vault | grep -q "daemon: running" && scripts/run.sh stop /tmp/cubicle-run-vault | grep -q "stopped in"'
step "app smoke"           bash -c 'CUBICLE_VAULT=/tmp/cubicle-fresh-vault timeout 90 pnpm --filter @cubicle/app smoke 2>&1 | grep -q "SMOKE PASS"'
step "no model ids in src" bash -c '! grep -rEn "gemini-[0-9]|gpt-oss|qwen2\.5:|:free\"" packages/*/src --include=*.ts | grep -v "providers-cli\|/test/\|\.test\.ts:" '
step "no localStorage state" bash -c '! grep -rn "localStorage" packages/viewer/src | grep -v "cubicle.token"'
step "no wall-clock cron"  bash -c '! grep -rEn "cron|node-schedule" packages/*/src --include=*.ts'
echo; echo "===== RESULTS ====="; printf "%s\n" "${RESULTS[@]}"
# The load is printed beside the tally either way: a sweep's timings mean nothing without it, and a timeout read
# a week later needs to say whether the machine was busy.
echo "passed=$PASS failed=$FAIL (clone: $DST, 1-min load at start $LOAD1 on $CORES cores, now $(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo '?'))"
[ "$FAIL" -eq 0 ]
