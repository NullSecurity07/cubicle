import { z } from 'zod';
import { nowIso } from './fs.js';
import { ResearchRequest } from './research.js';

// ---------- Jobs ----------
export const JobStatus = z.enum(['queued', 'running', 'blocked', 'in_review', 'done', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;

/**
 * Every job type the daemon or an agent may create. Gates are named by the office that runs them
 * (`office:<office>.<verb>`) or by the room whose lead runs them (`team:<team>.<verb>`) — never by a role id.
 * `qa.review`, `coo.verify` and `security.review` are the pre-office names, kept listed (and kept in
 * `config/gates.yaml`) so a job queued before the rename still validates and still finds its gate table entry.
 */
export const KNOWN_JOB_TYPES = [
  'engineer.ship', 'growth.outreach', 'growth.post', 'growth.seo', 'office:operations.verify',
  'cto.plan', 'cto.compress_charters', 'ceo.heartbeat', 'research', 'custom',
  'company.plan', 'division.plan', 'board.premortem', 'team.plan', 'critic.premortem',
  'team:qa.review', 'office:security.review', 'colleague.answer',
  'research.review', 'research.measure', 'intelligence',
  'incident',
  // SP3: discovery reads the owner's material and files the founder brief; board.session is the board's record
  // of judging one idea (board.premortem stays the plan's); finance.estimate prices an idea for its dossier.
  'discovery', 'board.session', 'finance.estimate',
  'qa.review', 'coo.verify', 'security.review',
  // SP4: the CFO's daily read of the book — one job a calendar day, whose commentary becomes the one
  // agent-written section of Ledger/runway.md.
  'finance.runway',
  // SP5: the compliance office's review of an outbound call (the security office's gate already exists and
  // serves both purposes), and the pantry chat, which is a conversation rather than work.
  'office:compliance.review', 'pantry.chat',
] as const;

/**
 * Change risk, classified by the author (owner's operating model §27). Low is guardrails only; medium adds a
 * security review; high adds a threat model the owner approves. The higher the risk, the stronger the human
 * governance — a copy tweak must not carry the process a destructive migration needs.
 */
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export const RiskLevel = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof RiskLevel>;

/** The examples from §27, worded for an agent choosing a level. Reused in tool descriptions and refusals. */
export const RISK_GUIDANCE: Record<RiskLevel, string> = {
  low: 'text changes, UI adjustments, minor bug fixes — automated guardrails only',
  medium: 'database changes, significant backend changes, new external integrations — adds a security review gate',
  high: 'authentication architecture, money, destructive migrations, core infrastructure — adds a threat model the owner approves',
};

/** Job types that change the product and must therefore state a risk class before the scheduler accepts them. */
export const ENGINEERING_JOB_TYPES = ['engineer.ship'] as const;

/**
 * A note timestamp. An owner who copies `Jobs/_template.md` verbatim leaves `created`/`updated` blank,
 * so blank (or missing) reads as "now" rather than failing the whole note's validation.
 */
export const Timestamp = z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' ? v : nowIso()), z.string());

export const ModelTier = z.enum(['strong', 'medium', 'cheap', 'local']);
export type ModelTier = z.infer<typeof ModelTier>;

export const BlockedOn = z.object({
  kind: z.enum(['message', 'job', 'proposal', 'quota', 'owner']),
  id: z.string(),
  since: z.string(),
  retries: z.number().int().optional(),
});

export const JobFrontmatter = z.looseObject({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  assigned: z.string(),
  status: JobStatus.default('queued'),
  priority: z.number().int().min(1).max(5).default(3),
  created: Timestamp,
  updated: Timestamp,
  attempt: z.number().int().min(1).default(1),
  max_attempts: z.number().int().min(1).default(3),
  depends_on: z.array(z.string()).default([]),
  approval: z.enum(['none', 'pending', 'approved', 'rejected']).default('none'),
  checkpoint_step: z.number().int().min(0).default(0),
  side_effects_done: z.array(z.string()).default([]),
  links: z.array(z.string()).default([]),
  privacy: z.enum(['cloud', 'local']).default('cloud'),
  runs_on: z.enum(['laptop', 'any']).default('laptop'),
  blocked_on: BlockedOn.optional(),
  parent: z.string().optional(),
  team: z.string().optional(),
  owner_role: z.string().optional(),
  for: z.string().optional(),
  done_when: z.string().optional(),
  risk: RiskLevel.default('low'),
  stream: z.string().optional(),
  returns: z.record(z.string(), z.number().int()).default({}),
  gate_index: z.number().int().optional(),
  budget_from: z.number().int().optional(),
  research: ResearchRequest.optional(),
  research_slug: z.string().optional(),
  model_tier: ModelTier.optional(),
  /**
   * SP5. On a trust review job: the idempotency key of the outbound call it gates, and the `00 Inbox/` proposal
   * that holds it. The pair is how `finishWith` turns the reviewer's verdict into the record — the review gates a
   * *call*, not a job's gate chain, so it has no `parent` and `applyVerdict` never sees it.
   */
  trust_key: z.string().optional(),
  trust_proposal: z.string().optional(),
  /** On a `pantry.chat` job: the other person at the counter. */
  pantry_with: z.string().optional(),
});
export type JobFrontmatter = z.infer<typeof JobFrontmatter>;

// ---------- Roles ----------
export const ApprovalMode = z.enum(['auto', 'propose', 'ask', 'never']);
export type ApprovalMode = z.infer<typeof ApprovalMode>;

export const PERMISSIONS = ['schedule', 'plan', 'review', 'hire', 'fire', 'veto', 'research_request', 'reprioritize', 'meeting'] as const;
export const Permission = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof Permission>;

// ---------- Offices ----------
/**
 * The company addressed by function, not by name. The daemon, the gates and the escalation chain say "the
 * operations office", and `Memory/constitution.md` decides which role id that is, so renaming or re-staffing a
 * seat is an owner edit instead of a code change.
 */
export const OFFICES = ['chief_executive', 'finance', 'operations', 'security', 'compliance', 'people', 'research', 'engineering'] as const;
export type Office = (typeof OFFICES)[number];
export const DEFAULT_OFFICES: Record<Office, string> = {
  chief_executive: 'ceo', finance: 'cfo', operations: 'coo', security: 'ciso',
  compliance: 'clo', people: 'chro', research: 'research_manager', engineering: 'cto',
};

export const RoleFrontmatter = z.looseObject({
  role: z.string(),
  display: z.string(),
  model_tier: ModelTier.default('medium'),
  tools: z.array(z.string()).default([]),
  approval_overrides: z.record(z.string(), ApprovalMode).default({}),
  active: z.boolean().default(true),
  hired: z.string(),
  sprite: z.string(),
  desk: z.string(),
  team: z.string().optional(),
  reports_to: z.string().optional(),
  title: z.string().optional(),
  persona: z.string().optional(),
  permissions: z.array(Permission).default([]),
});
export type RoleFrontmatter = z.infer<typeof RoleFrontmatter>;

// ---------- Teams ----------
/**
 * Work-in-progress limits per lane (owner's operating model §7: "In Progress: maximum 3 items / Review: maximum 2 /
 * Testing: maximum 2"). The point is not to keep everyone busy, it is to keep valuable work flowing, so the
 * dispatcher refuses to *start* new work past the limit rather than reassigning it.
 */
export const WipLimits = z.object({
  in_progress: z.number().int().min(1).default(3),
  review: z.number().int().min(1).default(2),
  testing: z.number().int().min(1).default(2),
});
export type WipLimits = z.infer<typeof WipLimits>;

export const TeamFrontmatter = z.looseObject({
  id: z.string(),
  name: z.string(),
  lead: z.string(),
  members: z.array(z.string()).default([]),
  mission: z.string().default(''),
  room: z.string().optional(),
  floor: z.number().int().optional(),
  parent: z.string().optional(),       // the division this team belongs to (dev → technology); planning happens at the division
  processes: z.array(z.string()).default([]),
  // No default: a team's note that never sets `wip:` is not opting into Kanban limits at all — the dispatcher
  // (nextJob, workers.ts) and the WS snapshot (ws.ts) both treat a `wip` of `undefined` as unlimited, never
  // refused. Only Dev and QA ship with an explicit `wip:` today.
  wip: WipLimits.optional(),
});
export type TeamFrontmatter = z.infer<typeof TeamFrontmatter>;

// ---------- Ideas ----------
// The idea card moved to `ideas.ts` when it became a dossier (SP3): the scoring rule, the card on disk and the
// schema belong together, and `ideas.ts` imports `Timestamp` from here, so this file must not import it back.

// ---------- Decisions ----------
export const DecisionFrontmatter = z.looseObject({
  id: z.string(),
  decided_by: z.string(),
  cycle: z.string(),
  status: z.enum(['proposed', 'adopted', 'reverted']).default('proposed'),
  inputs: z.array(z.string()).default([]),
  owner_rating: z.enum(['up', 'down']).nullable().optional(),
  rating_seen: z.string().optional(),   // when the owner's thumbs-down reached its author
  review_date: z.string().optional(),   // mirrors the `## Review date` section
});
export type DecisionFrontmatter = z.infer<typeof DecisionFrontmatter>;

// ---------- Inbox notes: proposals and messages ----------
export const ProposalKind = z.enum([
  'message', 'hire', 'fire', 'brand_change', 'charter_change', 'file_change', 'spend', 'outbound_batch', 'reorg', 'threat_model', 'plan_verdict',
  // SP3: the founder brief the owner adopts, and the owner's ruling on one idea card.
  'founder_brief', 'idea_verdict',
]);
export type ProposalKind = z.infer<typeof ProposalKind>;

export const StoredCall = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  idempotency_key: z.string(),
  job: z.string().optional(),
  role: z.string().optional(),
});
export type StoredCall = z.infer<typeof StoredCall>;

// The owner edits 00 Inbox/ by hand or in Obsidian, whose property editor stores a text property as `approved: "true"`.
// A quoted true/false/yes/no (any case) means what it says and a quoted number is a number; anything else stays
// invalid, so a typo like `approved: maybe` is reported (listInbox warns) rather than silently read as a decision.
const ownerFlag = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === 'yes') return true;
  if (s === 'false' || s === 'no') return false;
  if (s === '' || s === 'null' || s === '~') return null;
  return v;
}, z.boolean().nullable()).default(null);
const ownerInt = z.preprocess((v) => (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v), z.number().int().nullable()).default(null);

export const InboxFrontmatter = z.looseObject({
  id: z.string(),
  kind: ProposalKind,
  created: z.string(),
  from: z.string(),
  to: z.string().default('owner'),
  approved: ownerFlag,
  resolved_at: z.string().nullable().default(null),
  answered: ownerFlag,
  chosen: ownerInt,
  call: StoredCall.optional(),
  target: z.string().optional(),   // file path for brand_change / charter_change / file_change
  job: z.string().optional(),      // originating job id
});
export type InboxFrontmatter = z.infer<typeof InboxFrontmatter>;

// ---------- Constitution ----------
export const Constitution = z.object({
  max_emails_per_day: z.number().int().min(0).default(20),
  banned_channels: z.array(z.string()).default([]),
  banned_tactics: z.array(z.string()).default([]),
  max_roles: z.number().int().min(1).default(8),
  auto_approve_hire: z.boolean().default(false),
  auto_approve_charter_changes: z.boolean().default(false),
  pii_local_only: z.boolean().default(false),
  never_modify: z.array(z.string()).default([]),
  max_team_size: z.number().int().min(1).default(6),
  auto_approve_reorg: z.boolean().default(false),
  offices: z.record(z.string(), z.string()).default({ ...DEFAULT_OFFICES }),
  /**
   * Hours a plan waits for the owner's verdict before the board's own verdict stands. 0 (the default, and what an
   * absent key means) switches that off entirely: the plan waits for the owner for as long as it takes. The board
   * advises; only the owner rules, unless the owner says otherwise.
   */
  board_decides_after_hours: z.number().min(0).default(0),
  /**
   * How the board holds a pressure test (SP8 §3). `full` is the dialogue the owner reads: the chair states each
   * of the five questions in its own words, the other two advisors answer it in turn, and the chair rules on
   * each round in the open — six rounds, one transcript note, at most 17 model calls. `brief` is the four-call
   * session the board ran before SP8: three pre-mortems and one merge, with nothing to read but the merge.
   *
   * It is a switch and not a tier: a vault that cannot spend 17 calls on one idea sets `brief` and loses the
   * argument, not the verdict — both paths end on the same `readPressureVerdict` parse.
   */
  board_dialogue: z.enum(['full', 'brief']).default('full'),
  /**
   * One-time migrations this vault has already had applied, by id. A step that *lowers* a value the owner may
   * legitimately raise again cannot be gated on the value itself — it would silently undo the owner on every
   * daemon start — so it is gated on its id appearing here (review I3). Steps that are self-extinguishing (a
   * rename, a file that now exists) need no marker and have none.
   */
  migrations: z.array(z.string()).default([]),
});
export type Constitution = z.infer<typeof Constitution>;

// ---------- Owner preferences ----------
export const OwnerPreferences = z.object({
  approvals: z.record(z.string(), ApprovalMode).default({}),
  feedback: z.array(z.string()).default([]),
  /** Allow a bubblewrap-jailed local shell when Docker is unavailable (default: refuse). */
  shell_local_fallback: z.boolean().default(false),
});
export type OwnerPreferences = z.infer<typeof OwnerPreferences>;

// ---------- Events ----------
export const EVENT_TYPES = [
  'daemon.started', 'daemon.stopping', 'daemon.warning',
  'heartbeat.started', 'heartbeat.completed',
  'job.queued', 'job.started', 'job.checkpoint', 'job.blocked', 'job.done', 'job.failed', 'job.interrupted', 'job.cancelled',
  'agent.thinking', 'agent.tool_call', 'agent.tool_result', 'agent.spoke',
  'meeting.opened', 'meeting.turn', 'meeting.closed',
  'browser.session_started', 'browser.frame', 'browser.session_ended',
  'shell.output',
  'ci.completed',
  'email.sent', 'email.received',
  'deploy.done',
  'incident.opened', 'incident.recovered',
  'proposal.created', 'proposal.resolved',
  'role.hired', 'role.fired',
  'router.call', 'router.downgraded',
  'quota.updated',
  'vault.wrote', 'owner.edited', 'owner.feedback_delivered',
  'team.planned', 'review.passed', 'review.returned', 'plan.vetoed', 'research.delivered', 'org.changed',
  'guardrail.blocked', 'guardrail.checking', 'guardrail.checked', 'guardrail.deferred',
] as const;
export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

export const CubicleEvent = z.object({
  id: z.number().int().optional(),
  ts: z.string(),
  type: EventType,
  agent: z.string().nullable().default(null),
  job: z.string().nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type CubicleEvent = z.infer<typeof CubicleEvent>;
export type NewEvent = { type: EventType; agent?: string | null; job?: string | null; payload?: Record<string, unknown>; ts?: string };

// ---------- Finish contract ----------
export const JobResult = z.object({
  status: z.enum(['done', 'failed', 'blocked']),
  artifacts: z.array(z.string()).default([]),
  metrics: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
  blockers: z.array(z.string()).default([]),
  lessons: z.array(z.string()).default([]),
  summary: z.string().default(''),
  verdict: z.enum(['pass', 'return']).optional(),
  findings: z.array(z.string()).default([]),
  /** Set true when the change added a dependency, a service, a data store, or a changed boundary (toolchain
   * §8). An `engineer.ship` that sets this is refused until an ADR exists in Docs/adr/ dated on or after the
   * job's creation — the team:qa.review gate also checks for one, but a ship must not need a human to catch a
   * missing decision record before it can even finish. */
  architecture_change: z.boolean().optional(),
});
export type JobResult = z.infer<typeof JobResult>;
