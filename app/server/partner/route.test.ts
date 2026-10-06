import { describe, expect, it } from 'vitest';
import type { ModelClient } from '../providers.ts';
import { realClients } from '../providers.ts';
import { createUsage } from '../usage.ts';
import { markVerdict, partnerRoute, PUSHBACK_MS, turnRoute } from './route.ts';

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
  const names = (keys: Record<string, string>, promptChars = 25_000) => partnerRoute(realClients(keys as NodeJS.ProcessEnv), createUsage(null), { promptChars, tools: true, reserved: true }).order.map((one) => one.name);

  it('has no OpenRouter model at all while its key is empty, as it is today', () => {
    expect(names({ ...env, OPENROUTER_API_KEY: '' })).toEqual(['gemini-flash', 'gemini', 'cloudflare-gpt-oss', 'cloudflare-qwen', 'cloudflare']);
  });

  it('puts OpenRouter\'s free Qwen between the two Cloudflare models once the key is set', () => {
    expect(names({ ...env, OPENROUTER_API_KEY: 'o' })).toEqual(['gemini-flash', 'gemini', 'cloudflare-gpt-oss', 'openrouter-qwen', 'cloudflare-qwen', 'cloudflare', 'openrouter']);
    expect(realClients({ OPENROUTER_API_KEY: 'o' } as NodeJS.ProcessEnv).find((one) => one.name === 'openrouter-qwen')).toMatchObject({ model: 'dots-studio/dots-3-note-preview:free', tools: true, limits: { rpd: 50 } });
  });

  it('gives the partner every model set up, Gemini 3.5 Flash first and Hugging Face last, and the side models none of it (2026-10-06)', () => {
    const all = { ...env, NVIDIA_API_KEY: 'n', OLLAMA_API_KEY: 'l', MISTRAL_API_KEY: 'm', SAMBANOVA_API_KEY: 's', OPENROUTER_API_KEY: 'o', HF_TOKEN: 'h' };
    const order = names(all);
    expect(order.slice(0, 11)).toEqual(['gemini-flash', 'gemini', 'nvidia-ultra', 'ollama-cloud', 'cloudflare-gpt-oss', 'nvidia', 'ollama-gpt-oss', 'mistral', 'sambanova', 'openrouter-qwen', 'cloudflare-qwen']);
    expect(order.at(-1)).toBe('hf');
    expect(order).not.toContain('nvidia-lightning');
  });

  it('leaves Groq off a small partner turn too, where it would fit', () => {
    expect(names(env, 2000)).not.toContain('groq');
  });
});

// Journey 13 follow-up: the partner-only model has 20 requests a day, so it answers only the turns that commit: the
// verdict, the pushback in the hour after one, the morning note. Plain partner chat takes the usual order.
describe('the partner-only model, kept for the turns that commit', () => {
  const all = [client('gemini'), client('gemini-flash', { partnerOnly: true }), client('nvidia'), client('groq-small', { side: true })];
  const names = (out: { order: ModelClient[] }) => out.order.map((one) => one.name);
  it('answers a verdict, and the pushback within the hour after it', () => {
    const sam = { id: 'sam-1', partner: true };
    expect(names(turnRoute(sam, all, createUsage(null), want, { query: 'Your verdict: keep going, pivot or stop?' }))).toEqual(['gemini-flash', 'gemini', 'nvidia']);
    expect(names(turnRoute(sam, all, createUsage(null), want, { query: 'Tom says 34 offices to break even. Does it hold?' }))).toEqual(['gemini', 'nvidia']);
    markVerdict('sam-1', 1_000_000);
    expect(names(turnRoute(sam, all, createUsage(null), want, { query: 'Tom says 34 offices to break even. Does it hold?', now: 1_000_000 + PUSHBACK_MS - 1 }))[0]).toBe('gemini-flash');
    expect(names(turnRoute(sam, all, createUsage(null), want, { query: 'Write the update', now: 1_000_000 + PUSHBACK_MS + 1 }))[0]).toBe('gemini');
    expect(names(partnerRoute(all, createUsage(null), { ...want, reserved: true }))[0]).toBe('gemini-flash');
  });
  it('leaves plain partner chat, runs and hand-offs on the usual order, never gives it to a colleague, and keeps a pin', () => {
    expect(names(turnRoute({ id: 'p2', partner: true }, all, createUsage(null), want, { query: 'Draft the investor update' }))).toEqual(['gemini', 'nvidia']);
    expect(names(turnRoute({ id: 'p2', partner: true }, all, createUsage(null), want))).toEqual(['gemini', 'nvidia']);
    expect(names(turnRoute({ id: 'r1' }, all, createUsage(null), want, { query: 'Your verdict?' }))).toEqual(['gemini', 'nvidia']);
    expect(turnRoute({ partner: true, model: 'nvidia' }, all, createUsage(null), want).order[0].name).toBe('nvidia');
  });
  it('waits for the partner-only model\'s first word with another model behind it, where everyone else is cut at 20 s', () => {
    const clients = realClients({ GEMINI_API_KEY: 'k' } as NodeJS.ProcessEnv);
    expect(clients.find((one) => one.name === 'gemini-flash')!.firstWordMs).toBe(45_000);
    expect(clients.find((one) => one.name === 'gemini')!.firstWordMs).toBe(20_000);
  });
});

// Journey 13, found live: Gemini 3.5 Flash's free tier is 20 requests a day for the project (its 429 says "limit: 20"),
// so the founder's pushback went to Flash-Lite. The router knows the 20, and the founder hears why.
describe('the partner\'s own model out of requests', () => {
  it('is known to have 20 a day, and when they are used the partner\'s turn says so and goes to the next strong model', () => {
    const clients = realClients({ GEMINI_API_KEY: 'k', NVIDIA_API_KEY: 'n' } as NodeJS.ProcessEnv);
    const flash = clients.find((one) => one.name === 'gemini-flash')!;
    expect(flash.limits.rpd).toBe(20);
    const usage = createUsage(null);
    const verdict = { query: 'Give me your verdict: keep going or stop?' };
    expect(turnRoute({ id: 'v1', partner: true }, clients, usage, want, verdict).order[0].name).toBe('gemini-flash');
    for (let index = 0; index < 20; index += 1) usage.record('gemini-flash', { input: 10, output: 1 });
    const spent = turnRoute({ id: 'v1', partner: true }, clients, usage, want, verdict);
    expect(spent.order[0].name).toBe('gemini');
    expect(spent.notice).toBe("Your partner's own model (Gemini-flash) has used today's free requests, so Gemini answers for now.");
    // A plain chat turn never hears of it: the model was not its to use.
    expect(turnRoute({ id: 'v2', partner: true }, clients, usage, want, { query: 'Draft the update' }).notice).toBeUndefined();
  });
});
