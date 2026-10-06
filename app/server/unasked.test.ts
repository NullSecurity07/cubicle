import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelClient } from './providers.ts';
import { route } from './router.ts';
import { partnerRoute, turnRoute } from './partner/route.ts';
import { createUnasked, createUsage, UNASKED_CAP } from './usage.ts';
import { unaskedRow } from './openends/health.ts';

const client = (name: string, extra: Partial<ModelClient> = {}): ModelClient => ({
  name, model: `${name}-1`, maxPromptChars: 100_000, tools: true, limits: { rpd: 100 }, step: async () => ({ text: '', calls: [] }), ...extra,
});
const flash = () => client('gemini-flash', { partnerOnly: true, limits: { rpd: 20 } });
// Local time, so midnight is the founder's midnight wherever the test runs.
const at = (hour: number, minute = 0, day = 6) => new Date(2026, 9, day, hour, minute).getTime();

describe('the budget for unasked work', () => {
  it('is twelve turns a day unless told otherwise, and says why the thirteenth waits', () => {
    const usage = createUsage(null, () => at(9));
    const unasked = createUnasked({ path: null, usage, clients: () => [client('alpha')], now: () => at(9) });
    expect(unasked.cap).toBe(UNASKED_CAP);
    expect(UNASKED_CAP).toBe(12);
    for (let one = 1; one <= 12; one += 1) {
      const took = unasked.take(`watch ${one}`);
      expect(took.ok).toBe(true);
      expect(took.left).toBe(12 - one);
    }
    const refused = unasked.take('watch 13');
    expect(refused).toMatchObject({ ok: false, left: 0, models: [] });
    expect(refused.why).toBe('budget used today: 12 of 12 unasked turns');
    expect(unasked.left()).toBe(0);
  });

  it('starts again at the founder\'s midnight, not before', () => {
    let now = at(23, 50);
    const usage = createUsage(null, () => now);
    const unasked = createUnasked({ path: null, usage, clients: () => [client('alpha')], cap: 2, now: () => now });
    unasked.take('review'); unasked.take('refresh');
    expect(unasked.take('watch').ok).toBe(false);
    now = at(23, 59);
    expect(unasked.left()).toBe(0);
    now = at(0, 1, 7);
    expect(unasked.left()).toBe(2);
    expect(unasked.used()).toEqual([]);
    expect(unasked.take('watch').ok).toBe(true);
  });

  it('keeps the day\'s count across a restart, and forgets yesterday\'s', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unasked-'));
    const path = join(dir, 'unasked.json');
    const usage = createUsage(null, () => at(10));
    const first = createUnasked({ path, usage, clients: () => [client('alpha')], now: () => at(10) });
    await first.load();
    first.take('watch: page changed'); first.take('review: market doc'); first.take('watch: page changed');
    await first.settled();
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ used: [{ reason: 'watch: page changed' }, { reason: 'review: market doc' }, { reason: 'watch: page changed' }] });

    const again = createUnasked({ path, usage, clients: () => [client('alpha')], now: () => at(15) });
    await again.load();
    expect(again.left()).toBe(9);
    expect(again.used().map((one) => one.reason)).toEqual(['watch: page changed', 'review: market doc', 'watch: page changed']);

    const tomorrow = createUnasked({ path, usage, clients: () => [client('alpha')], now: () => at(8, 0, 7) });
    await tomorrow.load();
    expect(tomorrow.left()).toBe(12);
  });

  it('never offers the partner\'s own model, nor one with under a quarter of its day left', () => {
    const usage = createUsage(null, () => at(9));
    for (let one = 0; one < 80; one += 1) usage.record('beta', { input: 1, output: 1 });
    const clients = [flash(), client('alpha'), client('beta'), client('side', { side: true })];
    const unasked = createUnasked({ path: null, usage, clients: () => clients, now: () => at(9) });
    const took = unasked.take('watch');
    expect(took.models).toEqual(['alpha']);

    // With only the partner's model and a nearly spent one left, it waits rather than spend either.
    const thin = createUnasked({ path: null, usage, clients: () => [flash(), client('beta')], now: () => at(9) });
    const refused = thin.take('watch');
    expect(refused.ok).toBe(false);
    expect(refused.why).toMatch(/quarter of its day/);
    expect(thin.used()).toEqual([]);
  });

  it('routes an unasked turn past Gemini Flash every way in, even on a turn that would be reserved', () => {
    const usage = createUsage(null, () => at(9));
    for (let one = 0; one < 80; one += 1) usage.record('beta', { input: 1, output: 1 });
    const clients = [flash(), client('alpha'), client('beta')];
    const want = { promptChars: 10, tools: true };
    expect(route(clients, usage, { ...want, partner: true, unasked: true }).order.map((one) => one.name)).toEqual(['alpha']);
    expect(partnerRoute(clients, usage, { ...want, reserved: true, unasked: true }).order.map((one) => one.name)).toEqual(['alpha']);
    // "What is your verdict" would be a reserved turn for the partner's own model; asked by nobody, it is not.
    const room = { id: 'partner-room', partner: true };
    expect(turnRoute(room, clients, usage, want, { query: 'what is your verdict on the company?', now: at(9) }).order[0].name).toBe('gemini-flash');
    expect(turnRoute(room, clients, usage, { ...want, unasked: true }, { query: 'what is your verdict on the company?', now: at(9) }).order.map((one) => one.name)).toEqual(['alpha']);
  });

  it('gives a turn back when it never ran, once', async () => {
    const usage = createUsage(null, () => at(9));
    const unasked = createUnasked({ path: null, usage, clients: () => [client('alpha')], cap: 2, now: () => at(9) });
    const first = unasked.take('watch');
    const second = unasked.take('review');
    expect(unasked.take('refresh').ok).toBe(false);
    first.release();
    first.release();
    expect(unasked.left()).toBe(1);
    expect(unasked.used().map((one) => one.reason)).toEqual(['review']);
    expect(unasked.take('refresh').ok).toBe(true);
    expect(unasked.left()).toBe(0);
    second.release();
    expect(unasked.used().map((one) => one.reason)).toEqual(['refresh']);
  });

  it('a release after midnight leaves the new day alone', () => {
    let now = at(23, 59);
    const usage = createUsage(null, () => now);
    const unasked = createUnasked({ path: null, usage, clients: () => [client('alpha')], cap: 2, now: () => now });
    const late = unasked.take('watch');
    now = at(0, 5, 7);
    unasked.take('morning');
    late.release();
    expect(unasked.used().map((one) => one.reason)).toEqual(['morning']);
  });
});

describe('the Health row for unasked work', () => {
  it('says how much of the day is used and on what, each reason once', () => {
    expect(unaskedRow({ cap: 12, used: [] })).toMatchObject({ name: 'Unasked work today', ok: true, detail: '0 of 12 used' });
    const row = unaskedRow({ cap: 12, used: [{ reason: 'watch: page changed' }, { reason: 'review: market doc' }, { reason: 'watch: page changed' }] });
    expect(row.detail).toBe('3 of 12 used: watch: page changed (2), review: market doc');
    expect(row.warn).toBeUndefined();
    expect(unaskedRow({ cap: 2, used: [{ reason: 'a' }, { reason: 'b' }] })).toMatchObject({ warn: true, detail: '2 of 2 used: a, b' });
  });
});
