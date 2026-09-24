import { describe, expect, it } from 'vitest';
import { createBreaker, OPEN_MS, REST_MOST } from './breaker.ts';
import { complete, type ModelClient } from './providers.ts';
import { route } from './router.ts';
import { createUsage } from './usage.ts';

const failure = (status?: number, retryAfter?: number) => Object.assign(new Error(`failed with ${status}`), {
  ...(status === undefined ? {} : { status }),
  headers: new Headers(retryAfter ? { 'retry-after': String(retryAfter) } : {}),
});
const client = (name: string, step: ModelClient['step'] = async (_messages, { onToken }) => { onToken(`${name} here`); return { text: '', calls: [] }; }): ModelClient => ({
  name, model: `${name}-1`, maxPromptChars: 100_000, tools: true, limits: {}, step,
});

describe('a key that keeps failing', () => {
  it('opens after five breakdowns in a row, lets one request through after thirty seconds, and closes on a good answer', () => {
    let now = 0;
    const breaker = createBreaker(() => now);
    for (let at = 0; at < 4; at += 1) breaker.failed('groq', failure(503));
    expect(breaker.state('groq')).toBe('closed');
    expect(breaker.admit('groq')).toBe(true);
    expect(breaker.failed('groq', failure(408))).toBe(OPEN_MS);
    expect(breaker.state('groq')).toBe('open');
    expect(breaker.admit('groq')).toBe(false);
    expect(breaker.resting('groq')).toBe(true);

    now += OPEN_MS;
    expect(breaker.state('groq')).toBe('half-open');
    expect(breaker.resting('groq')).toBe(false);
    expect(breaker.admit('groq')).toBe(true);
    // One request is out: nobody else goes to this key until it has answered.
    expect(breaker.admit('groq')).toBe(false);
    expect(breaker.resting('groq')).toBe(true);
    breaker.ok('groq');
    expect(breaker.state('groq')).toBe('closed');
    expect(breaker.admit('groq')).toBe(true);
  });

  it('opens again at once when the one request let through fails', () => {
    let now = 0;
    const breaker = createBreaker(() => now);
    for (let at = 0; at < 5; at += 1) breaker.failed('groq', failure(500));
    now += OPEN_MS;
    expect(breaker.admit('groq')).toBe(true);
    breaker.failed('groq', failure(502));
    expect(breaker.state('groq')).toBe('open');
    expect(breaker.admit('groq')).toBe(false);
  });

  it('counts a timeout with no status as a breakdown, and a refusal or a stop as nothing', () => {
    const breaker = createBreaker(() => 0);
    for (let at = 0; at < 5; at += 1) breaker.failed('groq', new Error('Request timed out.'));
    expect(breaker.state('groq')).toBe('open');
    const other = createBreaker(() => 0);
    for (let at = 0; at < 9; at += 1) { other.failed('groq', failure(400)); other.failed('groq', Object.assign(new Error('aborted'), { name: 'AbortError' })); }
    expect(other.state('groq')).toBe('closed');
  });

  it('rests a key three seconds after a 429 that names no wait, doubling to five minutes, and forgets it on success', () => {
    let now = 0;
    const breaker = createBreaker(() => now);
    const rests = Array.from({ length: 9 }, () => breaker.failed('groq', failure(429)));
    expect(rests).toEqual([3000, 6000, 12_000, 24_000, 48_000, 96_000, 192_000, REST_MOST, REST_MOST]);
    expect(breaker.resting('groq')).toBe(true);
    now += REST_MOST;
    expect(breaker.resting('groq')).toBe(false);
    breaker.ok('groq');
    expect(breaker.failed('groq', failure(429))).toBe(3000);
    // A 429 that says how long is taken at its word, and does not grow the doubling.
    expect(breaker.failed('groq', failure(429, 20))).toBe(20_000);
    now += 20_000;
    expect(breaker.failed('groq', failure(429))).toBe(6000);
  });
});

describe('a resting key in the router and in a turn', () => {
  it('is skipped while its sibling serves, and comes back first once it has rested and carried less', () => {
    let now = Date.parse('2026-09-24T10:00:00Z');
    const usage = createUsage(null, () => now);
    const clients = [client('groq'), client('groq#2'), client('gemini')];
    usage.failed('groq', failure(429));
    expect(route(clients, usage, { promptChars: 10, tools: true }).order.map((one) => one.name)).toEqual(['groq#2', 'gemini', 'groq']);
    usage.record('groq#2', { input: 500, output: 20 });
    now += 3000;
    expect(route(clients, usage, { promptChars: 10, tools: true }).order.map((one) => one.name)).toEqual(['groq', 'groq#2', 'gemini']);
  });

  it('is passed over by a call once its breaker is open, even when it is the first one asked', async () => {
    const usage = createUsage(null, () => 0);
    let asked = 0;
    const broken = client('groq', async () => { asked += 1; throw failure(503); });
    for (let at = 0; at < 5; at += 1) usage.failed('groq', failure(503));
    const reply = await complete([{ role: 'user', content: 'hi' }], { onToken: () => {} }, [broken, client('gemini')], () => {}, (one) => usage.admit(one.name));
    expect(reply.client.name).toBe('gemini');
    expect(asked).toBe(0);
  });
});
