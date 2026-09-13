/** Phase 12: generate docs/events.md and docs/vault-schema.md from the zod definitions so docs cannot drift from code. */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EVENT_TYPES, JobFrontmatter, RoleFrontmatter, TeamFrontmatter, IdeaFrontmatter, DecisionFrontmatter, InboxFrontmatter, Constitution, OwnerPreferences, JobResult, MAX_PROCESS_STEPS, loadGates, StreamFrontmatter, LedgerEntry } from '@cubicle/core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Where the two files go. Overridable so a test can generate into a temp dir and diff against the committed pair. */
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'docs');

/**
 * The job types the system knows, read from `config/gates.yaml` — the file that defines them — so a new type
 * cannot be added without appearing here. A few carry a note the gate table cannot express.
 */
const JOB_TYPE_NOTES: Record<string, string> = {
  'colleague.answer': 'a question a colleague asked, answered with `colleague.message(re:<id>)`',
};
const JOB_TYPES = Object.keys(loadGates(path.join(root, 'config', 'gates.yaml')))
  .map((t) => `\`${t}\`${JOB_TYPE_NOTES[t] ? ` (${JOB_TYPE_NOTES[t]})` : ''}`)
  .join(', ');

function describe(schema: z.ZodTypeAny): string {
  const s = schema as z.ZodTypeAny & { def?: { type?: string; innerType?: z.ZodTypeAny; defaultValue?: unknown; values?: unknown[]; entries?: Record<string, unknown>; options?: z.ZodTypeAny[]; element?: z.ZodTypeAny; valueType?: z.ZodTypeAny; in?: z.ZodTypeAny; out?: z.ZodTypeAny } };
  const d = s.def ?? {};
  switch (d.type) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'enum': return (d.entries ? Object.keys(d.entries) : (d.values ?? [])).map((v) => `\`${String(v)}\``).join(' \\| ');
    case 'array': return `${describe(d.element!)}[]`;
    case 'record': return `record<string, ${describe(d.valueType!)}>`;
    case 'optional': return `${describe(d.innerType!)} (optional)`;
    case 'nullable': return `${describe(d.innerType!)} \\| null`;
    case 'default': { const dv = typeof d.defaultValue === 'function' ? (d.defaultValue as () => unknown)() : d.defaultValue; return `${describe(d.innerType!)} = \`${JSON.stringify(dv)}\``; }
    case 'union': return (d.options ?? []).map(describe).join(' \\| ');
    // z.preprocess(coerce, z.string()) — Timestamp. The coercion is an implementation detail; the field's
    // type is what comes out of the pipe.
    case 'pipe': return describe((d.out ?? d.in)!);
    case 'object': return 'object';
    default: return d.type ?? 'unknown';
  }
}

/**
 * A fact about a field's *type* that zod cannot carry — a format, a unit. It is folded into the parenthesised
 * suffix `describe()` produces (`string (optional)` → `string (optional, ISO timestamp)`) rather than replacing
 * it, so the type itself still comes from the schema and cannot go stale behind this note.
 */
function withTypeNote(t: string, note?: string): string {
  if (!note) return t;
  return t.endsWith(')') ? `${t.slice(0, -1)}, ${note})` : `${t} (${note})`;
}

function table(name: string, schema: z.ZodObject<z.ZodRawShape>, notes: Record<string, string> = {}, typeNotes: Record<string, string> = {}): string {
  const rows = Object.entries(schema.shape).map(([k, v]) => `| \`${k}\` | ${withTypeNote(describe(v as z.ZodTypeAny), typeNotes[k])} | ${notes[k] ?? ''} |`);
  return `### ${name}\n\n| field | type | notes |\n|---|---|---|\n${rows.join('\n')}\n`;
}

const EVENT_NOTES: Record<string, string> = {
  'daemon.started': 'pid, port, roles', 'daemon.stopping': 'active_jobs', 'daemon.warning': 'where, message — never silent; a question timeout adds id (the unanswered message) and escalated_to; `where: provider_key` carries providers [{id, env}] instead of message (a cascade provider has no API key, so its models are unavailable); the money notices all carry reason instead of message — `money.runway.locked` and `money.accrual.locked` add path and are said once per lock (the accrual\'s once a day while it stands, naming the days it is skipping), `money.accrual.stamp` adds stamp and is said once per mistyped stamp value, `money.notices.unwritable` adds path and is said once per fault, `money.notices.unreadable` adds path and is said once per run. What has already been said lives in an in-process map, loaded once from .cubicle/money-notices.json and written through to it. The other money rows are per-failure, not deduped: `money.accrual` and `money.runway` carry message and mean the day\'s model cost could not be booked or Ledger/runway.md could not be regenerated (the cycle carries on either way — money can make the company cheaper, never silent), `money.ledger` adds path and means the book itself could not be read (a directory or an unreadable file where Ledger/ledger.md should be) — carries the heartbeat job and is said once per cycle however many times that cycle asks, the position reads as "nothing is known" for that cycle (not dormant, so nothing stops), the brief\'s money line says so, and runway.md is left as it was rather than regenerated from a stand-in, `ledger.append_retry` adds path and says the book changed under an append that is being retried on the fresh copy, and `dormant` carries message once per window while a worker waits for the company to be funded again; `where: trust` carries gate, proposal and tool, and is said once per office per proposal — an office with nobody to run its review means that call stays refused for ever',
  'heartbeat.started': 'trigger', 'heartbeat.completed': 'id, commit, run (Runs/ path), gathered_at',
  'job.queued': 'type, title, assigned, priority, risk', 'job.started': 'attempt, from_step, resumed', 'job.checkpoint': '`in_review` (the next gate job type the job now owes, or absent when it has none left), `summary`', 'job.blocked': 'reason (approval | message | job | quota), id', 'job.done': 'summary, artifacts, metrics, lessons', 'job.failed': 'reason, requeued, attempt', 'job.interrupted': 'checkpoint_step (daemon restart)', 'job.cancelled': 'at_step, reason — one per stop: a job cancelled while queued or blocked is announced by whatever cancelled it, a running one by its own loop at the next tool step',
  'agent.thinking': 'step', 'agent.tool_call': 'tool, summary (≤120 chars of args), step', 'agent.tool_result': 'tool, ok, step, summary', 'agent.spoke': 'to, text, kind — rendered as a speech bubble',
  'meeting.opened': 'id, room (`board` | `meeting` | `pantry`), participants, agenda, subject, title (the `meeting.open` tool sends path instead of subject/title)', 'meeting.turn': 'id, round, text', 'meeting.closed': 'id, room, subject, title, verdict, findings, decision (the `meeting.close` tool sends id, path, decision, turns; a pantry chat sends room: pantry, path (the `Pantry/` note), turns and a decision of `IDEA: <the idea>`, `IDEA not filed: <why>` or `no idea`). A board session on an **idea** also sends pressure (SP5b: the pressure test\'s one word — `STRONG`, `WEAK` or `PIVOT REQUIRED`) and rubric (that verdict\'s 0–2 × 5 score, already rendered as `7/10 — core assumption 2, …`, because the viewer depends on no package and must not re-derive it); a plan pre-mortem sends both empty',
  'browser.session_started': 'session', 'browser.frame': 'session, seq, path (.cubicle/screens/…; bytes travel only on the WS frame op)', 'browser.session_ended': 'session, frames',
  'shell.output': 'session, stream (cmd|stdout|stderr|info), text',
  'ci.completed': 'stream, green, record (the `Workspace/<stream>/.cubicle-ci/*.json` path), steps [{name, ok, code}]',
  'email.sent': 'to, subject, key, mode (mock|live)', 'email.received': 'from, subject, id, unsubscribe', 'deploy.done': 'url, project, mode (mock|live), key, stage (preview|canary|live), canary_percent (null off canary), canary_enforced (always false: the percentage is recorded, never enforced, until real traffic-splitting infrastructure exists), metrics (what the deployer said it would watch), rolled_back, snapshot (.cubicle/deploys/… path a rollback republishes), build_hash (content hash of the deployed directory; a live deploy needs a preview and a canary carrying the same hash), stream',
  'incident.opened': 'stream, trigger (rollback | red_ci_live | manual) — the clock the error budget counts from',
  'incident.recovered': 'stream, hours (open → recovered), postmortem (Docs/postmortems/… path)',
  'proposal.created': 'id, kind, path, title, to', 'proposal.resolved': 'id, kind, approved, outcome', 'role.hired': 'role, display, desk, sprite', 'role.fired': 'role',
  'router.call': 'provider, model, tier, tokens {prompt_tokens, completion_tokens}, tools, downgraded, reason (present only when downgraded: `cascade` or `division budget` — the latter is excluded from the "check your API keys" count), budget_division (which model-quota pool this call was gated against: a division id, or `house` for the heartbeat, the board session and the company\'s gates. Absent when the caller had no budget. `divisionSpend` prefers it and falls back to the role\'s own division for rows without it, so the gauge counts a call against the pool that paid for it)', 'router.downgraded': 'requested_tier, chosen_tier, provider, model, tried, reason (`cascade` — nothing at the asked-for tier had headroom; `division budget` — the division has spent its model quota for the day and drops to the cheapest tier, which never stops work)', 'quota.updated': 'provider, model, rpm_used, rpd_used, tpm_used, cooling_until, limits',
  'vault.wrote': 'path, sha, by (role | daemon | init | <role>/shell), deleted?, moved_from?, generated? (true for daemon-generated files such as `Jobs/queue.md`, `Metrics/quota.md`, `Metrics/daily.md`; the viewer ignores these for staleness)', 'owner.edited': 'path, area, deleted, wakes_heartbeat; a startup sweep of comments left while the daemon was down adds offline: true and comments (how many new %%cubicle: …%% comments the file gained)', 'owner.feedback_delivered': 'sha (sha1 of the trimmed `feedback:` line), source (`Memory/owner_preferences.md`) — emitted once per entry, at the commit of the heartbeat whose gather step collected it, so an entry added mid-cycle is deferred rather than lost, it is never re-delivered, and `cubicle rebuild` keeps the marker', 'guardrail.blocked': 'tool, reason — every refused call, never silent. The tool wrapper emits just those two; the harness loop and the dispatcher, which pre-check before spending an idempotency key, add step and approved: true; a refused stored call in a proposal note adds proposal and kind instead',
  'guardrail.checking': 'tool, role, job — the constitution\'s `banned_tactics` classifier is about to ask a model about this call\'s outbound copy, and nothing else will be written until it answers. It is the one guardrail check that leaves the process: every other one is arithmetic on the vault. Emitted once per classification, never for a memo hit (no call, so no wait), and always paired with a `guardrail.checked`',
  'guardrail.checked': 'tool, verdict (`clear` — nothing banned, the call goes on; `violation` — the model named a banned tactic, the call is refused and a `guardrail.blocked` follows; `unavailable` — the classifier timed out, errored or answered without a verdict, and the call is refused **closed**, because outbound copy nobody checked does not leave the company), elapsed_ms (how long the office was waiting). An `unavailable` verdict also emits one `daemon.warning` with `where: guardrail.classifier` naming the cause. The classifier is bounded by its own 20 s clock, not the provider\'s `timeout_ms`, so this pair can never be more than that far apart',
  'guardrail.deferred': 'tool, reason — and, from the dispatcher, proposal and kind instead of tool. A call that was neither made nor refused: the constitution\'s `banned_tactics` classifier could not reach a model, so nothing was decided about it. Distinct from `guardrail.blocked` on purpose — the approval still stands, the idempotency key is unspent, the proposal note is left open, and the next cycle sends it as soon as a model answers, so an office that rendered it as "not allowed" would be telling the owner the opposite of what the note\'s own footer says',
  'team.planned': 'team, jobs (ids the division.plan job scheduled)', 'review.passed': 'gate, findings — and on a **trust** review (SP5: an outbound call the compliance and security offices cleared) also key (the call\'s idempotency key, which is what `trustState` reads), proposal (the `00 Inbox/` note holding the call) and trust: true. A chain review of a job carries no key, so the two are never mistaken for each other', 'review.returned': 'the same payload as review.passed; a trust return closes the call unsent, and a review job that *failed* is recorded as a return, because a review that did not happen is not a pass', 'plan.vetoed': 'findings, vetoes (count so far this cycle), reason (board return | unkept ideas)', 'research.delivered': 'emitted on the requester\'s research job', 'org.changed': 'reason (migration | reorg | fire), changed | teams | role',
};

const events = `# Events

Every agent and daemon action is one typed event appended to \`.cubicle/cubicle.db\` (\`events\` table) and mirrored to \`.cubicle/events/YYYY-MM-DD.jsonl\`. The office is a pure renderer of this log; \`cubicle replay <date>\` and the viewer's replay slider read it back. The JSONL mirror is the durable copy; \`cubicle rebuild\` recreates the SQLite index from it.

Envelope: \`{ id, ts (ISO), type, agent (role id | daemon | owner | init | null), job (job id | null), payload }\`.

| type | payload |
|---|---|
${EVENT_TYPES.map((t) => `| \`${t}\` | ${EVENT_NOTES[t] ?? ''} |`).join('\n')}

## WebSocket (ws://127.0.0.1:7411?token=…)

Client → server: \`{"op":"snapshot"}\`, \`{"op":"replay","from":ISO,"to":ISO,"cursor":n}\` (5 000 events per page), \`{"op":"chat","text":"…"}\` (writes a \`kind: message\` note for the CEO), \`{"op":"decide","id":"prop_…","approved":bool,"chosen":n?,"comment":"…"?}\` (SP8: decides a proposal from inside CUBICLE), \`{"op":"conversation.get","id":"meeting:…"}\`. An unknown op is ignored; a known op the daemon cannot parse answers \`{"op":"error", message}\`.
Server → client: \`{"op":"snapshot", roles, jobs, surfaces, quota, money, latestRun, plan, pendingProposals, teams (each with \`wip: { limits, load }\` per Kanban lane)}\`, \`{"op":"event", …event}\`, \`{"op":"frame", streamId, seq, jpegBase64}\`, \`{"op":"replay", events, cursor, total, done}\`, \`{"op":"chat.ack", id}\`, \`{"op":"decide.ack", id}\`, \`{"op":"conversation", id, turns: [{who, at, text}]}\`.
\`decide\` writes the note through \`ownerDecide\` **as the owner** (ruling P8-1) — \`approved\`, \`chosen\` and \`approved_by: owner\` into the frontmatter, \`comment\` as a trailing owner paragraph, which is the shape the founder brief's rejection path already reads — and then asks for a dispatcher tick, so the decision is applied at once. The dispatcher's owner guard honours it by name: a write recorded under \`owner\` is a human decision, alongside the sha comparison that catches an Obsidian edit. A note that does not exist, is already resolved, or gets a \`chosen\` matching no option is refused with \`{"op":"error"}\` and nothing is written.
The snapshot's \`inbox\` rows carry, beyond \`{id, kind, title, path, created}\`: \`from\`, \`job\`, \`target\`, \`body\` (the note as markdown, capped at 32 KB), \`options\` [{n, label}] (the numbered lines \`chosen:\` is matched against — \`brand_change\` only — or the fixed keep/park/scrap table for \`idea_verdict\`; \`[]\` otherwise), \`band\`, \`band_reason\`, \`board_verdict\`, \`pressure\` (the \`## Pressure test\` block, when the note has one) and \`decidable\` (\`adopt\` for a \`founder_brief\`, \`choose\` where there are options, \`approve\` otherwise). \`decided\` is the last 20 closed notes {id, kind, title, path, created, resolved_at, approved, chosen, outcome} — \`outcome\` being the dispatcher's own \`_Resolved …_\` footer. \`conversations\` is every thread in the vault, newest first and at most 60: {id, kind (\`dm\` | \`meeting\` | \`board\` | \`pantry\` | \`agents\`), title, room?, participants, updated, open, last {who, text, at} | null, turns}; the full turns of one come from \`conversation.get\`, which carries the newest 500 (\`turns\` on the thread still counts everything that was said).
The snapshot's \`money\` block is the bank screen's: \`currency\`, \`cash_cents\`/\`cash\`, \`burn_cents_per_day\`/\`burn\`, \`runway_days\`/\`runway\`, \`dormant\`, \`mock_revenue_cents\`/\`mock_revenue\`, \`problems\`, \`budgets\` [{division, used, quota}], and the last six \`entries\` [{at, kind, amount, mode, who, why}] newest first. Every figure crosses the wire **twice** — integer minor units and the string to print — because the viewer never formats money (SP4 decision 16); \`why\` is capped at 80 characters there. It is \`null\` when the book could not be read, and \`budgets\` is empty when the router has no providers file.
The token lives in \`<vault>/.cubicle/daemon.json\` (mode 0600); browser origins other than localhost and the viewer are refused.

_Generated by scripts/gen-docs.ts from packages/core/src/schemas.ts._
`;
writeFileSync(path.join(outDir, 'events.md'), events);

const vault = `# Vault schema

The Obsidian vault is the only source of truth. Agents and the owner both read and write it; the daemon keeps a rebuildable cache in \`.cubicle/\`. Every note below is markdown with YAML frontmatter (core YAML schema — timestamps stay strings).

\`\`\`
<Vault>/
  00 Inbox/               owner ↔ CEO messages and every proposal awaiting you (kind + approved)
  Brand/                  logo.png, name.md, palette.md, voice.md            (owner-owned)
  Plans/                  plan.md (current), archive/<stamp>-<id>.md
  Roles/                  <role>.md charters (owner-owned; agents propose), archive/
  Runs/                   one "since you were away" brief per heartbeat
  Decisions/              one note per decision (meetings, adoptions)
  Discovery/              inbox/ (owner drops files here), interview.md (the CEO's six questions and your answer)
  Customers/              one note per lead (slug-hash), _suppression.md
  Metrics/                daily.md, quota.md, payment_links.md, research.md (regenerated weekly)
  Memory/                 constitution.md (agent-immutable, tool-enforced), owner_preferences.md, lessons.md, founder-brief.md
  Skills/                 reusable procedures written by agents (archive/ for pruned ones)
  Experiments/            hypothesis/metric/review_date notes (_template.md), posts/ drafts
  Ideas/                  idea cards filed by continuous intelligence and by discovery (_template.md)
  Research/               index.md (every delivered project), <slug>/ projects, archive/ page snapshots,
                          intelligence/<date>-c<cycle>-<kind>.md sweeps, followups/<job>.md predictions
  Jobs/                   <job-id>.md (frontmatter = state machine), queue.md (generated), _template.md
  Ledger/                 ledger.md (append-only: capital, revenue, cost), runway.md (generated: cash, burn, runway)
  Pantry/                 one note per pantry chat: the transcript, and the idea if one came of it
  Messages/               <role>.md colleague inboxes (agent-writable; HTML-comment read markers)
  Site/                   the website source; dist/ is the build (gitignored)
  Streams/                one note per product stream (problem, customers, outcome metric, error budget)
  Workspace/              <stream>/ product source, cubicle-ci.yaml, flags.json, .cubicle-ci/ records
  Meetings/               transcripts
  .cubicle/               cache: cubicle.db, events/*.jsonl, screens/, browser/<role>/, mock/, jobs/, daemon.json
\`\`\`

## Who may write what

- Owner-owned (agents can only *propose*, enforced at the tool layer even through \`..\` paths and symlinks): \`Brand/**\`, \`Roles/**\`, \`Memory/constitution.md\`, \`Memory/owner_preferences.md\`, plus anything under the constitution's \`never_modify\`.
- Agent-restricted: \`00 Inbox/\` (only via \`proposal.create\`), \`Messages/\` (only via \`colleague.message\`), other roles' job notes and any job frontmatter (harness-owned), \`.cubicle/\`, \`.env*\`, \`.git/\`.
- Owner edits are detected by content sha (\`written_sha\`), never by git; a \`Site/\` file you edited is read-only for the Engineer until you say otherwise.

## Frontmatter contracts

${table('Job note (Jobs/<id>.md)', JobFrontmatter as unknown as z.ZodObject<z.ZodRawShape>, { id: 'the filename is authoritative: `Jobs/<id>.md` — if a note\'s `id` field disagrees with its filename (e.g. you copied `_template.md` by hand), the daemon rewrites `id` to match the filename and logs one `daemon.warning`', type: `known types: ${JOB_TYPES}; each has a \`config/gates.yaml\` entry`, status: 'you may set `cancelled`; `blocked` without `blocked_on` = paused by you; `in_review` = the job\'s own work is done but it still owes a gate from `config/gates.yaml`', checkpoint_step: 'last completed tool step; resume starts after it', side_effects_done: 'idempotency keys `<job>:<attempt>:<step>` of external actions already performed', privacy: '`local` forces Ollama-only routing', runs_on: 'reserved for a future remote mode', blocked_on: 'kind: message | job | proposal | quota | owner', team: 'the team id (`Teams/<id>.md`) the job belongs to', owner_role: 'the lead who scheduled it, for jobs a member didn\'t request themselves', for: 'who a `research` job\'s findings are for (a lead, not a team)', done_when: 'the "Done when" a `division.plan` job set for a job it scheduled', risk: '`low` | `medium` | `high` (owner\'s operating model §27). `medium` inserts an `office:security.review` gate before the rest of the chain; `high` also requires an approved `threat_model` proposal before the job may finish', stream: 'the `Streams/<slug>.md` this job serves; `ci.run`, the ship gate and the error budget all key on it', returns: 'gate job type → how many times that gate has returned this job (once-per-gate: a second return from the same gate fails the job instead of looping forever)', gate_index: 'how far through its `config/gates.yaml` gate list the job has passed', budget_from: 'the checkpoint_step a gate return resumed from; the step loop runs until budget_from + maxSteps, so a return gets a fresh budget instead of the remainder of the attempt', research: 'the universal research request this job carries (decision, question, evidence, confidence, portfolio, score)', research_slug: 'the Research/<slug>/ project directory for this job', model_tier: 'pins a cheaper tier than the assigned role\'s charter asks for; never routes above it, and never above the `privacy` rule. A review job created by a gate chain carries `medium` (or the gate\'s own `model_tier:` in `config/gates.yaml`), so a review never spends the reviewer\'s strong-tier allowance', trust_key: 'on a trust review job (SP5): the idempotency key of the outbound call it gates. The pair with `trust_proposal` is what turns the reviewer\'s verdict into the record; a trust review gates a *call*, so it has no `parent`', trust_proposal: 'the `00 Inbox/` proposal holding the call under review', pantry_with: 'on a `pantry.chat` job: the other person at the counter' })}
Body sections: \`## Goal\`, \`## Plan\`, \`## Checkpoint log\`, \`## Result\` (JSON block \`{status, artifacts, metrics, blockers, lessons, summary}\`).

${table('Role charter (Roles/<role>.md)', RoleFrontmatter as unknown as z.ZodObject<z.ZodRawShape>, { tools: 'names or `prefix.*`; charters may only *tighten* approval modes', desk: 'anchor id from config/world/desks.yaml', team: 'the team id (`Teams/<id>.md`) this role belongs to', reports_to: 'who this role reports to; a lead\'s own default is `ceo`', title: 'shown in the office and in prompts, e.g. "Head of Growth"', persona: 'a short voice/approach paragraph folded into the system prompt', permissions: 'explicit grant; empty defers to the resolver\'s role-shaped default (`defaultPermissions`)' })}
Body: \`# Charter\` (system prompt), \`# Standing rules\`, \`# What good looks like\`.

${table('Team note (Teams/<id>.md)', TeamFrontmatter as unknown as z.ZodObject<z.ZodRawShape>, { id: 'matches the filename', lead: 'role id; the resolver treats this role as the team\'s lead', members: 'role ids who report to the lead through this team', room: 'office room id the team\'s desks sit in', floor: 'which office floor the team\'s room is on', parent: 'the division this team belongs to (dev → technology); planning happens at the division', processes: '`Processes/<name>.md` ids this team can run', wip: 'work-in-progress limits per Kanban lane; `nextJob` refuses to start work past `in_progress` and the office shows a full lane as a red tab on the room sign. No `wip:` at all (most teams today) means unlimited — never refused' })}
Body: freeform notes on how the team works, read into role prompts.

${table('Idea card (Ideas/<slug>.md)', IdeaFrontmatter as unknown as z.ZodObject<z.ZodRawShape>, { id: 'matches the filename', source: 'where the idea came from: `discovery`, `intelligence:<kind>`, `pantry`, `owner`, or a job id', status: 'new → triaged → accepted | rejected (the card\'s lifecycle)', evidence: 'paths or URLs backing the change that prompted it — an idea with none is a hunch', decision: 'undecided → keep | park | scrap (what the company decided to do about it); only a kept idea may appear in Plans/plan.md', score: '`4 × value + 3 × evidence + 3 × effort + 2 × fit`, 12–60, derived from `score_inputs` on every write; null until both offices have answered', score_inputs: 'the research office sets `evidence` and `fit`; the finance office sets `value` and `effort` (inverted: 5 is cheapest)', research: 'the `Research/<slug>/report.md` behind the demand claim', estimate: 'the finance office\'s rough order of magnitude, in words — never a ledger entry', board_verdict: 'pass | return from the board session; a return parks a keep', board_decision: 'the `Decisions/board-<slug>.md` note the session wrote', board_pressure: 'SP5b: the board\'s pressure-test verdict in one word — `STRONG`, `WEAK` or `PIVOT REQUIRED` (`Docs/pressure-test-handbook.md`). Empty on a card the board has not pressure-tested', board_rubric: 'SP5b: the board\'s 0–2 score on core assumption, fatal flaws, pain, founder fit and why now, out of 10. Advisory — it never moves `score`, `score_inputs` or the keep/park/scrap band', board_transcript: 'SP8: the `Meetings/<stamp>-board-<slug>.md` transcript of the dialogue that judged it, so the owner\'s note can link the argument. Empty under `board_dialogue: brief`, which holds no dialogue', board_questions: 'SP8: what that session could not answer from the material and asked the owner instead; the owner\'s note lists them and one cabin message from the chair carries them' })}
Body: \`## What changed\`, \`## Why it might matter\`, \`## Evidence\`, \`## Research\`, \`## What it would cost\`, \`## The board\`, \`## Score\`, \`## Decision\`.

${table('Ledger entry (one row in Ledger/ledger.md)', LedgerEntry as unknown as z.ZodObject<z.ZodRawShape>, { at: 'when the money moved, not when the row was written', kind: '\`capital\` (the owner puts money in) \\| \`revenue\` (money in) \\| \`cost\` (money out); the kind carries the sign, so an amount is never negative', cents: 'integer minor units. In the file this is the \`amount\` column, a positive decimal with at most two places — \`parseMoney\` reads the digits either side of the point as strings, never as a float', mode: '\`live\` — real money moved and it counts as cash. \`mock\` — a simulation (a mock sale, a mock charge); reported separately and never counted', who: '\`owner\`, or the role id that recorded it', why: 'one sentence; required, because an entry nobody can explain is an entry nobody can check', ref: 'an idempotency key (a job id, \`model-<date>\`) or empty; a second entry with the same non-empty ref is refused, so a replayed cycle cannot double-charge' })}
The file is a markdown table the owner can edit in Obsidian, and it is **append-only**: \`appendEntry\` splices one
row in after the last and never touches another byte. A row that does not parse is kept in the file and reported
in the brief with its line number, never dropped. Correct a mistake with a compensating row.

\`Ledger/runway.md\` is generated after every heartbeat and carries the figures in its frontmatter —
\`cash_cents\`, \`burn_cents_per_day\`, \`runway_days\` (null when nothing is being spent), \`dormant\`,
\`entries\`, \`problems\` — so nothing has to read its prose. Every figure is arithmetic over the ledger; the one
section a person writes is "What the CFO makes of it", which is the daily \`finance.runway\` job's summary.

${table('Stream note (Streams/<slug>.md)', StreamFrontmatter as unknown as z.ZodObject<z.ZodRawShape>, { slug: 'matches the filename', outcome_metric: 'one number with a from and a to; never a feature list', owner_team: 'the team id accountable for the outcome', error_budget: 'incident-hours a week before the division plan must prioritise reliability (§23)', repo_path: 'where the code lives, and what `ci.run` mounts — `Workspace/<slug>` by default' })}
Body sections: \`## Problem\`, \`## Customers\`, \`## Outcome metric\`, \`## Runbook\`, \`## Error budget\`.

### Process note (Processes/<name>.md)

| field | type | notes |
|---|---|---|
| \`name\` | string | matches the filename |
| \`steps\` | array, 1–${MAX_PROCESS_STEPS} entries | each: \`role\` (string), \`type\` (string, default \`"custom"\`, a job type), \`title\` (string; \`{objective}\` is filled in when the process is expanded), \`for\` (string, optional — who the step's output is for), \`gate\` (string, optional) |

Body: freeform notes, appended to every expanded step's job goal.

${table('Inbox note (00 Inbox/*.md)', InboxFrontmatter as unknown as z.ZodObject<z.ZodRawShape>, { kind: '`message` is a conversation; the rest are proposals', approved: 'set `true`/`false`; the daemon acts on the next tick and stamps `resolved_at`', chosen: 'for multi-option brand proposals', call: 'stored tool call executed after approval (`spend`, `outbound_batch`, `file_change`)', target: 'file a brand/charter/file change applies to (validated per kind)' })}
${table('Decision note (Decisions/*.md)', DecisionFrontmatter as unknown as z.ZodObject<z.ZodRawShape>, { owner_rating: 'set `up`/`down`; `down` reaches the author as feedback', rating_seen: 'set to the delivery time once a `down` `owner_rating` has been delivered to the author as feedback, so it reaches them exactly once', review_date: 'optional date the author records for a second look, mirroring the `## Review date` body section; nothing schedules it — only `Experiments/` review dates are acted on' }, { rating_seen: 'ISO timestamp' })}
Body sections: Context / Options considered / Chosen / Why / Expected effect / Review date.

${table('Finish contract (job Result block)', JobResult as unknown as z.ZodObject<z.ZodRawShape>, { architecture_change: 'set true when the change added a dependency, a service, a data store, or a changed boundary (toolchain §8); an `engineer.ship` that sets it is refused until an ADR in Docs/adr/ is dated on or after the job\'s creation' })}
### Constitution (fenced \`yaml\` block in Memory/constitution.md)

${table('constitution', Constitution as unknown as z.ZodObject<z.ZodRawShape>, { max_emails_per_day: 'enforced inside email.send', banned_tactics: 'a substring match first, then a cheap model as a classifier — through the ordinary cascade (so `CUBICLE_DISABLE_PROVIDERS` is honoured and a local model that is off or wedged is simply not a candidate), charged to the house, bounded by the guardrail\'s own 20 s clock rather than the provider\'s, and **failing closed**: a timeout, an error or a reply with no verdict refuses the call, because outbound copy nobody checked does not leave the company. The wait is announced with `guardrail.checking` / `guardrail.checked`', pii_local_only: 'customer/email jobs run only on Ollama', never_modify: 'extra owner-owned paths', offices: 'office → role id, for the eight offices (`chief_executive, finance, operations, security, compliance, people, research, engineering`); gates, escalation and planning ask for the office, so re-staffing a seat is an edit here rather than a code change', board_decides_after_hours: 'hours a plan waits for the owner\'s verdict before the board\'s own verdict stands; `0` (the default, and an absent key) means it waits indefinitely — the board advises, only the owner rules', board_dialogue: 'how the board holds a pressure test: `full` (the default) is the dialogue — the chair states each of the five questions in its own words, the other two advisors answer it in turn, the chair rules on each round in the open, and the whole argument is written to a `Meetings/` transcript the owner\'s note links (six rounds, at most 17 model calls); `brief` is the pre-SP8 session — three pre-mortems and one merge, four calls and no transcript. Both end on the same verdict parse' })}
### Owner preferences (fenced \`yaml\` block in Memory/owner_preferences.md)

${table('owner_preferences', OwnerPreferences as unknown as z.ZodObject<z.ZodRawShape>, { approvals: 'tool → auto | propose | ask | never (cannot loosen a config `never`)', feedback: 'free-text lines the CEO sees every heartbeat', shell_local_fallback: 'allow a bubblewrap-jailed shell when Docker is missing' })}
## Owner feedback channels

Write in \`00 Inbox/\`; put \`%%cubicle: …%%\` comments in any note (attributed to its author role); add lines under \`feedback:\`; rate decisions with \`owner_rating\`.

_Generated by scripts/gen-docs.ts from packages/core/src/schemas.ts._
`;
writeFileSync(path.join(outDir, 'vault-schema.md'), vault);
console.log(`wrote ${path.join(outDir, 'events.md')} and ${path.join(outDir, 'vault-schema.md')}`);
