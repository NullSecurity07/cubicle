import { z } from 'zod';
import { defineTool } from '../registry.js';
import { KNOWN_JOB_TYPES, isValidRoleId, idFromKey, loadOrg, can, isLead, teamOf, leadOf, readJob, listJobs, researchLead, ENGINEERING_JOB_TYPES, RISK_GUIDANCE, RISK_LEVELS, missingRequestFields, incompleteRequestText, ResearchRequest, priorityScore, jobPriorityFor, type Org } from '@cubicle/core';

const SYSTEM_TYPES: Record<string, string[]> = { 'ceo.heartbeat': [], 'cto.plan': ['ceo'], 'company.plan': [], 'team.plan': ['ceo'], 'critic.premortem': ['ceo'], 'coo.verify': ['ceo', 'coo'], 'qa.review': ['ceo', 'cto'], 'cto.compress_charters': ['ceo', 'cto'], 'security.review': ['ceo', 'cto', 'ciso'], 'research.review': ['ceo', 'coo'] };

/**
 * A refusal the model can act on. The old one-liner ("leads schedule their own team…") left a lead whose team has no
 * members, or a CTO handed growth work, retrying with other names and then giving up as "blocked on the owner".
 * Name who this role may schedule, or say plainly that there is nobody, and what to do instead.
 */
export function cannotScheduleText(org: Org, roleId: string, assigned: string): string {
  const allowed = [...new Set([...(teamOf(org, roleId)?.members ?? []), ...Object.keys(org.roles)])].filter((r) => can(org, roleId, 'schedule', r)); // own team first, in charter order
  const self = assigned === roleId ? ' Nobody schedules themselves: do the work in this job.' : '';
  const research = researchLead(org) ?? 'research_manager';   // the research team's lead, not the v1 analyst id
  const fallback = `Otherwise do the work in this job yourself, request research (type: research, assigned: ${research}), or tell your lead (the ceo, for a lead) with colleague.message.`;
  if (allowed.length) return `${roleId} may not schedule ${assigned}.${self} You may schedule: ${allowed.join(', ')} (leads schedule their own team's members, members hand off to a teammate, the CEO anyone). ${fallback}`;
  const team = isLead(org, roleId) ? teamOf(org, roleId) : null;
  const why = team ? `${roleId} leads ${team.id}, and ${team.id} has no members, so there is nobody to schedule.` : `${roleId} may not schedule ${assigned}, and has no teammate to hand off to.`;
  return `${why}${self} Do the work in this job yourself, request research (type: research, assigned: ${research}), or ask the ceo with colleague.message.`;
}

/**
 * Why a role id was not accepted. `growth` stopped being a role and became a team when the lead was renamed
 * head_of_growth, and models kept writing `assigned: "growth"` (13 failures in one live run). Say it is a team
 * and who is on it, but do not pick the lead for the caller: whether the work is the lead's or a member's is theirs
 * to decide. Unknown ids get the active roster so the next attempt can be right.
 */
export function unknownRoleText(org: Org, id: string, what = 'unknown or inactive role'): string {
  const team = org.teams[id];
  if (team) return `${id} is a team, not a role. Its lead is ${team.lead}; members: ${team.members.length ? team.members.join(', ') : '(none)'}. Use a role id.`;
  return `${what}: ${id} (active roles: ${Object.keys(org.roles).join(', ')})`;
}

const OPEN_STATUSES = ['queued', 'running', 'blocked', 'in_review'] as const;
const normTitle = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The refusal a model gets when it schedules product work without saying how risky it is (owner's operating
 * model §27). Naming the three levels with their examples is the whole point: a bare "risk is required" sent
 * models round the loop guessing at the field's shape.
 */
export function missingRiskText(type: string): string {
  return `${type} jobs must state a risk class. Set risk to one of: ${RISK_LEVELS.map((l) => `${l} (${RISK_GUIDANCE[l]})`).join('; ')}. Pick the highest level any part of the change touches.`;
}

export const schedulerRequest = defineTool({
  name: 'scheduler.request',
  description: `Enqueue a job for a role. Leads schedule their own team's members, members hand off to a teammate, the CEO anyone; nobody schedules themselves — do your own work in this job. Types: ${KNOWN_JOB_TYPES.join(', ')} (or custom). A type: research job must carry the full \`research\` request (decision, decision owner, question, hypothesis or exploration, known evidence, unknowns, deadline, required confidence, potential decisions, portfolio, impact, uncertainty, cost of being wrong) — its priority comes from impact × uncertainty × cost of being wrong, not from \`priority\`. CEO/CTO may also set priority on existing jobs via reprioritize. Engineering types (${ENGINEERING_JOB_TYPES.join(', ')}) must also state risk: low (text, UI, minor fixes), medium (data, backend, new integrations), high (auth, money, destructive migrations, infrastructure).`,
  schema: {
    type: z.string().default('custom'),
    title: z.string(),
    assigned: z.string().describe('role id'),
    goal: z.string().describe('what done looks like'),
    priority: z.number().int().min(1).max(5).default(3),
    depends_on: z.array(z.string()).default([]),
    privacy: z.enum(['cloud', 'local']).optional(),
    reprioritize: z.object({ job: z.string(), priority: z.number().int().min(1).max(5) }).optional(),
    for: z.string().optional().describe('research: the lead the report is for'),
    done_when: z.string().optional().describe('one testable sentence; required for leads'),
    risk: z.enum(RISK_LEVELS).optional().describe(`how risky the change is — ${RISK_LEVELS.map((l) => `${l}: ${RISK_GUIDANCE[l]}`).join(' | ')}`),
    stream: z.string().optional().describe('the Streams/<slug> this job serves'),
    research: z.object({
      decision: z.string().optional(),
      decision_owner: z.string().optional().describe('role id; defaults to `for`'),
      question: z.string().optional(),
      hypothesis: z.string().optional(),
      exploration: z.string().optional().describe('use instead of hypothesis when you do not yet know what is happening'),
      known_evidence: z.string().optional(),
      unknowns: z.string().optional(),
      constraints: z.string().optional(),
      deadline: z.string().optional().describe('YYYY-MM-DD'),
      required_confidence: z.enum(['high', 'medium', 'low']).optional(),
      potential_decisions: z.array(z.string()).optional().describe('at least two'),
      portfolio: z.enum(['incremental', 'adjacent', 'exploratory']).optional(),
      impact: z.number().int().min(1).max(5).optional(),
      uncertainty: z.number().int().min(1).max(5).optional(),
      cost_of_being_wrong: z.number().int().min(1).max(5).optional(),
    }).optional().describe('required for type: research — the universal research request. Every field must be filled or the job is refused.'),
  },
  async handler(args, ctx) {
    const org = loadOrg(ctx.vault);
    if (args.reprioritize) {
      const target = readJob(ctx.vault, args.reprioritize.job)?.data;
      if (!target) return { ok: false, text: `unknown job ${args.reprioritize.job}` };
      if (!can(org, ctx.roleId, 'reprioritize', target.team ?? teamOf(org, target.assigned)?.id)) return { ok: false, text: `${ctx.roleId} may not reprioritize jobs outside its team` };
      ctx.scheduler.reprioritize?.(args.reprioritize.job, args.reprioritize.priority);
      return { ok: true, text: `job ${args.reprioritize.job} priority set to ${args.reprioritize.priority}` };
    }
    if (!isValidRoleId(args.assigned)) return { ok: false, text: `invalid role id: ${JSON.stringify(args.assigned)}` };
    if (!org.roles[args.assigned]) return { ok: false, text: unknownRoleText(org, args.assigned) };
    const type = args.type ?? 'custom';
    const isResearch = type === 'research';
    let forRole: string | undefined;
    let request: ResearchRequest | undefined;
    if (isResearch) {
      const lead = researchLead(org) ?? 'research_analyst';
      if (args.assigned !== lead) return { ok: false, text: `research jobs are done by ${lead} (set assigned: ${lead} and for: <your role>)` };
      if (!can(org, ctx.roleId, 'research_request')) return { ok: false, text: `${ctx.roleId} may not request research; ask your lead` };
      forRole = args.for ?? ctx.roleId;
      if (!org.roles[forRole]) return { ok: false, text: 'for must be an active role id' };
      // §33: the request is the contract between the requester and Research. Refuse an incomplete one by name
      // rather than queueing work nobody can scope — a job with no decision behind it is the failure the
      // research_manager's charter is told to refuse, and it is cheaper to refuse it here.
      const draft = { ...(args.research ?? {}) } as Record<string, unknown>;
      if (typeof draft.decision_owner !== 'string' || !draft.decision_owner.trim()) draft.decision_owner = forRole;
      const missing = missingRequestFields(draft);
      if (missing.length) return { ok: false, text: incompleteRequestText(missing) };
      request = ResearchRequest.parse(draft);
    } else if (!can(org, ctx.roleId, 'schedule', args.assigned)) {
      return { ok: false, text: cannotScheduleText(org, ctx.roleId, args.assigned) };
    }
    const allowed = SYSTEM_TYPES[type];
    if (allowed && !allowed.includes(ctx.roleId)) return { ok: false, text: `job type ${type} is reserved for the daemon${allowed.length ? ` / ${allowed.join(', ')}` : ''}` };
    const lead = ctx.roleId === 'ceo' || isLead(org, ctx.roleId);
    if (lead && !args.done_when?.trim()) return { ok: false, text: 'leads must give done_when: one sentence a stranger could check' };
    if ((ENGINEERING_JOB_TYPES as readonly string[]).includes(type) && !args.risk) return { ok: false, text: missingRiskText(type) };
    const owner_role = lead ? ctx.roleId : (leadOf(org, ctx.roleId) ?? ctx.roleId);
    const team = teamOf(org, args.assigned)?.id;
    const wantedId = ctx.idempotencyKey ? idFromKey('job', ctx.idempotencyKey) : undefined;
    // Agents re-queue the same work (two open "Plan Growth", two "Define Target Segments" 15 s apart in one live
    // run). Same assignee + same title while the first is still open is a duplicate, not new work. System types are
    // exempt because the daemon schedules e.g. team.plan every cycle; a replayed step keeps its own job.
    if (!allowed) {
      const title = normTitle(args.title);
      const dup = listJobs(ctx.vault, { status: [...OPEN_STATUSES], assigned: args.assigned }).find((j) => j.id !== wantedId && normTitle(j.title) === title);
      if (dup) return { ok: false, text: `a job with this title is already open for ${args.assigned}: ${dup.id} (${dup.status}). Wait for it, or give the new job a different title if it really is different work` };
    }
    // §29: a research job's place in the queue is its score, not whatever number the requester typed. The
    // project slug is left unset here — `research.start` derives it from the real job id and stores it.
    const priority = request ? jobPriorityFor(priorityScore(request)) : args.priority;
    const id = ctx.scheduler.enqueue({ id: wantedId, type, title: args.title, assigned: args.assigned, goal: args.goal, priority, depends_on: args.depends_on, privacy: args.privacy, parent: ctx.jobId ?? undefined, links: ctx.jobId ? [`[[${ctx.jobId}]]`] : [], team, owner_role, for: forRole, done_when: args.done_when, risk: args.risk, stream: args.stream, research: request });
    return { ok: true, text: `queued ${id} for ${args.assigned}: ${args.title}${request ? ` (priority ${priority} from a score of ${priorityScore(request)})` : ''}`, data: { id } };
  },
});
