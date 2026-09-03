/** Phase 12: generate docs/events.md and docs/vault-schema.md from the zod definitions so docs cannot drift from code. */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EVENT_TYPES, JobFrontmatter, RoleFrontmatter, TeamFrontmatter, DecisionFrontmatter, InboxFrontmatter, Constitution, OwnerPreferences, JobResult, MAX_PROCESS_STEPS } from '@cubicle/core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function describe(schema: z.ZodTypeAny): string {
  const s = schema as z.ZodTypeAny & { def?: { type?: string; innerType?: z.ZodTypeAny; defaultValue?: unknown; values?: unknown[]; entries?: Record<string, unknown>; options?: z.ZodTypeAny[]; element?: z.ZodTypeAny; valueType?: z.ZodTypeAny } };
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
    case 'object': return 'object';
    default: return d.type ?? 'unknown';
  }
}

function table(name: string, schema: z.ZodObject<z.ZodRawShape>, notes: Record<string, string> = {}): string {
  const rows = Object.entries(schema.shape).map(([k, v]) => `| \`${k}\` | ${describe(v as z.ZodTypeAny)} | ${notes[k] ?? ''} |`);
  return `### ${name}\n\n| field | type | notes |\n|---|---|---|\n${rows.join('\n')}\n`;
}

const EVENT_NOTES: Record<string, string> = {
  'daemon.started': 'pid, port, roles', 'daemon.stopping': 'active_jobs', 'daemon.warning': 'where, message — never silent',
  'heartbeat.started': 'trigger', 'heartbeat.completed': 'id, commit, run (Runs/ path), gathered_at',
  'job.queued': 'type, title, assigned, priority', 'job.started': 'attempt, from_step, resumed', 'job.checkpoint': 'reserved', 'job.blocked': 'reason (approval | message | job | quota), id', 'job.done': 'summary, artifacts, metrics, lessons', 'job.failed': 'reason, requeued, attempt', 'job.interrupted': 'checkpoint_step (daemon restart)', 'job.cancelled': 'at_step',
  'agent.thinking': 'step', 'agent.tool_call': 'tool, summary (≤120 chars of args), step', 'agent.tool_result': 'tool, ok, step, summary', 'agent.spoke': 'to, text, kind — rendered as a speech bubble',
  'meeting.opened': 'id, room, participants, agenda, path', 'meeting.turn': 'id, round, text', 'meeting.closed': 'id, path, decision, turns',
  'browser.session_started': 'session', 'browser.frame': 'session, seq, path (.cubicle/screens/…; bytes travel only on the WS frame op)', 'browser.session_ended': 'session, frames',
  'shell.output': 'session, stream (cmd|stdout|stderr|info), text', 'email.sent': 'to, subject, key, mode (mock|live)', 'email.received': 'from, subject, id, unsubscribe', 'deploy.done': 'url, project, mode, key',
  'proposal.created': 'id, kind, path, title, to', 'proposal.resolved': 'id, kind, approved, outcome', 'role.hired': 'role, display, desk, sprite', 'role.fired': 'role',
  'router.call': 'provider, model, tier, tokens {prompt_tokens, completion_tokens}, tools, downgraded', 'router.downgraded': 'requested_tier, chosen_tier, provider, model, tried', 'quota.updated': 'provider, model, rpm_used, rpd_used, tpm_used, cooling_until, limits',
  'vault.wrote': 'path, sha, by (role | daemon | init | <role>/shell), deleted?, moved_from?', 'owner.edited': 'path, area, deleted, wakes_heartbeat', 'guardrail.blocked': 'tool, reason, step — every refused call, never silent',
  'team.planned': 'team, jobs (ids the team.plan job scheduled)', 'review.passed': 'gate, findings', 'review.returned': 'gate, findings', 'plan.vetoed': 'findings, vetoes (count so far this cycle)', 'research.delivered': 'emitted on the requester\'s research job', 'org.changed': 'reason (migration | reorg | fire), changed | teams | role',
};

const events = `# Events

Every agent and daemon action is one typed event appended to \`.cubicle/cubicle.db\` (\`events\` table) and mirrored to \`.cubicle/events/YYYY-MM-DD.jsonl\`. The office is a pure renderer of this log; \`cubicle replay <date>\` and the viewer's replay slider read it back. The JSONL mirror is the durable copy; \`cubicle rebuild\` recreates the SQLite index from it.

Envelope: \`{ id, ts (ISO), type, agent (role id | daemon | owner | init | null), job (job id | null), payload }\`.

| type | payload |
|---|---|
${EVENT_TYPES.map((t) => `| \`${t}\` | ${EVENT_NOTES[t] ?? ''} |`).join('\n')}

## WebSocket (ws://127.0.0.1:7411?token=…)

Client → server: \`{"op":"snapshot"}\`, \`{"op":"replay","from":ISO,"to":ISO,"cursor":n}\` (5 000 events per page), \`{"op":"chat","text":"…"}\` (writes a \`kind: message\` note for the CEO).
Server → client: \`{"op":"snapshot", roles, jobs, surfaces, quota, latestRun, plan, pendingProposals}\`, \`{"op":"event", …event}\`, \`{"op":"frame", streamId, seq, jpegBase64}\`, \`{"op":"replay", events, cursor, total, done}\`, \`{"op":"chat.ack", id}\`.
The token lives in \`<vault>/.cubicle/daemon.json\` (mode 0600); browser origins other than localhost and the viewer are refused.

_Generated by scripts/gen-docs.ts from packages/core/src/schemas.ts._
`;
writeFileSync(path.join(root, 'docs', 'events.md'), events);

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
  Customers/              one note per lead (slug-hash), _suppression.md
  Metrics/                daily.md, quota.md, payment_links.md
  Memory/                 constitution.md (agent-immutable, tool-enforced), owner_preferences.md, lessons.md
  Skills/                 reusable procedures written by agents (archive/ for pruned ones)
  Experiments/            hypothesis/metric/review_date notes (_template.md), posts/ drafts
  Jobs/                   <job-id>.md (frontmatter = state machine), queue.md (generated), _template.md
  Messages/               <role>.md colleague inboxes (agent-writable; HTML-comment read markers)
  Site/                   the website source; dist/ is the build (gitignored)
  Meetings/               transcripts
  .cubicle/               cache: cubicle.db, events/*.jsonl, screens/, browser/<role>/, mock/, jobs/, daemon.json
\`\`\`

## Who may write what

- Owner-owned (agents can only *propose*, enforced at the tool layer even through \`..\` paths and symlinks): \`Brand/**\`, \`Roles/**\`, \`Memory/constitution.md\`, \`Memory/owner_preferences.md\`, plus anything under the constitution's \`never_modify\`.
- Agent-restricted: \`00 Inbox/\` (only via \`proposal.create\`), \`Messages/\` (only via \`colleague.message\`), other roles' job notes and any job frontmatter (harness-owned), \`.cubicle/\`, \`.env*\`, \`.git/\`.
- Owner edits are detected by content sha (\`written_sha\`), never by git; a \`Site/\` file you edited is read-only for the Engineer until you say otherwise.

## Frontmatter contracts

${table('Job note (Jobs/<id>.md)', JobFrontmatter as unknown as z.ZodObject<z.ZodRawShape>, { status: 'you may set `cancelled`; `blocked` without `blocked_on` = paused by you; `in_review` = the job\'s own work is done but it still owes a gate from `config/gates.yaml`', checkpoint_step: 'last completed tool step; resume starts after it', side_effects_done: 'idempotency keys `<job>:<attempt>:<step>` of external actions already performed', privacy: '`local` forces Ollama-only routing', runs_on: 'reserved for a future remote mode', blocked_on: 'kind: message | job | proposal | quota | owner', team: 'the team id (`Teams/<id>.md`) the job belongs to', owner_role: 'the lead who scheduled it, for jobs a member didn\'t request themselves', for: 'who a `research` job\'s findings are for (a lead, not a team)', done_when: 'the "Done when" a `team.plan` job set for a job it scheduled', returns: 'gate job type → how many times that gate has returned this job (once-per-gate: a second return from the same gate passes through instead of looping forever)', gate_index: 'how far through its `config/gates.yaml` gate list the job has passed' })}
Body sections: \`## Goal\`, \`## Plan\`, \`## Checkpoint log\`, \`## Result\` (JSON block \`{status, artifacts, metrics, blockers, lessons, summary}\`).

${table('Role charter (Roles/<role>.md)', RoleFrontmatter as unknown as z.ZodObject<z.ZodRawShape>, { tools: 'names or `prefix.*`; charters may only *tighten* approval modes', desk: 'anchor id from config/world/desks.yaml', team: 'the team id (`Teams/<id>.md`) this role belongs to', reports_to: 'who this role reports to; a lead\'s own default is `ceo`', title: 'shown in the office and in prompts, e.g. "Head of Growth"', persona: 'a short voice/approach paragraph folded into the system prompt', permissions: 'explicit grant; empty defers to the resolver\'s role-shaped default (`defaultPermissions`)' })}
Body: \`# Charter\` (system prompt), \`# Standing rules\`, \`# What good looks like\`.

${table('Team note (Teams/<id>.md)', TeamFrontmatter as unknown as z.ZodObject<z.ZodRawShape>, { id: 'matches the filename', lead: 'role id; the resolver treats this role as the team\'s lead', members: 'role ids who report to the lead through this team', room: 'office room id the team\'s desks sit in', processes: '`Processes/<name>.md` ids this team can run' })}
Body: freeform notes on how the team works, read into role prompts.

### Process note (Processes/<name>.md)

| field | type | notes |
|---|---|---|
| \`name\` | string | matches the filename |
| \`steps\` | array, 1–${MAX_PROCESS_STEPS} entries | each: \`role\` (string), \`type\` (string, default \`"custom"\`, a job type), \`title\` (string; \`{objective}\` is filled in when the process is expanded), \`for\` (string, optional — who the step's output is for), \`gate\` (string, optional) |

Body: freeform notes, appended to every expanded step's job goal.

${table('Inbox note (00 Inbox/*.md)', InboxFrontmatter as unknown as z.ZodObject<z.ZodRawShape>, { kind: '`message` is a conversation; the rest are proposals', approved: 'set `true`/`false`; the daemon acts on the next tick and stamps `resolved_at`', chosen: 'for multi-option brand proposals', call: 'stored tool call executed after approval (`spend`, `outbound_batch`, `file_change`)', target: 'file a brand/charter/file change applies to (validated per kind)' })}
${table('Decision note (Decisions/*.md)', DecisionFrontmatter as unknown as z.ZodObject<z.ZodRawShape>, { owner_rating: 'set `up`/`down`; `down` reaches the author as feedback' })}
Body sections: Context / Options considered / Chosen / Why / Expected effect / Review date.

${table('Finish contract (job Result block)', JobResult as unknown as z.ZodObject<z.ZodRawShape>)}
### Constitution (fenced \`yaml\` block in Memory/constitution.md)

${table('constitution', Constitution as unknown as z.ZodObject<z.ZodRawShape>, { max_emails_per_day: 'enforced inside email.send', banned_tactics: 'substring match, then the local model as a classifier', pii_local_only: 'customer/email jobs run only on Ollama', never_modify: 'extra owner-owned paths' })}
### Owner preferences (fenced \`yaml\` block in Memory/owner_preferences.md)

${table('owner_preferences', OwnerPreferences as unknown as z.ZodObject<z.ZodRawShape>, { approvals: 'tool → auto | propose | ask | never (cannot loosen a config `never`)', feedback: 'free-text lines the CEO sees every heartbeat', shell_local_fallback: 'allow a bubblewrap-jailed shell when Docker is missing' })}
## Owner feedback channels

Write in \`00 Inbox/\`; put \`%%cubicle: …%%\` comments in any note (attributed to its author role); add lines under \`feedback:\`; rate decisions with \`owner_rating\`.

_Generated by scripts/gen-docs.ts from packages/core/src/schemas.ts._
`;
writeFileSync(path.join(root, 'docs', 'vault-schema.md'), vault);
console.log('wrote docs/events.md and docs/vault-schema.md');
