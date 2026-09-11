import { z } from 'zod';
import { defineTool } from '../registry.js';

export const finish = defineTool({
  name: 'finish',
  description: 'End the job with a structured result. Call this exactly once when the goal is met, blocked, or impossible.',
  schema: {
    status: z.enum(['done', 'failed', 'blocked', 'pass', 'return']).describe('done | failed | blocked; review gates may say pass or return instead of done + verdict'),
    summary: z.string().describe('one paragraph for the COO and the owner'),
    artifacts: z.array(z.string()).default([]).describe('vault paths or URLs produced'),
    metrics: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
    blockers: z.array(z.string()).default([]),
    lessons: z.array(z.string()).default([]),
    verdict: z.enum(['pass', 'return']).optional().describe('review gates only'),
    findings: z.array(z.string()).default([]),
    architecture_change: z.boolean().optional().describe('set true when this change added a dependency, a service, a data store, or a changed boundary (toolchain §8) — an engineer.ship that sets this needs an ADR in Docs/adr/ before it can finish'),
  },
  async handler(args) {
    // Gate reviewers kept calling finish({status: 'return'}) (20 opaque "Invalid option" rejections in one live run):
    // the verdict is what they mean, so accept it as an alias for done + verdict. An explicit verdict still wins.
    const aliased = args.status === 'pass' || args.status === 'return';
    const result = aliased ? { ...args, status: 'done' as const, verdict: args.verdict ?? args.status as 'pass' | 'return' } : args;
    return { ok: true, text: `finished: ${result.status}${result.verdict ? ` (verdict ${result.verdict})` : ''}`, data: result, finished: true };
  },
});
