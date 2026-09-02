import { z } from 'zod';
import { defineTool } from '../registry.js';
import { KNOWN_JOB_TYPES, isValidRoleId, idFromKey } from '@cubicle/core';

const SYSTEM_TYPES: Record<string, string[]> = { 'ceo.heartbeat': [], 'cto.plan': ['ceo'], 'coo.verify': ['ceo', 'coo'], 'cto.compress_charters': ['ceo', 'cto'] };

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
  },
  async handler(args, ctx) {
    if (args.reprioritize) {
      if (!['ceo', 'cto'].includes(ctx.roleId)) return { ok: false, text: 'only the CEO or CTO may reprioritize jobs' };
      ctx.scheduler.reprioritize?.(args.reprioritize.job, args.reprioritize.priority);
      return { ok: true, text: `job ${args.reprioritize.job} priority set to ${args.reprioritize.priority}` };
    }
    if (!isValidRoleId(args.assigned)) return { ok: false, text: `invalid role id: ${JSON.stringify(args.assigned)}` };
    if (!ctx.vault.exists(`Roles/${args.assigned}.md`)) return { ok: false, text: `unknown role: ${args.assigned}` };
    const allowed = SYSTEM_TYPES[args.type];
    if (allowed && !allowed.includes(ctx.roleId)) return { ok: false, text: `job type ${args.type} is reserved for the daemon${allowed.length ? ` / ${allowed.join(', ')}` : ''}` };
    const id = ctx.scheduler.enqueue({ id: ctx.idempotencyKey ? idFromKey('job', ctx.idempotencyKey) : undefined, type: args.type, title: args.title, assigned: args.assigned, goal: args.goal, priority: args.priority, depends_on: args.depends_on, privacy: args.privacy, parent: ctx.jobId ?? undefined, links: ctx.jobId ? [`[[${ctx.jobId}]]`] : [] });
    return { ok: true, text: `queued ${id} for ${args.assigned}: ${args.title}`, data: { id } };
  },
});
