import { describe, expect, it } from 'vitest';
import type { ModelClient } from '../providers.ts';
import { realClients } from '../providers.ts';
import { createUsage } from '../usage.ts';
import { partnerRoute } from './route.ts';

const client = (name: string, extra: Partial<ModelClient> = {}): ModelClient => ({ name, model: name, maxPromptChars: 100_000, tools: true, limits: { rpd: 1000 }, async step() { return { text: '', calls: [] }; }, ...extra });
const want = { promptChars: 1000, tools: true };

describe('the partner\'s model route', () => {
  const clients = [client('groq'), client('groq-small', { side: true }), client('cerebras'), client('gemini'), client('nvidia'), client('mistral')];

  it('puts the strongest free models first and the low-effort ones last, never the side model or Groq', () => {
    const { order, notice } = partnerRoute(clients, createUsage(null), want);
    expect(order.map((one) => one.name)).toEqual(['gemini', 'nvidia', 'mistral', 'cerebras']);
    expect(notice).toBeUndefined();
  });

  it('falls back only when the strong route is resting, and says so', () => {
    const usage = createUsage(null);
    usage.cool('gemini');
    expect(partnerRoute(clients, usage, want).order[0].name).toBe('nvidia');
    for (const name of ['nvidia', 'mistral']) usage.cool(name);
    const rested = partnerRoute(clients, usage, want);
    expect(rested.order.map((one) => one.name)).toEqual(['cerebras', 'gemini', 'nvidia', 'mistral']);
    expect(rested.notice).toBe('Your partner\'s stronger models are resting, so Cerebras answers for now.');
  });

  it('keeps a second key of a strong provider with it', () => {
    expect(partnerRoute([client('cerebras'), client('gemini'), client('gemini#2')], createUsage(null), want).order.map((one) => one.name)).toEqual(['gemini', 'gemini#2', 'cerebras']);
  });
});

describe('the partner and a model on this machine', () => {
  it('never routes the partner to a local or side model while a hosted one is set up', () => {
    const { order } = partnerRoute([client('ollama', { local: true }), client('gemini'), client('groq-small', { side: true })], createUsage(null), want);
    expect(order.map((one) => one.name)).toEqual(['gemini']);
  });

  it('keeps the local model when it is all there is', () => {
    const { order } = partnerRoute([client('ollama', { local: true })], createUsage(null), want);
    expect(order.map((one) => one.name)).toEqual(['ollama']);
  });
});

describe('the partner\'s second hosted model (round 5)', () => {
  const all = ['groq', 'groq-qwen', 'cerebras', 'gemini', 'nvidia', 'mistral', 'sambanova', 'cloudflare-gpt-oss', 'cloudflare-qwen', 'cloudflare', 'openrouter', 'openrouter-qwen'];

  it('asks Gemini and the other strong ones, Cloudflare gpt-oss right after Gemini, then OpenRouter Qwen and Cloudflare Qwen, then the rest, and never Groq', () => {
    const { order } = partnerRoute(all.map((name) => client(name)), createUsage(null), want);
    expect(order.map((one) => one.name)).toEqual(['gemini', 'cloudflare-gpt-oss', 'nvidia', 'mistral', 'sambanova', 'openrouter-qwen', 'cloudflare-qwen', 'cloudflare', 'openrouter', 'cerebras']);
  });

  it('with only the keys set here today (Gemini, Groq, Cloudflare), gpt-oss stands right behind Gemini', () => {
    const today = ['groq', 'groq-qwen', 'gemini', 'cloudflare-gpt-oss', 'cloudflare-qwen', 'cloudflare'].map((name) => client(name));
    expect(partnerRoute(today, createUsage(null), want).order.map((one) => one.name)).toEqual(['gemini', 'cloudflare-gpt-oss', 'cloudflare-qwen', 'cloudflare']);
    const usage = createUsage(null);
    usage.cool('gemini');
    const rested = partnerRoute(today, usage, want);
    expect(rested.order.map((one) => one.name)).toEqual(['cloudflare-gpt-oss', 'cloudflare-qwen', 'cloudflare', 'gemini']);
    // gpt-oss is one of the strong ones: nothing to say when it answers for Gemini.
    expect(rested.notice).toBeUndefined();
  });

  it('keeps Groq only when it is the one hosted model there is', () => {
    expect(partnerRoute([client('groq'), client('ollama', { local: true })], createUsage(null), want).order.map((one) => one.name)).toEqual(['groq']);
  });
});

describe('the partner route from the keys in .env', () => {
  const env = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a' };
  const names = (keys: Record<string, string>, promptChars = 25_000) => partnerRoute(realClients(keys as NodeJS.ProcessEnv), createUsage(null), { promptChars, tools: true }).order.map((one) => one.name);

  it('has no OpenRouter model at all while its key is empty, as it is today', () => {
    expect(names({ ...env, OPENROUTER_API_KEY: '' })).toEqual(['gemini', 'cloudflare-gpt-oss', 'cloudflare-qwen', 'cloudflare']);
  });

  it('puts OpenRouter\'s free Qwen between the two Cloudflare models once the key is set', () => {
    expect(names({ ...env, OPENROUTER_API_KEY: 'o' })).toEqual(['gemini', 'cloudflare-gpt-oss', 'openrouter-qwen', 'cloudflare-qwen', 'cloudflare', 'openrouter']);
    expect(realClients({ OPENROUTER_API_KEY: 'o' } as NodeJS.ProcessEnv).find((one) => one.name === 'openrouter-qwen')).toMatchObject({ model: 'qwen/qwen3.8-27b:free', tools: true, limits: { rpd: 50 } });
  });

  it('leaves Groq off a small partner turn too, where it would fit', () => {
    expect(names(env, 2000)).not.toContain('groq');
  });
});
