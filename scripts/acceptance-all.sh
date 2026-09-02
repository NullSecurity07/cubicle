#!/usr/bin/env bash
# Phase 11: the whole Verification block on a fresh clone with only GEMINI_API_KEY (and Ollama) available.
# Usage: scripts/acceptance-all.sh [clone-dir]
set -u
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="${1:-$(mktemp -d /tmp/cubicle-fresh-XXXX)}"
PASS=0; FAIL=0; RESULTS=()
step() { local name="$1"; shift; echo; echo "=== $name ==="; if "$@"; then PASS=$((PASS+1)); RESULTS+=("PASS  $name"); else FAIL=$((FAIL+1)); RESULTS+=("FAIL  $name"); fi; }
export GROQ_API_KEY= OPENROUTER_API_KEY= BREVO_API_KEY= CLOUDFLARE_API_TOKEN= STRIPE_SECRET_KEY= GOATCOUNTER_API_TOKEN= IMAP_PASS=
git clone -q "$SRC" "$DST" && cd "$DST" || { echo "clone failed"; exit 1; }
echo "fresh clone at $DST ($(git rev-parse --short HEAD))"
step "pnpm install"        pnpm install --frozen-lockfile
step "pnpm -r build"       pnpm -r build
step "pnpm -r test"        pnpm -r test
step "viewer build"        pnpm --filter @cubicle/viewer build
step "cubicle init"        bash -c 'rm -rf /tmp/cubicle-fresh-vault && pnpm cubicle init /tmp/cubicle-fresh-vault >/dev/null && test -f /tmp/cubicle-fresh-vault/Memory/constitution.md && git -C /tmp/cubicle-fresh-vault log --oneline | grep -q "cubicle: init"'
step "providers test"      bash -c 'pnpm cubicle providers test --only ollama 2>&1 | grep -q "qwen2.5:7b.*yes"'
step "cascade (no key)"    bash -c 'env -u GEMINI_API_KEY pnpm cubicle chat --tier strong "pong" 2>&1 | grep -q "router.downgraded"'
step "test:kill9"          pnpm test:kill9
step "test:sleep"          pnpm test:sleep
step "test:acceptance"     pnpm test:acceptance
step "test:replay"         pnpm test:replay
step "office:shot"         pnpm office:shot /tmp/cubicle-fresh-shots
step "doctor"              bash -c 'pnpm cubicle doctor >/tmp/cubicle-doctor.txt 2>&1 && grep -q "ollama model .* pulled" /tmp/cubicle-doctor.txt'
step "app smoke"           bash -c 'CUBICLE_VAULT=/tmp/cubicle-fresh-vault timeout 90 pnpm --filter @cubicle/app smoke 2>&1 | grep -q "SMOKE PASS"'
step "no model ids in src" bash -c '! grep -rEn "gemini-[0-9]|gpt-oss|qwen2\.5:|:free\"" packages/*/src --include=*.ts | grep -v "providers-cli\|/test/" '
step "no localStorage state" bash -c '! grep -rn "localStorage" packages/viewer/src | grep -v "cubicle.token"'
step "no wall-clock cron"  bash -c '! grep -rEn "cron|node-schedule" packages/*/src --include=*.ts'
echo; echo "===== RESULTS ====="; printf "%s\n" "${RESULTS[@]}"; echo "passed=$PASS failed=$FAIL (clone: $DST)"
[ "$FAIL" -eq 0 ]
