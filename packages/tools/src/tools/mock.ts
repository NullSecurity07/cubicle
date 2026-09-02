import { z } from 'zod';
import { defineTool } from '../registry.js';

/** Test-only outbound tool: records every executed idempotency key to `.cubicle/mock-outbound.jsonl`. */
export const mockOutbound = defineTool({
  name: 'mock.outbound',
  description: 'TEST ONLY: pretend to send something externally. Records the idempotency key.',
  schema: { to: z.string(), body: z.string() },
  async handler({ to, body }, ctx) {
    const key = ctx.idempotencyKey ?? 'no-key';
    const rel = '.cubicle/mock-outbound.jsonl';
    const abs = ctx.vault.abs(rel);
    const { appendFileSync } = await import('node:fs');
    appendFileSync(abs, JSON.stringify({ ts: ctx.now().toISOString(), key, to, body, job: ctx.jobId }) + '\n');
    ctx.events.emit({ type: 'email.sent', agent: ctx.roleId, job: ctx.jobId, payload: { mock: true, to, key } });
    return { ok: true, text: `mock sent to ${to} (key ${key})`, sideEffectKey: key };
  },
});
