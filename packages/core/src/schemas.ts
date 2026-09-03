import { z } from 'zod';
import { nowIso } from './fs.js';

// ---------- Jobs ----------
export const JobStatus = z.enum(['queued', 'running', 'blocked', 'in_review', 'done', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;

export const KNOWN_JOB_TYPES = [
  'engineer.ship', 'growth.outreach', 'growth.post', 'growth.seo', 'coo.verify',
  'cto.plan', 'cto.compress_charters', 'ceo.heartbeat', 'research', 'custom',
  'team.plan', 'critic.premortem', 'qa.review', 'company.plan', 'colleague.answer',
] as const;

/**
 * A note timestamp. An owner who copies `Jobs/_template.md` verbatim leaves `created`/`updated` blank,
 * so blank (or missing) reads as "now" rather than failing the whole note's validation.
 */
export const Timestamp = z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' ? v : nowIso()), z.string());

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
  returns: z.record(z.string(), z.number().int()).default({}),
  gate_index: z.number().int().optional(),
  budget_from: z.number().int().optional(),
});
export type JobFrontmatter = z.infer<typeof JobFrontmatter>;

// ---------- Roles ----------
export const ModelTier = z.enum(['strong', 'medium', 'cheap', 'local']);
export type ModelTier = z.infer<typeof ModelTier>;

export const ApprovalMode = z.enum(['auto', 'propose', 'ask', 'never']);
export type ApprovalMode = z.infer<typeof ApprovalMode>;

export const PERMISSIONS = ['schedule', 'plan', 'review', 'hire', 'fire', 'veto', 'research_request', 'reprioritize', 'meeting'] as const;
export const Permission = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof Permission>;

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
export const TeamFrontmatter = z.looseObject({
  id: z.string(),
  name: z.string(),
  lead: z.string(),
  members: z.array(z.string()).default([]),
  mission: z.string().default(''),
  room: z.string().optional(),
  processes: z.array(z.string()).default([]),
});
export type TeamFrontmatter = z.infer<typeof TeamFrontmatter>;

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
  'message', 'hire', 'fire', 'brand_change', 'charter_change', 'file_change', 'spend', 'outbound_batch', 'reorg',
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

export const InboxFrontmatter = z.looseObject({
  id: z.string(),
  kind: ProposalKind,
  created: z.string(),
  from: z.string(),
  to: z.string().default('owner'),
  approved: z.boolean().nullable().default(null),
  resolved_at: z.string().nullable().default(null),
  answered: z.boolean().nullable().default(null),
  chosen: z.number().int().nullable().default(null),
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
  'email.sent', 'email.received',
  'deploy.done',
  'proposal.created', 'proposal.resolved',
  'role.hired', 'role.fired',
  'router.call', 'router.downgraded',
  'quota.updated',
  'vault.wrote', 'owner.edited',
  'team.planned', 'review.passed', 'review.returned', 'plan.vetoed', 'research.delivered', 'org.changed',
  'guardrail.blocked',
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
});
export type JobResult = z.infer<typeof JobResult>;
