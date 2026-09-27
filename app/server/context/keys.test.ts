import { describe, expect, it } from 'vitest';
import { providerOf, realClients, type ModelClient } from '../providers.ts';
import { route } from '../router.ts';
import { createUsage } from '../usage.ts';

const names = (clients: ModelClient[]) => clients.map((one) => one.name);
const pool = (): ModelClient[] => [
  { name: 'groq', model: 'oss', maxPromptChars: 18_000, tools: true, limits: { rpd: 10 }, step: async () => ({ text: '', calls: [] }) },
  { name: 'groq#2', model: 'oss', maxPromptChars: 18_000, tools: true, limits: { rpd: 10 }, step: async () => ({ text: '', calls: [] }) },
  { name: 'gemini', model: 'flash', maxPromptChars: 400_000, tools: true, limits: { rpd: 10 }, step: async () => ({ text: '', calls: [] }) },
];

describe('a provider with more than one key', () => {
  it('makes a client of each key, in number order, with the first one keeping the plain name', () => {
    const clients = realClients({ GROQ_API_KEY: 'a', GROQ_API_KEY_3: 'c', GROQ_API_KEY_2: 'b', GEMINI_API_KEY: 'g' } as NodeJS.ProcessEnv);
    // The small side model and the second model ride on the same keys, one client per key.
    expect(names(clients)).toEqual(['groq', 'groq#2', 'groq#3', 'groq-small', 'groq-small#2', 'groq-small#3', 'gemini', 'groq-qwen', 'groq-qwen#2', 'groq-qwen#3']);
    expect(clients.every((one) => one.model && one.maxPromptChars > 0)).toBe(true);
    // A spare key on its own is still that provider, and an empty one is no key at all.
    expect(names(realClients({ GROQ_API_KEY_2: 'b', MISTRAL_API_KEY: '' } as NodeJS.ProcessEnv))).toEqual(['groq#2', 'groq-small#2', 'groq-qwen#2']);
    expect(providerOf('groq#2')).toBe('groq');
  });

  it('rests only the key that was refused, and keeps the other one working', () => {
    const usage = createUsage(null);
    const clients = pool();
    usage.cool('groq', 30_000);
    expect(names(route(clients, usage, { promptChars: 10, tools: true }).order)).toEqual(['gemini', 'groq#2', 'groq']);
  });

  it('takes a person pinned to a provider to whichever of its keys has room', () => {
    const usage = createUsage(null);
    const clients = pool();
    for (let at = 0; at < 10; at += 1) usage.record('groq');
    const result = route(clients, usage, { pinned: 'groq', promptChars: 10, tools: true });
    expect(names(result.order)).toEqual(['groq#2', 'groq', 'gemini']);
    // Half of Groq's two days' worth is spent, which is not something to interrupt the founder with.
    expect(result.notice).toBeUndefined();
    for (let at = 0; at < 10; at += 1) usage.record('groq#2');
    expect(route(clients, usage, { pinned: 'groq', promptChars: 10, tools: true }).notice).toMatch(/Groq has no free quota left today/);
  });

  it('shows the founder one provider, its keys counted together', () => {
    let now = Date.parse('2026-09-27T10:00:00Z');
    const usage = createUsage(null, () => now);
    usage.record('groq', { input: 100, output: 20 });
    now += 1000;
    usage.record('groq#2', { input: 300, output: 40 });
    usage.record('gemini', { input: 10, output: 1 });
    expect(usage.info(pool())).toEqual([
      { name: 'groq', model: 'oss', ready: true, left: 0.9, requests: 2, tokens: 460, lastAnswerAt: now },
      { name: 'gemini', model: 'flash', ready: true, left: 0.9, requests: 1, tokens: 11, lastAnswerAt: now },
    ]);
  });

  it('says when a provider last answered, whether a key check passed, and whether every key rests slow (pass 8)', () => {
    let now = Date.parse('2026-09-27T23:59:00Z');
    const usage = createUsage(null, () => now);
    usage.record('gemini');
    const answered = now;
    // A new day zeroes the count, not what is known: it answered, so it is not untested.
    now += 120_000;
    expect(usage.info(pool()).find((one) => one.name === 'gemini')).toMatchObject({ requests: 0, lastAnswerAt: answered });
    usage.revive('groq#2');
    const quiet = new Error('no first word within 20 s (timed out)');
    for (let at = 0; at < 2; at += 1) usage.failed('groq', quiet);
    const groq = usage.info(pool()).find((one) => one.name === 'groq')!;
    expect(groq.checked).toBe(true);
    // One key of two slow is not the provider slow: its other key still serves.
    expect(groq.slow).toBeUndefined();
    for (let at = 0; at < 2; at += 1) usage.failed('groq#2', quiet);
    expect(usage.info(pool()).find((one) => one.name === 'groq')!.slow).toBe(true);
    expect(usage.info(pool()).find((one) => one.name === 'gemini')!.slow).toBeUndefined();
  });
});
