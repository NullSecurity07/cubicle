# DECISION.md — deviations and build-time resolutions

Each entry: what the spec said, what was found, what was done, and why. Newest at the bottom.

## 2026-09-02 — better-sqlite3 works on Node 26 without a compile step
- Spec: `better-sqlite3` for the event log / cache.
- Found: Node v26.7.0 (ABI 147). `better-sqlite3@13.0.3` ships Node-API prebuilds inside the package (`prebuilds/linux-x64.node`), so no node-gyp build is needed.
- Done: kept `better-sqlite3` behind `packages/core/src/db.ts`. `node:sqlite` (also verified working) remains the documented fallback if a future Node drops compatibility.

## 2026-09-02 — pnpm installed per-user, build scripts allow-listed
- Found: global `npm install -g` is blocked by permissions on `/usr/lib`; pnpm 11 refuses postinstall scripts unless allow-listed.
- Done: `npm install -g pnpm@11 --prefix ~/.local` (on PATH); `pnpm-workspace.yaml` carries `allowBuilds: { esbuild: true, better-sqlite3: true }`.

## 2026-09-02 — `Messages/` directory added to the vault schema
- Spec: `colleague.message` writes "to the recipient's inbox section in the vault", but `Roles/*` is owner-owned.
- Done: agent-writable `Messages/<role>.md`; the harness includes unread sections in context. Also added `Roles/archive/`, `Plans/archive/`, `Jobs/queue.md`, and `config/world/desks.yaml` (desk ids the daemon can read when hiring).

## 2026-09-02 — Owner-edit detection by content sha, not git
- Spec: watcher emits `owner.edited` on change; Engineer uses `git diff` to avoid reverting owner edits.
- Found: agent writes would look like owner edits (heartbeat storm), and commits only happen at heartbeats, so a git diff mixes both.
- Done: every system write records `written_sha`; a change whose sha matches is suppressed; a `Site/` file is owner-changed when its sha differs from `written_sha` or it has no entry. `shell.run` output is rescanned into `written_sha` after each call.

## 2026-09-02 — Proposal kinds extended with `message` and `file_change`
- Spec enumerates `hire | fire | brand_change | charter_change | spend | outbound_batch`.
- Done: `message` (owner ↔ agent notes in `00 Inbox/`) and `file_change` (a `propose`-mode `vault.write` to an owner-owned path, stored as a diff) are added so every approval path has a home.
