import { describe, expect, it } from 'vitest';
import type { ModelClient } from '../providers.ts';
import { createUsage } from '../usage.ts';
import { partnerRoute } from './route.ts';

const client = (name: string, extra: Partial<ModelClient> = {}): ModelClient => ({ name, model: name, maxPromptChars: 100_000, tools: true, limits: { rpd: 1000 }, async step() { return { text: '', calls: [] }; }, ...extra });
const want = { promptChars: 1000, tools: true };

describe('the partner\'s model route', () => {
  const clients = [client('groq'), client('groq-small', { side: true }), client('cerebras'), client('gemini'), client('nvidia'), client('mistral')];

  it('puts the strongest free models first and the low-effort ones last, never the side model', () => {
    const { order, notice } = partnerRoute(clients, createUsage(null), want);
    expect(order.map((one) => one.name)).toEqual(['gemini', 'nvidia', 'mistral', 'groq', 'cerebras']);
    expect(notice).toBeUndefined();
  });

  it('falls back only when the strong route is resting, and says so', () => {
    const usage = createUsage(null);
    usage.cool('gemini');
    expect(partnerRoute(clients, usage, want).order[0].name).toBe('nvidia');
    for (const name of ['nvidia', 'mistral']) usage.cool(name);
    const rested = partnerRoute(clients, usage, want);
    expect(rested.order.map((one) => one.name)).toEqual(['groq', 'cerebras', 'gemini', 'nvidia', 'mistral']);
    expect(rested.notice).toBe('Your partner\'s stronger models are resting, so Groq answers for now.');
  });

  it('keeps a second key of a strong provider with it', () => {
    expect(partnerRoute([client('groq'), client('gemini'), client('gemini#2')], createUsage(null), want).order.map((one) => one.name)).toEqual(['gemini', 'gemini#2', 'groq']);
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
