import { z } from 'zod';
import { defineTool } from '../registry.js';
import { KNOWN_JOB_TYPES, isValidRoleId, idFromKey, loadOrg, can, isLead, teamOf, leadOf, readJob } from '@cubicle/core';

const SYSTEM_TYPES: Record<string, string[]> = { 'ceo.heartbeat': [], 'cto.plan': ['ceo'], 'company.plan': [], 'team.plan': ['ceo'], 'critic.premortem': ['ceo'], 'coo.verify': ['ceo', 'coo'], 'qa.review': ['ceo', 'cto'], 'cto.compress_charters': ['ceo', 'cto'] };

export const schedulerRequest = defineTool({
  name: 'scheduler.request',
  description: `Enqueue a job for a role. Types: ${KNOWN_JOB_TYPES.join(', ')} (or custom). CEO/CTO may also set priority on existing jobs via reprioritize.`,
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
    if (!org.roles[args.assigned]) return { ok: false, text: `unknown or inactive role: ${args.assigned}` };
    const type = args.type ?? 'custom';
    const isResearch = type === 'research';
    if (isResearch) {
      if (args.assigned !== 'research_analyst') return { ok: false, text: 'research jobs are done by research_analyst (set assigned: research_analyst and for: <your role>)' };
      if (!can(org, ctx.roleId, 'research_request')) return { ok: false, text: `${ctx.roleId} may not request research; ask your lead` };
    } else if (!can(org, ctx.roleId, 'schedule', args.assigned)) {
      return { ok: false, text: `${ctx.roleId} may not schedule ${args.assigned}: leads schedule their own team, members hand off to a teammate, the CEO anyone` };
    }
    const allowed = SYSTEM_TYPES[type];
    if (allowed && !allowed.includes(ctx.roleId)) return { ok: false, text: `job type ${type} is reserved for the daemon${allowed.length ? ` / ${allowed.join(', ')}` : ''}` };
    const lead = ctx.roleId === 'ceo' || isLead(org, ctx.roleId);
    if (lead && !args.done_when?.trim()) return { ok: false, text: 'leads must give done_when: one sentence a stranger could check' };
    const owner_role = lead ? ctx.roleId : (leadOf(org, ctx.roleId) ?? ctx.roleId);
    const team = teamOf(org, args.assigned)?.id;
    const id = ctx.scheduler.enqueue({ id: ctx.idempotencyKey ? idFromKey('job', ctx.idempotencyKey) : undefined, type, title: args.title, assigned: args.assigned, goal: args.goal, priority: args.priority, depends_on: args.depends_on, privacy: args.privacy, parent: ctx.jobId ?? undefined, links: ctx.jobId ? [`[[${ctx.jobId}]]`] : [], team, owner_role, for: isResearch ? (args.for ?? ctx.roleId) : undefined, done_when: args.done_when });
    return { ok: true, text: `queued ${id} for ${args.assigned}: ${args.title}`, data: { id } };
  },
});
