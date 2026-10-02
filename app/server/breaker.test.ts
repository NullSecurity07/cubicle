import { describe, expect, it } from 'vitest';
import { createBreaker, DEAD_MS, limitWords, OPEN_MS, REST_MOST, SLOW_MS, refused, unpaid } from './breaker.ts';
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

  it('counts a model that breaks its own tool call as a breakdown, and a plain bad request not', () => {
    const breaker = createBreaker(() => 0);
    const malformed = Object.assign(new Error("400 Failed to call a function. Please adjust your prompt. See 'failed_generation' for more details."), { status: 400 });
    for (let at = 0; at < 4; at += 1) breaker.failed('groq-qwen', malformed);
    expect(breaker.failed('groq-qwen', malformed)).toBe(OPEN_MS);
    for (let at = 0; at < 5; at += 1) breaker.failed('groq', failure(400));
    expect(breaker.state('groq')).toBe('closed');
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

describe('a key that is refused', () => {
  it('takes SambaNova\'s 402 and Vercel\'s 403 for want of a card as refused keys that need a card, and a moderation 403 as neither', () => {
    const card = Object.assign(new Error('402 A payment method is required. Add one at the billing page to continue.'), { status: 402 });
    const vercel = Object.assign(new Error('403 AI Gateway requires a valid credit card on file to service requests.'), { status: 403 });
    const wrong = Object.assign(new Error('403 Forbidden'), { status: 403 });
    const flagged = Object.assign(new Error('403 Your prompt was flagged by moderation'), { status: 403 });
    expect([card, vercel, wrong, flagged].map(unpaid)).toEqual([true, true, false, false]);
    expect([card, vercel, wrong, flagged].map(refused)).toEqual([true, true, true, false]);
    let now = 0;
    const breaker = createBreaker(() => now);
    expect(breaker.failed('sambanova', card)).toBe(DEAD_MS);
    expect(breaker.dead('sambanova')).toBe(true);
    // A refusal kept from the last run is put back until the hour it would have ended, never past it.
    breaker.refuse('vercel', 1000);
    expect(breaker.dead('vercel')).toBe(true);
    now = 1000;
    expect(breaker.dead('vercel')).toBe(false);
    breaker.refuse('vercel', 500);
    expect(breaker.dead('vercel')).toBe(false);
  });

  it('rests six hours after a 401 or a 403, is moved to the back, and comes back on one good answer', () => {
    let now = 0;
    const breaker = createBreaker(() => now);
    expect(breaker.failed('groq', failure(401))).toBe(DEAD_MS);
    expect(DEAD_MS).toBeGreaterThanOrEqual(6 * 3_600_000);
    expect(breaker.dead('groq')).toBe(true);
    expect(breaker.resting('groq')).toBe(true);
    now += DEAD_MS - 1;
    expect(breaker.resting('groq')).toBe(true);
    now += 1;
    expect(breaker.resting('groq')).toBe(false);
    breaker.failed('gemini', failure(403));
    expect(breaker.dead('gemini')).toBe(true);
    breaker.ok('gemini');
    expect(breaker.dead('gemini')).toBe(false);
  });

  it('does not take a 403 for a flagged prompt as a dead key', () => {
    const breaker = createBreaker(() => 0);
    const flagged = Object.assign(new Error('403 Your input was flagged by moderation'), { status: 403 });
    expect(breaker.failed('openrouter', flagged)).toBe(0);
    expect(breaker.dead('openrouter')).toBe(false);
    expect(breaker.resting('openrouter')).toBe(false);
  });

  it('is tried after a sibling in a turn, and the usage book tells of each refusal and each answer', () => {
    let now = 0;
    const usage = createUsage(null, () => now);
    const heard: { name: string; dead: boolean }[] = [];
    usage.onKey((event) => heard.push({ name: event.name, dead: event.dead }));
    usage.failed('groq', failure(401));
    expect(heard).toEqual([{ name: 'groq', dead: true }]);
    const { order } = route([client('groq'), client('gemini')], usage, { promptChars: 10, tools: false });
    expect(order.map((one) => one.name)).toEqual(['gemini', 'groq']);
    now += DEAD_MS;
    usage.record('groq');
    expect(heard).toEqual([{ name: 'groq', dead: true }, { name: 'groq', dead: false }]);
  });
});

describe('limitWords', () => {
  it('says which free limit a 429 hit, from what the provider wrote', () => {
    expect(limitWords(Object.assign(new Error('Rate limit reached for model on tokens per minute (TPM): Limit 8000'), { status: 429 }))).toBe('busy this minute');
    expect(limitWords(Object.assign(new Error('Rate limit reached on requests per day (RPD): Limit 1000'), { status: 429 }))).toBe("today's free limit reached");
    expect(limitWords(Object.assign(new Error('Quota exceeded for metric: generate_content_free_tier_requests, limit: 15, per minute'), { status: 429 }))).toBe('busy this minute');
    expect(limitWords(Object.assign(new Error('Too many requests'), { status: 429 }))).toBe('busy for now');
  });
});

describe('a resting key in the router and in a turn', () => {
  it('is skipped while its sibling serves, and comes back first once it has rested and carried less', () => {
    let now = Date.parse('2026-09-24T10:00:00Z');
    const usage = createUsage(null, () => now);
    // Cerebras, not Gemini, beside them: it stands with Groq in the shared order, where Gemini would go first whatever the rest.
    const clients = [client('groq'), client('groq#2'), client('cerebras')];
    usage.failed('groq', failure(429));
    expect(route(clients, usage, { promptChars: 10, tools: true }).order.map((one) => one.name)).toEqual(['groq#2', 'cerebras', 'groq']);
    usage.record('groq#2', { input: 500, output: 20 });
    now += 3000;
    expect(route(clients, usage, { promptChars: 10, tools: true }).order.map((one) => one.name)).toEqual(['groq', 'groq#2', 'cerebras']);
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

describe('a model that twice gives no first word (pass 8)', () => {
  const quiet = () => new Error('no first word within 20 s (timed out)');

  it('rests slow for thirty minutes after two silences within ten minutes, apart from a refused key', () => {
    let now = 0;
    const breaker = createBreaker(() => now);
    breaker.failed('gemini', quiet());
    expect(breaker.slow('gemini')).toBe(false);
    expect(breaker.resting('gemini')).toBe(false);
    now += 9 * 60_000;
    breaker.failed('gemini', quiet());
    expect(breaker.slow('gemini')).toBe(true);
    expect(breaker.resting('gemini')).toBe(true);
    expect(breaker.dead('gemini')).toBe(false);
    // Only moved to the back: it is still let in when nothing else is.
    expect(breaker.admit('gemini')).toBe(true);
    now += SLOW_MS - 1;
    expect(breaker.slow('gemini')).toBe(true);
    now += 1;
    expect(breaker.slow('gemini')).toBe(false);
    expect(breaker.resting('gemini')).toBe(false);
  });

  it('does not rest a model whose two silences are more than ten minutes apart, or that answered between them', () => {
    let now = 0;
    const breaker = createBreaker(() => now);
    breaker.failed('nvidia', quiet());
    now += 10 * 60_000 + 1;
    breaker.failed('nvidia', quiet());
    expect(breaker.slow('nvidia')).toBe(false);
    breaker.ok('nvidia');
    now += 1000;
    breaker.failed('nvidia', quiet());
    expect(breaker.slow('nvidia')).toBe(false);
    // A 503 is not a silence and does not count towards it.
    breaker.failed('mistral', quiet());
    breaker.failed('mistral', failure(503));
    expect(breaker.slow('mistral')).toBe(false);
  });

  it('counts the long wait of the last model able as a silence too, and one good answer ends the rest', () => {
    let now = 0;
    const breaker = createBreaker(() => now);
    breaker.failed('nvidia', new Error('no first word within 240 s, the last model able (timed out)'));
    breaker.failed('nvidia', quiet());
    expect(breaker.slow('nvidia')).toBe(true);
    breaker.ok('nvidia');
    expect(breaker.slow('nvidia')).toBe(false);
  });
});
