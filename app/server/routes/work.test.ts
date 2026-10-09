import { mkdtemp } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createDecisions } from '../decisions.ts';
import { reaskLine, saidNoFor } from '../partner/saidno.ts';
import { workRoutes } from './work.ts';

const request = (method: string, data?: unknown) => Object.assign(Readable.from(data === undefined ? [] : [JSON.stringify(data)]), { method }) as unknown as IncomingMessage;
const response = () => ({ writeHead() { return this; }, setHeader() {}, end() {} }) as unknown as ServerResponse;

// Journey 17: Decline with Why "no discounts: we never cut the price to win nurses back" kept the no with no reason,
// and the re-ask had nothing to quote.
describe('a proposed decision declined', () => {
  async function setup() {
    const workspace = await mkdtemp(join(tmpdir(), 'work-route-'));
    const decisions = createDecisions(workspace);
    const route = workRoutes({ workspace, decisions } as unknown as Parameters<typeof workRoutes>[0]);
    const made = await decisions.propose({ title: 'Win lapsed nurses back with 20% off', context: 'Paying is down.', options: ['Discount', 'Keep the price'], proposedBy: 'Sam', recommendation: 'Discount' });
    return { workspace, decisions, route, made };
  }

  it('keeps its Why as the reason, and the re-ask quotes it', async () => {
    const { workspace, decisions, route, made } = await setup();
    const why = 'no discounts: we never cut the price to win nurses back';
    await route(request('DELETE', { why }), response(), `/api/decisions/${made.id}`, new URL('http://x/'));
    expect(await decisions.list()).toEqual([]);
    const [kept] = await saidNoFor(workspace).list();
    expect(kept).toMatchObject({ tool: 'propose_decision', subject: made.title, reason: why, who: 'Sam' });
    expect(reaskLine(kept)).toContain(`'${why}'`);
  });

  it('keeps the no without a reason when no Why was given', async () => {
    const { workspace, route, made } = await setup();
    await route(request('DELETE'), response(), `/api/decisions/${made.id}`, new URL('http://x/'));
    const [kept] = await saidNoFor(workspace).list();
    expect(kept.subject).toBe(made.title);
    expect(kept.reason).toBeUndefined();
  });
});
