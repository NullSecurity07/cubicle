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

## 2026-09-02 — Blind critique of Phases 1–3: eight blockers fixed
- Path traversal: `normalizeRel` now posix-normalises and rejects `..`, NUL and drive paths; `Vault.abs()` also realpath-checks the nearest existing ancestor (symlink escape). Role ids are validated (`/^[a-z0-9][a-z0-9_-]{0,39}$/`).
- Self-approval: agents cannot write `00 Inbox/`, `Messages/`, other roles' job notes, or any job frontmatter through `vault.write/append`; proposals come only from `proposal.create`/the harness. The dispatcher acts only on notes whose sha differs from the last system write (the owner flipped it), and logs `guardrail.blocked` otherwise.
- SSRF: `http.fetch` resolves hostnames, rejects loopback/link-local/RFC1918/CGNAT/IPv6-private/mapped addresses, follows redirects manually (≤ 5) re-validating each hop, streams bodies with a hard byte cap.
- At-most-once outbound: for `outbound: true` tools the idempotency key and `checkpoint_step` are written to the job note *before* the call ("ATTEMPTING"); a kill mid-call therefore skips the step on resume. Email/deploy/posts are never sent twice; a lost result is logged instead.
- Colleague messages are persisted into the job transcript (`.cubicle/jobs/<id>.jsonl`) before being marked read, so they survive turns and kills.
- Ids: 24 random bits plus existence checks; internal tools (`proposal.create`, `scheduler.request`, `colleague.message`, owner-owned `vault.write`) derive deterministic ids from the step's idempotency key so a replayed step is a no-op.
- `file_change` proposals carry `call: {tool: vault.write, args: {path, content}}`; the dispatcher applies `call.args.content`, not the markdown preview.
- Terminal states: `failed`, and `blocked` with `blocked_on.kind: owner` (from `finish(status: blocked)`), are never re-run until the owner sets `status: queued`. Non-explicit failures (step limit, bad JSON, no tool calls) requeue while attempts remain; the previous transcript is archived as `<id>.attemptN.jsonl`.

## 2026-09-02 — Observations cache and other documented deviations
- `.cubicle/jobs/<id>.jsonl` holds each job's tool transcript (cache). When it is missing, the harness rebuilds a coarse transcript from the job note's Checkpoint log, so the vault remains the source of truth.
- Charters may only *tighten* approval modes (spec lists them as an override layer); the owner's `owner_preferences.md` may loosen anything except a config-level `never`. Rationale: a charter is rewritten by the CTO via proposal, so it must not be a path to loosen outbound controls.
- Routing prefers the closest tier at or above the requested one, in cascade order, before downgrading (spec: "first model whose tier ≥ requested"); this avoids spending strong-tier quota on cheap-tier requests.
- `Messages/<role>.md` uses HTML comments (`<!-- id:… -->`, `<!-- read:… -->`) as machine markers; Obsidian hides them in reading view.
- `quota_calls` (per-call ledger, pruned after 48 h) backs the sliding windows; daily windows reset at midnight in the provider's `day_reset_tz` (Gemini: America/Los_Angeles).
- Sleep detection: `PrepareForSleep` over D-Bus via `dbus-next`, connected in the background with a 4 s timeout (a hung system bus must never delay workers); the inhibitor lock is best-effort (`unix fd` return values are not supported by dbus-next without `usocket`).
