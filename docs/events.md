# Events

Every agent and daemon action is one typed event appended to `.cubicle/cubicle.db` (`events` table) and mirrored to `.cubicle/events/YYYY-MM-DD.jsonl`. The office is a pure renderer of this log; `cubicle replay <date>` and the viewer's replay slider read it back. The JSONL mirror is the durable copy; `cubicle rebuild` recreates the SQLite index from it.

Envelope: `{ id, ts (ISO), type, agent (role id | daemon | owner | init | null), job (job id | null), payload }`.

| type | payload |
|---|---|
| `daemon.started` | pid, port, roles |
| `daemon.stopping` | active_jobs |
| `daemon.warning` | where, message — never silent; a question timeout adds id (the unanswered message) and escalated_to; `where: provider_key` carries providers [{id, env}] instead of message (a cascade provider has no API key, so its models are unavailable); the money notices all carry reason instead of message — `money.runway.locked` and `money.accrual.locked` add path and are said once per lock (the accrual's once a day while it stands, naming the days it is skipping), `money.accrual.stamp` adds stamp and is said once per mistyped stamp value, `money.notices.unwritable` adds path and is said once per fault, `money.notices.unreadable` adds path and is said once per run. What has already been said lives in an in-process map, loaded once from .cubicle/money-notices.json and written through to it. The other money rows are per-failure, not deduped: `money.accrual` and `money.runway` carry message and mean the day's model cost could not be booked or Ledger/runway.md could not be regenerated (the cycle carries on either way — money can make the company cheaper, never silent), `ledger.append_retry` adds path and says the book changed under an append that is being retried on the fresh copy, and `dormant` carries message once per window while a worker waits for the company to be funded again |
| `heartbeat.started` | trigger |
| `heartbeat.completed` | id, commit, run (Runs/ path), gathered_at |
| `job.queued` | type, title, assigned, priority, risk |
| `job.started` | attempt, from_step, resumed |
| `job.checkpoint` | `in_review` (the next gate job type the job now owes, or absent when it has none left), `summary` |
| `job.blocked` | reason (approval | message | job | quota), id |
| `job.done` | summary, artifacts, metrics, lessons |
| `job.failed` | reason, requeued, attempt |
| `job.interrupted` | checkpoint_step (daemon restart) |
| `job.cancelled` | at_step, reason — one per stop: a job cancelled while queued or blocked is announced by whatever cancelled it, a running one by its own loop at the next tool step |
| `agent.thinking` | step |
| `agent.tool_call` | tool, summary (≤120 chars of args), step |
| `agent.tool_result` | tool, ok, step, summary |
| `agent.spoke` | to, text, kind — rendered as a speech bubble |
| `meeting.opened` | id, room, participants, agenda, subject, title (the `meeting.open` tool sends path instead of subject/title) |
| `meeting.turn` | id, round, text |
| `meeting.closed` | id, room, subject, title, verdict, findings, decision (the `meeting.close` tool sends id, path, decision, turns) |
| `browser.session_started` | session |
| `browser.frame` | session, seq, path (.cubicle/screens/…; bytes travel only on the WS frame op) |
| `browser.session_ended` | session, frames |
| `shell.output` | session, stream (cmd|stdout|stderr|info), text |
| `ci.completed` | stream, green, record (the `Workspace/<stream>/.cubicle-ci/*.json` path), steps [{name, ok, code}] |
| `email.sent` | to, subject, key, mode (mock|live) |
| `email.received` | from, subject, id, unsubscribe |
| `deploy.done` | url, project, mode (mock|live), key, stage (preview|canary|live), canary_percent (null off canary), canary_enforced (always false: the percentage is recorded, never enforced, until real traffic-splitting infrastructure exists), metrics (what the deployer said it would watch), rolled_back, snapshot (.cubicle/deploys/… path a rollback republishes), build_hash (content hash of the deployed directory; a live deploy needs a preview and a canary carrying the same hash), stream |
| `incident.opened` | stream, trigger (rollback | red_ci_live | manual) — the clock the error budget counts from |
| `incident.recovered` | stream, hours (open → recovered), postmortem (Docs/postmortems/… path) |
| `proposal.created` | id, kind, path, title, to |
| `proposal.resolved` | id, kind, approved, outcome |
| `role.hired` | role, display, desk, sprite |
| `role.fired` | role |
| `router.call` | provider, model, tier, tokens {prompt_tokens, completion_tokens}, tools, downgraded, reason (present only when downgraded: `cascade` or `division budget` — the latter is excluded from the "check your API keys" count) |
| `router.downgraded` | requested_tier, chosen_tier, provider, model, tried, reason (`cascade` — nothing at the asked-for tier had headroom; `division budget` — the division has spent its model quota for the day and drops to the cheapest tier, which never stops work) |
| `quota.updated` | provider, model, rpm_used, rpd_used, tpm_used, cooling_until, limits |
| `vault.wrote` | path, sha, by (role | daemon | init | <role>/shell), deleted?, moved_from?, generated? (true for daemon-generated files such as `Jobs/queue.md`, `Metrics/quota.md`, `Metrics/daily.md`; the viewer ignores these for staleness) |
| `owner.edited` | path, area, deleted, wakes_heartbeat; a startup sweep of comments left while the daemon was down adds offline: true and comments (how many new %%cubicle: …%% comments the file gained) |
| `owner.feedback_delivered` | sha (sha1 of the trimmed `feedback:` line), source (`Memory/owner_preferences.md`) — emitted once per entry, at the commit of the heartbeat whose gather step collected it, so an entry added mid-cycle is deferred rather than lost, it is never re-delivered, and `cubicle rebuild` keeps the marker |
| `team.planned` | team, jobs (ids the division.plan job scheduled) |
| `review.passed` | gate, findings |
| `review.returned` | gate, findings |
| `plan.vetoed` | findings, vetoes (count so far this cycle), reason (board return | unkept ideas) |
| `research.delivered` | emitted on the requester's research job |
| `org.changed` | reason (migration | reorg | fire), changed | teams | role |
| `guardrail.blocked` | tool, reason — every refused call, never silent. The tool wrapper emits just those two; the harness loop and the dispatcher, which pre-check before spending an idempotency key, add step and approved: true; a refused stored call in a proposal note adds proposal and kind instead |

## WebSocket (ws://127.0.0.1:7411?token=…)

Client → server: `{"op":"snapshot"}`, `{"op":"replay","from":ISO,"to":ISO,"cursor":n}` (5 000 events per page), `{"op":"chat","text":"…"}` (writes a `kind: message` note for the CEO).
Server → client: `{"op":"snapshot", roles, jobs, surfaces, quota, money, latestRun, plan, pendingProposals, teams (each with `wip: { limits, load }` per Kanban lane)}`, `{"op":"event", …event}`, `{"op":"frame", streamId, seq, jpegBase64}`, `{"op":"replay", events, cursor, total, done}`, `{"op":"chat.ack", id}`.
The snapshot's `money` block is the bank screen's: `currency`, `cash_cents`/`cash`, `burn_cents_per_day`/`burn`, `runway_days`/`runway`, `dormant`, `mock_revenue_cents`/`mock_revenue`, `problems`, `budgets` [{division, used, quota}], and the last six `entries` [{at, kind, amount, mode, who, why}] newest first. Every figure crosses the wire **twice** — integer minor units and the string to print — because the viewer never formats money (SP4 decision 16); `why` is capped at 80 characters there. It is `null` when the book could not be read, and `budgets` is empty when the router has no providers file.
The token lives in `<vault>/.cubicle/daemon.json` (mode 0600); browser origins other than localhost and the viewer are refused.

_Generated by scripts/gen-docs.ts from packages/core/src/schemas.ts._
