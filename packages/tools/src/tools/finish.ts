import { z } from 'zod';
import { defineTool } from '../registry.js';

export const finish = defineTool({
  name: 'finish',
  description: 'End the job with a structured result. Call this exactly once when the goal is met, blocked, or impossible.',
  schema: {
    status: z.enum(['done', 'failed', 'blocked']),
    summary: z.string().describe('one paragraph for the COO and the owner'),
    artifacts: z.array(z.string()).default([]).describe('vault paths or URLs produced'),
    metrics: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
    blockers: z.array(z.string()).default([]),
    lessons: z.array(z.string()).default([]),
  },
  async handler(args) {
    return { ok: true, text: `finished: ${args.status}`, data: args, finished: true };
  },
});
