import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { neuronPoolOf, type ModelClient } from './providers.ts';
import { route } from './router.ts';
import { createUsage, pictureDrawn } from './usage.ts';

const client = (name: string, extra: Partial<ModelClient> = {}): ModelClient => ({
  name, model: `${name}-1`, maxPromptChars: 1000, tools: true, limits: { rpd: 10, rpm: 3, tpm: 1000 }, step: async () => ({ text: '', calls: [] }), ...extra,
});
const names = (result: ReturnType<typeof route>) => result.order.map((one) => one.name);

describe('route', () => {
  it('keeps the configured order while there is room, with nothing to say', () => {
    const result = route([client('groq'), client('gemini')], createUsage(null), { promptChars: 10, tools: true });
    expect(names(result)).toEqual(['groq', 'gemini']);
    expect(result.notice).toBeUndefined();
  });

  it('moves a model that is nearly out of daily quota to the back and says so', () => {
    const usage = createUsage(null);
    for (let i = 0; i < 10; i += 1) usage.record('groq', { input: 1, output: 1 });
    const result = route([client('groq', { limits: { rpd: 10 } }), client('gemini')], usage, { promptChars: 10, tools: true });
    expect(names(result)).toEqual(['gemini', 'groq']);
    expect(result.notice).toBe("Groq has used today's free quota, so Gemini answers for now.");
  });

  it('steps aside before the per-minute token wall, and comes back after a minute', () => {
    let now = Date.parse('2026-09-19T10:00:00Z');
    const usage = createUsage(null, () => now);
    usage.record('groq', { input: 900, output: 50 });
    const clients = [client('groq', { limits: { tpm: 1000 } }), client('gemini')];
    const hot = route(clients, usage, { promptChars: 400, tools: true });
    expect(names(hot)).toEqual(['gemini', 'groq']);
    // Most of the day is left: the founder hears it is this minute, not the day, that is full.
    expect(hot.notice).toBe('Groq is busy this minute, so Gemini answers for now.');
    now += 61_000;
    expect(names(route(clients, usage, { promptChars: 400, tools: true }))).toEqual(['groq', 'gemini']);
  });

  it('says a refused key was refused, and where to fix it', () => {
    const usage = createUsage(null);
    usage.failed('groq', Object.assign(new Error('Invalid API Key'), { status: 401 }));
    const result = route([client('groq'), client('gemini')], usage, { promptChars: 10, tools: true });
    expect(names(result)).toEqual(['gemini', 'groq']);
    expect(result.notice).toBe("Groq's key was refused, so Gemini answers. Fix it in Keys.");
  });

  it('puts a key that takes one request at a time behind the others while it has one out', () => {
    let out = true;
    const clients = [client('zai-flash', { concurrency: 1, busy: () => out }), client('gemini')];
    expect(names(route(clients, createUsage(null), { promptChars: 10, tools: true }))).toEqual(['gemini', 'zai-flash']);
    out = false;
    expect(names(route(clients, createUsage(null), { promptChars: 10, tools: true }))).toEqual(['zai-flash', 'gemini']);
  });

  it('believes a provider header over the published limit', () => {
    const usage = createUsage(null);
    usage.record('groq', { input: 1, output: 1 }, { remainingRequests: 2, limitRequests: 1000 });
    expect(usage.left(client('groq', { limits: { rpd: 1000 } }))).toBeCloseTo(0.002);
  });

  it('rests a provider that answered 429', () => {
    const usage = createUsage(null);
    usage.cool('groq', 30_000);
    expect(names(route([client('groq'), client('gemini')], usage, { promptChars: 10, tools: true }))).toEqual(['gemini', 'groq']);
  });

  it('puts a pinned model first and warns when it runs low', () => {
    const usage = createUsage(null);
    for (let i = 0; i < 9; i += 1) usage.record('gemini', { input: 1, output: 1 });
    const result = route([client('groq'), client('gemini')], usage, { pinned: 'gemini', promptChars: 10, tools: true });
    expect(names(result)).toEqual(['gemini', 'groq']);
    expect(result.notice).toBe("Gemini has 10% of today's free quota left.");
  });

  it('says so when the pinned model has no key here', () => {
    const result = route([client('groq')], createUsage(null), { pinned: 'mistral', promptChars: 10, tools: true });
    expect(names(result)).toEqual(['groq']);
    expect(result.notice).toMatch(/Mistral is not set up/);
  });

  it('leaves out models that cannot hold the prompt or cannot use tools', () => {
    const result = route([client('small', { maxPromptChars: 5 }), client('mute', { tools: false }), client('ok')], createUsage(null), { promptChars: 10, tools: true });
    expect(names(result)).toEqual(['ok']);
  });

  it('keeps a model on this machine behind every hosted one with room, wherever it was listed', () => {
    const usage = createUsage(null);
    const local = client('ollama', { local: true, limits: {} });
    // Listed last, and listed first (the way summaries read the list backwards): behind the hosted ones either way.
    expect(names(route([client('groq'), client('gemini'), local], usage, { promptChars: 10, tools: true }))).toEqual(['groq', 'gemini', 'ollama']);
    const backwards = route([local, client('gemini'), client('groq')], usage, { promptChars: 10, tools: true });
    expect(names(backwards)).toEqual(['gemini', 'groq', 'ollama']);
    expect(backwards.notice).toBeUndefined();
    // Hosted ones out of room: the machine's own model answers before them, and the founder is told.
    for (let i = 0; i < 10; i += 1) { usage.record('groq', { input: 1, output: 1 }); usage.record('gemini', { input: 1, output: 1 }); }
    const spent = route([client('groq', { limits: { rpd: 10 } }), client('gemini', { limits: { rpd: 10 } }), local], usage, { promptChars: 10, tools: true });
    expect(names(spent)).toEqual(['ollama', 'groq', 'gemini']);
    expect(spent.notice).toBe("Groq has used today's free quota, so Ollama answers for now.");
    // Pinned by a person: first, like any pinned model.
    expect(names(route([client('groq'), local], createUsage(null), { pinned: 'ollama', promptChars: 10, tools: true }))).toEqual(['ollama', 'groq']);
  });

  it('starts a new day at zero', () => {
    let now = Date.parse('2026-09-19T23:59:00Z');
    const usage = createUsage(null, () => now);
    for (let i = 0; i < 10; i += 1) usage.record('groq');
    expect(usage.left(client('groq'))).toBe(0);
    now += 120_000;
    expect(usage.left(client('groq'))).toBe(1);
  });

  it('spreads one provider\'s keys by what each has carried, the last minute first, and moves nothing between providers', () => {
    let now = Date.parse('2026-09-24T10:00:00Z');
    const usage = createUsage(null, () => now);
    const clients = [client('groq'), client('groq#2'), client('gemini'), client('groq#3')];
    const order = () => names(route(clients, usage, { promptChars: 10, tools: true }));
    expect(order()).toEqual(['groq', 'groq#2', 'gemini', 'groq#3']);
    usage.record('groq', { input: 300, output: 10 });
    expect(order()).toEqual(['groq#2', 'groq#3', 'gemini', 'groq']);
    usage.record('groq#2', { input: 100, output: 10 });
    usage.record('groq#3', { input: 100, output: 10 });
    expect(order()).toEqual(['groq#2', 'groq#3', 'gemini', 'groq']);
    // A minute on, the window is empty for all three and the day decides: the lightest day goes first.
    now += 61_000;
    expect(order()).toEqual(['groq#2', 'groq#3', 'gemini', 'groq']);
    usage.record('groq#2', { input: 400, output: 10 });
    now += 61_000;
    expect(order()).toEqual(['groq#3', 'groq', 'gemini', 'groq#2']);
    // Pinned, the same: every key of the pinned provider, lightest first.
    expect(names(route(clients, usage, { pinned: 'groq', promptChars: 10, tools: true }))).toEqual(['groq#3', 'groq', 'groq#2', 'gemini']);
  });
});

describe('a model on a daily pool shared with the pictures (round 5)', () => {
  const oss = client('cloudflare-gpt-oss', { limits: { rpd: 3 }, sharedPool: true });

  it('is skipped for the rest of the day once its own daily turns are used, and is back the next day', () => {
    let now = Date.parse('2026-09-27T10:00:00Z');
    const usage = createUsage(null, () => now);
    for (let i = 0; i < 3; i += 1) usage.record('cloudflare-gpt-oss', { input: 1, output: 1 });
    expect(usage.spent(oss)).toBe(true);
    expect(names(route([oss, client('gemini')], usage, { promptChars: 10, tools: true }))).toEqual(['gemini']);
    now = Date.parse('2026-09-28T00:01:00Z');
    expect(usage.spent(oss)).toBe(false);
    expect(names(route([oss, client('gemini')], usage, { promptChars: 10, tools: true }))).toEqual(['cloudflare-gpt-oss', 'gemini']);
  });

  it('is still asked when it is the only model there is, and a model not on a shared pool only moves to the back', () => {
    const usage = createUsage(null);
    for (let i = 0; i < 3; i += 1) { usage.record('cloudflare-gpt-oss'); usage.record('groq'); }
    expect(names(route([oss], usage, { promptChars: 10, tools: true }))).toEqual(['cloudflare-gpt-oss']);
    expect(names(route([client('groq', { limits: { rpd: 3 } }), client('gemini')], usage, { promptChars: 10, tools: true }))).toEqual(['gemini', 'groq']);
  });
});

describe('two models on one OpenRouter account (round 5)', () => {
  it('count their requests together against the account\'s 50 a day', () => {
    const usage = createUsage(null);
    const gemma = client('openrouter', { limits: { rpd: 4 } });
    const qwen = client('openrouter-qwen', { limits: { rpd: 4 } });
    const second = client('openrouter#2', { limits: { rpd: 4 } });
    for (let i = 0; i < 2; i += 1) { usage.record('openrouter'); usage.record('openrouter-qwen'); }
    expect(usage.spent(gemma)).toBe(true);
    expect(usage.spent(qwen)).toBe(true);
    expect(usage.left(qwen)).toBe(0);
    // A second key is a second account.
    expect(usage.spent(second)).toBe(false);
    usage.record('openrouter-qwen#2');
    expect(usage.left(second)).toBe(0.75);
  });
});

describe('Cloudflare\'s neuron pool (review 5)', () => {
  it('leaves every model on the pool out once the day\'s turns have spent 9,000 neurons between them, whatever their own counts', () => {
    const usage = createUsage(null);
    const oss = client('cloudflare-gpt-oss', { limits: { rpd: 25 }, sharedPool: true });
    const scout = client('cloudflare', { limits: { rpd: 10 }, sharedPool: true });
    const second = client('cloudflare#2', { limits: { rpd: 10 }, sharedPool: true });
    usage.record('cloudflare-gpt-oss', { input: 1, output: 1, neurons: 5000 });
    expect(usage.spent(scout)).toBe(false);
    usage.record('cloudflare-qwen', { input: 1, output: 1, neurons: 4000 });
    expect(usage.spent(oss)).toBe(true);
    expect(usage.spent(scout)).toBe(true);
    // A second token is on the same account (the one CLOUDFLARE_ACCOUNT_ID), so it draws on the same pool (round 6).
    expect(usage.spent(second)).toBe(true);
    expect(names(route([oss, scout, client('gemini')], usage, { promptChars: 10, tools: true }))).toEqual(['gemini']);
  });
});

describe('Cloudflare\'s neuron pool, one an account, pictures included (round 6)', () => {
  it('keys the pool by the account id, not the token, so every token and model on the account shares it', () => {
    expect(neuronPoolOf('cloudflare')).toBe('CLOUDFLARE_ACCOUNT_ID');
    expect(neuronPoolOf('cloudflare-gpt-oss#2')).toBe('CLOUDFLARE_ACCOUNT_ID');
    expect(neuronPoolOf('gemini')).toBeUndefined();
  });

  it('counts the pictures drawn today into the pool, so the turns stop at 9,000 with them in, and says how much is used', async () => {
    const usage = createUsage(join(await mkdtemp(join(tmpdir(), 'neurons-')), 'usage.json'));
    const oss = client('cloudflare-gpt-oss', { limits: { rpd: 25 }, sharedPool: true });
    usage.record('cloudflare-gpt-oss', { input: 1, output: 1, neurons: 8950 });
    expect(usage.spent(oss)).toBe(false);
    expect(usage.neurons(oss)).toEqual({ used: 8950, of: 9000, pictures: 0, drawn: 0 });
    pictureDrawn(58);
    expect(usage.spent(oss)).toBe(true);
    expect(usage.neurons(oss)).toEqual({ used: 9008, of: 9000, pictures: 58, drawn: 1 });
    expect(usage.left(oss)).toBe(0);
    expect(usage.neurons(client('gemini'))).toBeUndefined();
  });

  it('shows what is left of the day\'s neurons as what is left of the model, when that is the nearer wall', async () => {
    const usage = createUsage(join(await mkdtemp(join(tmpdir(), 'neurons-')), 'usage.json'));
    const oss = client('cloudflare-gpt-oss', { limits: { rpd: 25 }, sharedPool: true });
    usage.record('cloudflare-qwen', { input: 1, output: 1, neurons: 4500 });
    expect(usage.left(oss)).toBe(0.5);
  });
});
