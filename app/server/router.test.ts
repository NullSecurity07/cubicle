import { describe, expect, it } from 'vitest';
import type { ModelClient } from './providers.ts';
import { route } from './router.ts';
import { createUsage } from './usage.ts';

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
    expect(result.notice).toBe('Groq is near its free limit, so Gemini answers for now.');
  });

  it('steps aside before the per-minute token wall, and comes back after a minute', () => {
    let now = Date.parse('2026-09-19T10:00:00Z');
    const usage = createUsage(null, () => now);
    usage.record('groq', { input: 900, output: 50 });
    const clients = [client('groq', { limits: { tpm: 1000 } }), client('gemini')];
    expect(names(route(clients, usage, { promptChars: 400, tools: true }))).toEqual(['gemini', 'groq']);
    now += 61_000;
    expect(names(route(clients, usage, { promptChars: 400, tools: true }))).toEqual(['groq', 'gemini']);
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
    expect(spent.notice).toBe('Groq is near its free limit, so Ollama answers for now.');
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
});
