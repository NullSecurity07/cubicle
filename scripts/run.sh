#!/usr/bin/env bash
# CUBICLE launcher — one idempotent command that gets the company running.
#
#   scripts/run.sh [start] [vault] [--tray|--headless] [--no-open] [--skip-checks]
#   scripts/run.sh stop   [vault]        checkpoint and stop the daemon (and the tray if it owns it)
#   scripts/run.sh status [vault]        what is running, the office URL, what needs you
#   scripts/run.sh logs   [vault]        follow the daemon (and tray) logs
#   scripts/run.sh doctor [flags]        delegate to `cubicle doctor`
#
# Vault: --vault <path> | positional | $CUBICLE_VAULT | ~/Vaults/Cubicle (scaffolded if empty).
# Mode:  tray when a display and a StatusNotifier host exist (the Tauri tray owns the daemon and shows the office in
#        its own window; snixembed is started for you when installed); headless otherwise (daemon in the background,
#        office in your browser). Flags override.
# Builds only what is stale: node_modules, TypeScript dists, the viewer, the Rust tray (tray mode only).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ---------- output ----------
if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; D=$'\e[2m'; N=$'\e[0m'; else B=; G=; Y=; R=; D=; N=; fi
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*"; }
info() { printf '%s·%s %s\n' "$D" "$N" "$*"; }
die()  { printf '%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
step() { printf '%s%s%s\n' "$B" "$*" "$N"; }

# ---------- args ----------
CMD=start; VAULT=""; MODE=auto; OPEN=1; CHECKS=1; EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    start|stop|status|logs|doctor|help|-h|--help) CMD="${1#--}"; CMD="${CMD#-}"; [[ "$CMD" == h ]] && CMD=help ;;
    --tray) MODE=tray ;;
    --headless) MODE=headless ;;
    --no-open) OPEN=0 ;;
    --skip-checks) CHECKS=0 ;;
    --vault) shift; VAULT="${1:-}" ;;
    --vault=*) VAULT="${1#--vault=}" ;;
    -*) EXTRA+=("$1") ;;
    *) if [[ -z "$VAULT" ]]; then VAULT="$1"; else EXTRA+=("$1"); fi ;;
  esac
  shift
done
[[ "$CMD" == help ]] && { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }
VAULT="${VAULT:-${CUBICLE_VAULT:-$HOME/Vaults/Cubicle}}"
VAULT="${VAULT/#\~/$HOME}"
VNAME="$(basename "$VAULT")"
RUN="$VAULT/.cubicle/run"; LOGS="$VAULT/.cubicle/logs"
DAEMON_JSON="$VAULT/.cubicle/daemon.json"
TRAY_BIN="$ROOT/packages/app/src-tauri/target/release/cubicle-tray"
DIST_CLI="$ROOT/packages/daemon/dist/cli.js"

# ---------- helpers ----------
have() { command -v "$1" >/dev/null 2>&1; }
alive() { [[ -n "${1:-}" ]] && kill -0 "$1" 2>/dev/null; }
json_field() { [[ -f "$DAEMON_JSON" ]] || return 1; node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j[process.argv[2]];if(v==null)process.exit(1);process.stdout.write(String(v))' "$DAEMON_JSON" "$1" 2>/dev/null; }
daemon_pid() { json_field pid || true; }
daemon_running() { local p; p="$(daemon_pid)"; alive "$p"; }
office_url() { local port token; port="$(json_field port)" || return 1; token="$(json_field token || true)"; printf 'http://127.0.0.1:%d/?token=%s&vault=%s' "$((port + 1))" "$token" "$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$VNAME")"; }
tray_pid() { [[ -f "$RUN/tray.pid" ]] && cat "$RUN/tray.pid" || true; }
tray_running() { alive "$(tray_pid)"; }
cubicle() { if [[ -f "$DIST_CLI" ]]; then node "$DIST_CLI" "$@"; else pnpm --silent cubicle "$@"; fi; }
# newest mtime under a set of paths, 0 when none exist
newest() { find "$@" -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1 | cut -d. -f1; }
stale() { # stale <artifact> <src...>  → 0 when artifact is missing or older than any source
  local art="$1"; shift; [[ -e "$art" ]] || return 0
  local a s; a="$(stat -c %Y "$art")"; s="$(newest "$@")"; [[ -z "$s" ]] && return 1; [[ "$s" -gt "$a" ]]
}
pending_count() { local n=0 f; shopt -s nullglob; for f in "$VAULT/00 Inbox"/*.md; do [[ "$(basename "$f")" == README.md ]] && continue; grep -qE '^kind:[[:space:]]*(message)?[[:space:]]*$' "$f" && continue; grep -qE '^approved:[[:space:]]*null' "$f" && n=$((n + 1)); done; shopt -u nullglob; echo "$n"; }
has_display() { [[ -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ]]; }
has_tray_host() { have dbus-send && dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null | grep -q StatusNotifierWatcher; }
# i3bar / polybar only have an XEmbed tray; snixembed proxies StatusNotifier icons (the Tauri tray) into it. Start it when it
# is installed but not running, so the tray does not silently fall back to a browser tab. `--fork` returns once the watcher is up.
ensure_tray_host() {
  has_tray_host && return 0
  have snixembed || return 1
  if snixembed --fork >/dev/null 2>&1 && has_tray_host; then ok "started snixembed (StatusNotifier → XEmbed tray bridge)"; else warn "snixembed did not register a StatusNotifierWatcher"; return 1; fi
}
can_build_tray() { have cargo && pkg-config --exists webkit2gtk-4.1 2>/dev/null; }
open_url() { local url="$1"; if [[ "$OPEN" == 1 ]] && has_display && have xdg-open; then (xdg-open "$url" >/dev/null 2>&1 &); ok "opened the office in your browser"; else info "office: $url"; fi; }
# The office window: the tray's own webview when the tray is running (SIGUSR2 asks it to show the office), the browser otherwise.
show_office() {
  local url="$1"
  if [[ "$OPEN" != 1 ]]; then info "office: $url"; return 0; fi
  if tray_running && kill -USR2 "$(tray_pid)" 2>/dev/null; then ok "opened the office window (Open Office in the tray brings it back)"; else open_url "$url"; fi
}
wait_for_daemon() { local i; for i in $(seq 1 "${1:-60}"); do daemon_running && json_field port >/dev/null && return 0; sleep 0.5; done; return 1; }

# ---------- preflight ----------
preflight() {
  step "Preflight"
  have node || die "node not found (Node ≥ 20 required)"
  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" -ge 20 ]] || die "Node $major found; Node ≥ 20 required"
  ok "node $(node -v)"
  if ! have pnpm; then [[ -x "$HOME/.local/bin/pnpm" ]] && export PATH="$HOME/.local/bin:$PATH"; fi
  have pnpm || die "pnpm not found (npm i -g pnpm@11 --prefix ~/.local, then add ~/.local/bin to PATH)"
  ok "pnpm $(pnpm --version)"
  if [[ ! -f .env ]]; then cp .env.example .env; warn ".env created from .env.example — no API keys yet, so the company runs on Ollama alone (see SETUP.md)"; else ok ".env present"; fi
  # Ollama is the always-available floor; start it if it is installed but not running
  if ! curl -sf --max-time 3 http://localhost:11434/api/tags >/dev/null; then
    if have ollama; then
      info "starting ollama serve"; (setsid nohup ollama serve >"$HOME/.cache/cubicle-ollama.log" 2>&1 &)
      local i; for i in $(seq 1 30); do curl -sf --max-time 2 http://localhost:11434/api/tags >/dev/null && break; sleep 0.5; done
    fi
  fi
  if curl -sf --max-time 3 http://localhost:11434/api/tags >/dev/null; then
    ok "ollama reachable"
    local need have_models m
    need="$(node -e 'const y=require("yaml");const c=y.parse(require("fs").readFileSync("config/providers.yaml","utf8"));const o=c.providers.find(p=>p.id==="ollama"&&p.enabled!==false);const ids=[];const f=o?.models?.find(m=>m.enabled!==false);if(f)ids.push(f.id);if(o?.embeddings?.id)ids.push(o.embeddings.id);console.log(ids.join(" "))' 2>/dev/null || echo "qwen2.5:7b nomic-embed-text")"
    have_models="$(curl -sf http://localhost:11434/api/tags | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log((JSON.parse(s).models||[]).map(m=>m.name).join(" ")))')"
    for m in $need; do
      if grep -qw -- "$m" <<<"$have_models" || grep -q -- "${m}:" <<<"$have_models"; then ok "ollama model $m"; else
        if [[ -t 0 ]]; then read -r -p "  model $m is missing — pull it now? [Y/n] " a; [[ "${a:-Y}" =~ ^[Yy]?$ ]] && ollama pull "$m" || warn "without $m the local floor cannot answer; keys in .env are required"
        else warn "ollama model $m missing: run  ollama pull $m"; fi
      fi
    done
  else
    warn "ollama not reachable at localhost:11434 — install it from https://ollama.com; until then the company needs a cloud key in .env"
  fi
  if have docker && docker info >/dev/null 2>&1; then ok "docker reachable"; else warn "docker not reachable — the Engineer's shell.run is refused until Docker is up (everything else works)"; fi
}

# ---------- build only what is stale ----------
build() {
  step "Build"
  if [[ ! -d node_modules ]]; then info "installing dependencies"; pnpm install --frozen-lockfile; fi
  local ts_stale=0 p
  for p in core router tools harness daemon; do stale "packages/$p/dist/index.js" "packages/$p/src" "packages/$p/package.json" "packages/$p/tsconfig.json" && { ts_stale=1; info "packages/$p is stale"; }; done
  local viewer_stale=0
  stale packages/viewer/dist/index.html packages/viewer/src packages/viewer/index.html config/world scripts/gen-world.ts && viewer_stale=1
  if [[ "$ts_stale" == 1 ]]; then pnpm -r --filter '!@cubicle/app' --filter '!@cubicle/viewer' build; ok "TypeScript packages built"; else ok "TypeScript packages up to date"; fi
  if [[ "$viewer_stale" == 1 ]]; then pnpm --filter @cubicle/viewer build; ok "viewer built"; else ok "viewer up to date"; fi
  if [[ "$MODE" == tray ]]; then
    # Content hash, not mtimes: a git checkout touches files without changing them, and a Rust release build is minutes.
    local stamp="$ROOT/packages/app/src-tauri/target/.cubicle-src-sha" want
    want="$(cat packages/app/src-tauri/Cargo.toml packages/app/src-tauri/Cargo.lock packages/app/src-tauri/tauri.conf.json packages/app/src-tauri/build.rs $(find packages/app/src-tauri/src packages/app/src-tauri/capabilities -type f | sort) 2>/dev/null | sha256sum | cut -d' ' -f1)"
    if [[ ! -x "$TRAY_BIN" || "$(cat "$stamp" 2>/dev/null)" != "$want" ]]; then
      info "building the Tauri tray (first time takes a few minutes)"; pnpm --filter @cubicle/app build; mkdir -p "$(dirname "$stamp")"; echo "$want" >"$stamp"; ok "tray built ($(du -h "$TRAY_BIN" | cut -f1))"
    else ok "tray up to date"; fi
  fi
}

# ---------- vault ----------
ensure_vault() {
  step "Vault"
  if [[ ! -f "$VAULT/Memory/constitution.md" ]]; then
    info "scaffolding $VAULT"; mkdir -p "$(dirname "$VAULT")"; cubicle init "$VAULT" >/dev/null; ok "vault created — open the folder in Obsidian (Open folder as vault)"
  else ok "$VAULT"; fi
  mkdir -p "$RUN" "$LOGS"
}

# ---------- mode ----------
choose_mode() {
  if [[ "$MODE" == auto ]]; then
    if has_display && ensure_tray_host && can_build_tray; then MODE=tray
    else
      MODE=headless
      if has_display && ! has_tray_host; then info "no StatusNotifier tray host on this desktop — running headless (install snixembed, or another tray host, to use the tray)"; fi
      has_display || info "no display — running headless"
      can_build_tray || { has_display && has_tray_host && info "cargo or webkit2gtk-4.1 missing — running headless"; }
    fi
  elif [[ "$MODE" == tray ]]; then
    has_display && ensure_tray_host || warn "no StatusNotifier tray host — the tray icon will not be visible (install snixembed)"
  fi
  ok "mode: $MODE"
}

# ---------- commands ----------
cmd_start() {
  [[ "$CHECKS" == 1 ]] && preflight
  choose_mode
  build
  ensure_vault
  step "Run"
  if daemon_running; then
    ok "daemon already running (pid $(daemon_pid))"; show_office "$(office_url)"; return 0
  fi
  if [[ "$MODE" == tray ]]; then
    if tray_running; then ok "tray already running (pid $(tray_pid))"; else
      (CUBICLE_VAULT="$VAULT" setsid nohup "$TRAY_BIN" >"$LOGS/tray.log" 2>&1 & echo $! >"$RUN/tray.pid")
      ok "tray started (pid $(tray_pid)) — it starts the daemon and lives in your panel"
    fi
  else
    (setsid nohup node "$DIST_CLI" start "$VAULT" >"$LOGS/daemon.log" 2>&1 &)
    info "daemon starting in the background (log: $LOGS/daemon.log)"
  fi
  if wait_for_daemon 90; then ok "daemon running (pid $(daemon_pid))"; else die "daemon did not come up within 45 s — see $LOGS/daemon.log"; fi
  local url; url="$(office_url)"
  show_office "$url"
  local n; n="$(pending_count)"; [[ "$n" -gt 0 ]] && warn "$n proposal(s) waiting for you in 00 Inbox/" || true
  info "next: talk to the CEO in the cabin, or write a kind: message note in 00 Inbox/ — then  $0 status"
}

cmd_stop() {
  step "Stop"
  local t0 tp dp i; t0="$(date +%s%N)"
  tp="$(tray_pid)"; alive "$tp" || tp=""
  dp="$(daemon_pid)"; alive "$dp" || dp=""
  if [[ -z "$tp" && -z "$dp" ]]; then ok "nothing running"; rm -f "$RUN/tray.pid"; return 0; fi
  # The tray owns the daemon when present: one SIGTERM to it checkpoints the daemon and exits both.
  if [[ -n "$tp" ]]; then kill -TERM "$tp" 2>/dev/null || true; info "tray asked to checkpoint the daemon and exit"; else kill -TERM "$dp" 2>/dev/null || true; fi
  for i in $(seq 1 60); do { [[ -z "$dp" ]] || ! alive "$dp"; } && { [[ -z "$tp" ]] || ! alive "$tp"; } && break; sleep 0.2; done
  local ms=$(( ($(date +%s%N) - t0) / 1000000 ))
  if [[ -n "$dp" ]] && alive "$dp"; then warn "daemon (pid $dp) did not exit within 12 s"; else [[ -n "$dp" ]] && ok "daemon checkpointed and stopped in $ms ms"; fi
  if [[ -n "$tp" ]] && alive "$tp"; then warn "tray (pid $tp) did not exit within 12 s"; else [[ -n "$tp" ]] && ok "tray exited"; fi
  rm -f "$RUN/tray.pid"
}

cmd_status() {
  step "CUBICLE — $VNAME"
  info "vault: $VAULT"
  if [[ ! -f "$VAULT/Memory/constitution.md" ]]; then warn "not scaffolded yet — run  $0"; return 0; fi
  if tray_running; then ok "tray: running (pid $(tray_pid))"; else info "tray: not running"; fi
  if daemon_running; then
    ok "daemon: running (pid $(daemon_pid), since $(json_field started || echo '?'))"; info "office: $(office_url)"
  else warn "daemon: stopped — run  $0"; fi
  local n; n="$(pending_count)"; if [[ "$n" -gt 0 ]]; then warn "$n proposal(s) waiting for you in 00 Inbox/"; else ok "nothing to approve"; fi
  shopt -s nullglob; local -a runs=("$VAULT"/Runs/*.md); shopt -u nullglob
  if [[ ${#runs[@]} -gt 0 ]]; then local last; last="$(ls -t "$VAULT"/Runs/*.md | head -1)"; info "last brief: Runs/$(basename "$last")"; else info "no brief yet (heartbeat #1 runs once you give the CEO an idea)"; fi
  local q r d b f; q=0; r=0; d=0; b=0
  shopt -s nullglob; for f in "$VAULT"/Jobs/*.md; do case "$(basename "$f")" in _*|queue.md) continue;; esac; case "$(grep -m1 -E '^status:' "$f" | awk '{print $2}')" in queued) q=$((q+1));; running|in_review) r=$((r+1));; done) d=$((d+1));; blocked) b=$((b+1));; esac; done; shopt -u nullglob
  info "jobs: $q queued, $r running, $b blocked, $d done"
  local c; c="$(grep -m1 -E '^name:' "$VAULT/Brand/name.md" 2>/dev/null | sed -E 's/^name:[[:space:]]*"?([^"]*)"?/\1/')"; [[ -n "$c" ]] && ok "company: $c" || info "company: unnamed — type an idea in the cabin"
}

cmd_logs() { mkdir -p "$LOGS"; touch "$LOGS/daemon.log"; if [[ -f "$LOGS/tray.log" ]]; then tail -n 40 -F "$LOGS/daemon.log" "$LOGS/tray.log"; else tail -n 40 -F "$LOGS/daemon.log"; fi; }
cmd_doctor() { cubicle doctor "${EXTRA[@]}"; }

case "$CMD" in
  start) cmd_start ;; stop) cmd_stop ;; status) cmd_status ;; logs) cmd_logs ;; doctor) cmd_doctor ;;
esac
