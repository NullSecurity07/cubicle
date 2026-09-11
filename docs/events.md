# Events

Every agent and daemon action is one typed event appended to `.cubicle/cubicle.db` (`events` table) and mirrored to `.cubicle/events/YYYY-MM-DD.jsonl`. The office is a pure renderer of this log; `cubicle replay <date>` and the viewer's replay slider read it back. The JSONL mirror is the durable copy; `cubicle rebuild` recreates the SQLite index from it.

Envelope: `{ id, ts (ISO), type, agent (role id | daemon | owner | init | null), job (job id | null), payload }`.

| type | payload |
|---|---|
| `daemon.started` | pid, port, roles |
| `daemon.stopping` | active_jobs |
| `daemon.warning` | where, message — never silent; a question timeout adds id (the unanswered message) and escalated_to; `where: provider_key` carries providers [{id, env}] instead of message (a cascade provider has no API key, so its models are unavailable) |
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
| `meeting.opened` | id, room, participants, agenda, path |
| `meeting.turn` | id, round, text |
| `meeting.closed` | id, path, decision, turns |
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
| `router.call` | provider, model, tier, tokens {prompt_tokens, completion_tokens}, tools, downgraded |
| `router.downgraded` | requested_tier, chosen_tier, provider, model, tried |
| `quota.updated` | provider, model, rpm_used, rpd_used, tpm_used, cooling_until, limits |
| `vault.wrote` | path, sha, by (role | daemon | init | <role>/shell), deleted?, moved_from?, generated? (true for daemon-generated files such as `Jobs/queue.md`, `Metrics/quota.md`, `Metrics/daily.md`; the viewer ignores these for staleness) |
| `owner.edited` | path, area, deleted, wakes_heartbeat; a startup sweep of comments left while the daemon was down adds offline: true and comments (how many new %%cubicle: …%% comments the file gained) |
| `owner.feedback_delivered` | sha (sha1 of the trimmed `feedback:` line), source (`Memory/owner_preferences.md`) — emitted once per entry, at the commit of the heartbeat whose gather step collected it, so an entry added mid-cycle is deferred rather than lost, it is never re-delivered, and `cubicle rebuild` keeps the marker |
| `team.planned` | team, jobs (ids the team.plan job scheduled) |
| `review.passed` | gate, findings |
| `review.returned` | gate, findings |
| `plan.vetoed` | findings, vetoes (count so far this cycle) |
| `research.delivered` | emitted on the requester's research job |
| `org.changed` | reason (migration | reorg | fire), changed | teams | role |
| `guardrail.blocked` | tool, reason — every refused call, never silent. The tool wrapper emits just those two; the harness loop and the dispatcher, which pre-check before spending an idempotency key, add step and approved: true; a refused stored call in a proposal note adds proposal and kind instead |

## WebSocket (ws://127.0.0.1:7411?token=…)

Client → server: `{"op":"snapshot"}`, `{"op":"replay","from":ISO,"to":ISO,"cursor":n}` (5 000 events per page), `{"op":"chat","text":"…"}` (writes a `kind: message` note for the CEO).
Server → client: `{"op":"snapshot", roles, jobs, surfaces, quota, latestRun, plan, pendingProposals, teams (each with `wip: { limits, load }` per Kanban lane)}`, `{"op":"event", …event}`, `{"op":"frame", streamId, seq, jpegBase64}`, `{"op":"replay", events, cursor, total, done}`, `{"op":"chat.ack", id}`.
The token lives in `<vault>/.cubicle/daemon.json` (mode 0600); browser origins other than localhost and the viewer are refused.

_Generated by scripts/gen-docs.ts from packages/core/src/schemas.ts._
