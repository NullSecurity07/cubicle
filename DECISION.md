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

## 2026-09-02 — Phase 6: outbound adapters, SETUP.md, doctor
- Every outbound service has a `mock` and a `live` adapter chosen by env-var presence (`packages/tools/src/adapters/`). Mocks append to `.cubicle/mock/<service>.jsonl` (email, deploy, stripe) or consume `.cubicle/mock/inbox/*.json` (inbound mail) so every acceptance test runs offline; the live paths use only what the docs verified on 2026-09-02 (Brevo `POST /v3/smtp/email`, wrangler `pages deploy` with `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`, Stripe product→price→payment_link with `Idempotency-Key`, GoatCounter `/api/v0/stats/*`, IMAP via imapflow).
- `email.send` appends the unsubscribe footer, refuses suppressed addresses (`Customers/_suppression.md`, case-insensitive), logs each touch on `Customers/<slug>.md`, and requires the harness idempotency key. Inbound "unsubscribe / remove me / stop emailing" adds the sender to the suppression list automatically.
- `email.inbox` reply jobs use deterministic ids (`job_reply_<mail id>`) so a re-poll never duplicates them.
- `deploy.site`: `first_time_only` in tools.yaml — proposed as a `spend` until one `deploy.done` exists, then automatic unless the owner pins a mode in `owner_preferences.md`. After each deploy the tool files a `brand_change` proposal recording the URL in `Brand/name.md` (the owner-owned file is never written directly).
- `social.post` records the draft under `Experiments/posts/` and hands the actual submission to `browser.submit` (both `ask` by default; the owner may loosen one).
- `cubicle doctor` (`--live` pings each key with one free call; `--build-sandbox` builds the image) exits 0 when only optional services are missing; `SETUP.md` is a static checklist with the verified free basis for each account.
- `.env` at the repo root is loaded by the CLI with a dependency-free parser; environment variables already set win.

## 2026-09-02 — Blind critique of Phase 4: six blockers fixed
- Approved `ask`-mode calls: the harness now resumes stored calls whenever `blocked_on` is set (the dispatcher requeues as `queued` without clearing it), so an owner approval executes the call exactly once and the job continues; a still-unanswered proposal re-marks the job `blocked`.
- WebSocket: a random token is written to `.cubicle/daemon.json` (mode 0600) and required as `?token=`; browser origins other than localhost/the viewer/Tauri are refused (`verifyClient`). Replay is paged (5 000 events + cursor), slow clients are skipped above 1 MB buffered, handler errors are answered, not thrown.
- Heartbeat state: `cto.plan` is derived from the job note (`blocked_on`/`parent`), the brief path from `links`, and the gathered facts are stored in the note's `## Plan` section; `.cubicle/jobs/<id>.heartbeat.json` is a pure cache. A cache wipe mid-heartbeat yields one plan job, one archive, one brief (tested).
- Proposal targets are validated per kind (`brand_change` → `Brand/`, `charter_change` → `Roles/<role>.md` with valid frontmatter, `file_change` → never inbox/jobs/messages, and the constitution/preferences only via a harness-generated stored call). Mismatches leave the note unresolved with an explanation instead of applying.
- Dispatcher-executed `spend` calls are at-most-once: `executing_at` is stamped on the note and the key on the job before the call; an interrupted attempt is never re-run (logged as a lost result).
- `cto.plan` wait budget (`PLAN_WAIT_BUDGET_MS`, 60 min): after it the heartbeat continues with "planning pending" in the brief; the requeue rules unblock `kind: job` waits on the same budget.
- Also applied: heartbeat windows use `gathered_at`; same-day archives no longer overwrite; owner-message proposals have deterministic ids; `cubicle heartbeat` coalesces with an open heartbeat; jobs-completed trigger is computed from events; `chosen` out of range leaves the note unresolved; owner answers require an owner flip and non-empty text; `status: blocked` with no `blocked_on` is an owner pause; quota retries back off 10→240 min; `updateNote` re-applies on a concurrent change; malformed job notes emit one `daemon.warning`; SQLite `busy_timeout`; pid-reuse/zombie-aware daemon lock; `test:kill9` goes through the real Daemon and asserts `job.interrupted` + stale `daemon.json` handling.
- Not changed (documented): sleep handling still exits the process (spec §14 test 9); "on wake, resumes" relies on the tray app (Phase 10) or the owner restarting `cubicle start`. Consumers see `PrepareForSleep(false)` unused.

## 2026-09-02 — Phase 7: evolution
- Lessons (§9.1): every `finish.lessons[]` entry is appended to `Memory/lessons.md` by the harness as `- [date] [[job]] lesson (role)`, deduplicated per job; COO verify jobs are told to report one lesson per job. The CEO reads the file every heartbeat (it is in the CEO system prompt).
- Charter compression (§9.2): after every 7th `heartbeat.completed` the daemon enqueues `cto.compress_charters` (deterministic id `job_compress_<n>`); the CTO files `charter_change` proposals whose body carries the full new charter in a fenced block. The dispatcher validates the frontmatter before writing; `auto_approve_charter_changes: true` makes the daemon approve agent-created charter changes itself (`approved_by: constitution`).
- Skills (§9.3): a failed job counts one failure against every skill it loaded; on the second failure the skill note moves to `Skills/archive/` with a lesson line and a `daemon.warning`.
- Experiments (§9.4): `Experiments/_template.md` defines the frontmatter (`status`, `metric`, `review_date`, `result`). On each tick, running experiments past `review_date` get one `coo.verify` judgement job (`job_judge_<id>`); the CTO plan goal lists won/lost/running experiments so the CEO/CTO adopt winners.
- Hire/fire (§9.5): approved `hire` proposals must carry a fenced charter with valid frontmatter and links to ≥ 2 jobs; `max_roles` and free desks (config/world/desks.yaml) are enforced; the daemon writes `Roles/<role>.md`, creates `Messages/<role>.md`, emits `role.hired`, and starts a worker. `fire` sets `active: false`, archives the charter to `Roles/archive/`, cancels the role's open jobs, emits `role.fired`; the worker exits on its next loop. The CEO cannot be fired. `auto_approve_hire: true` lets the daemon approve agent-created hires.
- Owner feedback (§9.6): `%%cubicle: …%%` comments in files the owner edited since the last heartbeat are attributed to the note's author role (frontmatter `assigned`/`decided_by`/`by`, else by folder), `feedback:` entries in owner_preferences go to the CEO, and `owner_rating: down` on a decision goes to its author; the harness injects them as an "Owner feedback" block that outranks the job's own plan, and the CTO plan goal summarises them.
