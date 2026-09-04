# Vault schema

The Obsidian vault is the only source of truth. Agents and the owner both read and write it; the daemon keeps a rebuildable cache in `.cubicle/`. Every note below is markdown with YAML frontmatter (core YAML schema — timestamps stay strings).

```
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
```

## Who may write what

- Owner-owned (agents can only *propose*, enforced at the tool layer even through `..` paths and symlinks): `Brand/**`, `Roles/**`, `Memory/constitution.md`, `Memory/owner_preferences.md`, plus anything under the constitution's `never_modify`.
- Agent-restricted: `00 Inbox/` (only via `proposal.create`), `Messages/` (only via `colleague.message`), other roles' job notes and any job frontmatter (harness-owned), `.cubicle/`, `.env*`, `.git/`.
- Owner edits are detected by content sha (`written_sha`), never by git; a `Site/` file you edited is read-only for the Engineer until you say otherwise.

## Frontmatter contracts

### Job note (Jobs/<id>.md)

| field | type | notes |
|---|---|---|
| `id` | string | the filename is authoritative: `Jobs/<id>.md` — if a note's `id` field disagrees with its filename (e.g. you copied `_template.md` by hand), the daemon rewrites `id` to match the filename and logs one `daemon.warning` |
| `type` | string | known types: `engineer.ship`, `research`, `growth.outreach`, `growth.post`, `growth.seo`, `custom`, `team.plan`, `critic.premortem`, `qa.review`, `coo.verify`, `requester.review`, `company.plan`, `cto.plan`, `cto.compress_charters`, `ceo.heartbeat`, `colleague.answer` (a question a colleague asked, answered with `colleague.message(re:<id>)`); each has a `config/gates.yaml` entry |
| `title` | string |  |
| `assigned` | string |  |
| `status` | `queued` \| `running` \| `blocked` \| `in_review` \| `done` \| `failed` \| `cancelled` = `"queued"` | you may set `cancelled`; `blocked` without `blocked_on` = paused by you; `in_review` = the job's own work is done but it still owes a gate from `config/gates.yaml` |
| `priority` | number = `3` |  |
| `created` | string |  |
| `updated` | string |  |
| `attempt` | number = `1` |  |
| `max_attempts` | number = `3` |  |
| `depends_on` | string[] = `[]` |  |
| `approval` | `none` \| `pending` \| `approved` \| `rejected` = `"none"` |  |
| `checkpoint_step` | number = `0` | last completed tool step; resume starts after it |
| `side_effects_done` | string[] = `[]` | idempotency keys `<job>:<attempt>:<step>` of external actions already performed |
| `links` | string[] = `[]` |  |
| `privacy` | `cloud` \| `local` = `"cloud"` | `local` forces Ollama-only routing |
| `runs_on` | `laptop` \| `any` = `"laptop"` | reserved for a future remote mode |
| `blocked_on` | object (optional) | kind: message | job | proposal | quota | owner |
| `parent` | string (optional) |  |
| `team` | string (optional) | the team id (`Teams/<id>.md`) the job belongs to |
| `owner_role` | string (optional) | the lead who scheduled it, for jobs a member didn't request themselves |
| `for` | string (optional) | who a `research` job's findings are for (a lead, not a team) |
| `done_when` | string (optional) | the "Done when" a `team.plan` job set for a job it scheduled |
| `returns` | record<string, number> = `{}` | gate job type → how many times that gate has returned this job (once-per-gate: a second return from the same gate fails the job instead of looping forever) |
| `gate_index` | number (optional) | how far through its `config/gates.yaml` gate list the job has passed |
| `budget_from` | number (optional) | the checkpoint_step a gate return resumed from; the step loop runs until budget_from + maxSteps, so a return gets a fresh budget instead of the remainder of the attempt |

Body sections: `## Goal`, `## Plan`, `## Checkpoint log`, `## Result` (JSON block `{status, artifacts, metrics, blockers, lessons, summary}`).

### Role charter (Roles/<role>.md)

| field | type | notes |
|---|---|---|
| `role` | string |  |
| `display` | string |  |
| `model_tier` | `strong` \| `medium` \| `cheap` \| `local` = `"medium"` |  |
| `tools` | string[] = `[]` | names or `prefix.*`; charters may only *tighten* approval modes |
| `approval_overrides` | record<string, `auto` \| `propose` \| `ask` \| `never`> = `{}` |  |
| `active` | boolean = `true` |  |
| `hired` | string |  |
| `sprite` | string |  |
| `desk` | string | anchor id from config/world/desks.yaml |
| `team` | string (optional) | the team id (`Teams/<id>.md`) this role belongs to |
| `reports_to` | string (optional) | who this role reports to; a lead's own default is `ceo` |
| `title` | string (optional) | shown in the office and in prompts, e.g. "Head of Growth" |
| `persona` | string (optional) | a short voice/approach paragraph folded into the system prompt |
| `permissions` | `schedule` \| `plan` \| `review` \| `hire` \| `fire` \| `veto` \| `research_request` \| `reprioritize` \| `meeting`[] = `[]` | explicit grant; empty defers to the resolver's role-shaped default (`defaultPermissions`) |

Body: `# Charter` (system prompt), `# Standing rules`, `# What good looks like`.

### Team note (Teams/<id>.md)

| field | type | notes |
|---|---|---|
| `id` | string | matches the filename |
| `name` | string |  |
| `lead` | string | role id; the resolver treats this role as the team's lead |
| `members` | string[] = `[]` | role ids who report to the lead through this team |
| `mission` | string = `""` |  |
| `room` | string (optional) | office room id the team's desks sit in |
| `processes` | string[] = `[]` | `Processes/<name>.md` ids this team can run |

Body: freeform notes on how the team works, read into role prompts.

### Process note (Processes/<name>.md)

| field | type | notes |
|---|---|---|
| `name` | string | matches the filename |
| `steps` | array, 1–6 entries | each: `role` (string), `type` (string, default `"custom"`, a job type), `title` (string; `{objective}` is filled in when the process is expanded), `for` (string, optional — who the step's output is for), `gate` (string, optional) |

Body: freeform notes, appended to every expanded step's job goal.

### Inbox note (00 Inbox/*.md)

| field | type | notes |
|---|---|---|
| `id` | string |  |
| `kind` | `message` \| `hire` \| `fire` \| `brand_change` \| `charter_change` \| `file_change` \| `spend` \| `outbound_batch` \| `reorg` | `message` is a conversation; the rest are proposals |
| `created` | string |  |
| `from` | string |  |
| `to` | string = `"owner"` |  |
| `approved` | boolean \| null = `null` | set `true`/`false`; the daemon acts on the next tick and stamps `resolved_at` |
| `resolved_at` | string \| null = `null` |  |
| `answered` | boolean \| null = `null` |  |
| `chosen` | number \| null = `null` | for multi-option brand proposals |
| `call` | object (optional) | stored tool call executed after approval (`spend`, `outbound_batch`, `file_change`) |
| `target` | string (optional) | file a brand/charter/file change applies to (validated per kind) |
| `job` | string (optional) |  |

### Decision note (Decisions/*.md)

| field | type | notes |
|---|---|---|
| `id` | string |  |
| `decided_by` | string |  |
| `cycle` | string |  |
| `status` | `proposed` \| `adopted` \| `reverted` = `"proposed"` |  |
| `inputs` | string[] = `[]` |  |
| `owner_rating` | `up` \| `down` \| null (optional) | set `up`/`down`; `down` reaches the author as feedback |
| `rating_seen` | string (optional, ISO timestamp) | set to the delivery time once a `down` `owner_rating` has been delivered to the author as feedback, so it reaches them exactly once |
| `review_date` | string (optional) | optional date the author records for a second look, mirroring the `## Review date` body section; nothing schedules it — only `Experiments/` review dates are acted on |

Body sections: Context / Options considered / Chosen / Why / Expected effect / Review date.

### Finish contract (job Result block)

| field | type | notes |
|---|---|---|
| `status` | `done` \| `failed` \| `blocked` |  |
| `artifacts` | string[] = `[]` |  |
| `metrics` | record<string, number \| string> = `{}` |  |
| `blockers` | string[] = `[]` |  |
| `lessons` | string[] = `[]` |  |
| `summary` | string = `""` |  |
| `verdict` | `pass` \| `return` (optional) |  |
| `findings` | string[] = `[]` |  |

### Constitution (fenced `yaml` block in Memory/constitution.md)

### constitution

| field | type | notes |
|---|---|---|
| `max_emails_per_day` | number = `20` | enforced inside email.send |
| `banned_channels` | string[] = `[]` |  |
| `banned_tactics` | string[] = `[]` | substring match, then the local model as a classifier |
| `max_roles` | number = `8` |  |
| `auto_approve_hire` | boolean = `false` |  |
| `auto_approve_charter_changes` | boolean = `false` |  |
| `pii_local_only` | boolean = `false` | customer/email jobs run only on Ollama |
| `never_modify` | string[] = `[]` | extra owner-owned paths |
| `max_team_size` | number = `6` |  |
| `auto_approve_reorg` | boolean = `false` |  |

### Owner preferences (fenced `yaml` block in Memory/owner_preferences.md)

### owner_preferences

| field | type | notes |
|---|---|---|
| `approvals` | record<string, `auto` \| `propose` \| `ask` \| `never`> = `{}` | tool → auto | propose | ask | never (cannot loosen a config `never`) |
| `feedback` | string[] = `[]` | free-text lines the CEO sees every heartbeat |
| `shell_local_fallback` | boolean = `false` | allow a bubblewrap-jailed shell when Docker is missing |

## Owner feedback channels

Write in `00 Inbox/`; put `%%cubicle: …%%` comments in any note (attributed to its author role); add lines under `feedback:`; rate decisions with `owner_rating`.

_Generated by scripts/gen-docs.ts from packages/core/src/schemas.ts._
