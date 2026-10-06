import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEAD_MS } from './breaker.ts';
import type { ModelClient } from './providers.ts';
import { createUsage, keyPrint, outcomeOf } from './usage.ts';

const client = (name: string): ModelClient => ({ name, model: `${name}-model`, maxPromptChars: 100_000, tools: true, limits: {}, async step() { return { text: '', calls: [] }; } });
const planOff = () => Object.assign(new Error('429 Rate limit exceeded'), { status: 429, headers: new Headers({ 'x-ratelimit-limit-req-minute': '0' }) });
const card = () => Object.assign(new Error('402 A payment method is required.'), { status: 402 });
const prints = { gemini: 'g1', mistral: 'm1', sambanova: 's1' };

describe('the dots after a restart', () => {
  it('keep a plan that is off, a key that wants a card, and which models answered or passed a check', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dots-'));
    let now = 1_000_000;
    const first = createUsage(join(dir, 'usage.json'), () => now);
    first.fingerprints(prints);
    first.record('gemini');
    first.revive('cerebras');
    first.failed('mistral', planOff());
    first.failed('sambanova', card());
    await first.keysSettled();

    now += 60_000;
    const second = createUsage(join(dir, 'usage.json'), () => now);
    second.fingerprints(prints);
    await second.load();
    const info = second.info(['gemini', 'cerebras', 'mistral', 'sambanova'].map(client));
    expect(info.find((one) => one.name === 'gemini')).toMatchObject({ lastAnswerAt: 1_000_000 });
    expect(info.find((one) => one.name === 'cerebras')).toMatchObject({ checked: true });
    expect(info.find((one) => one.name === 'mistral')).toMatchObject({ planOff: true });
    expect(info.find((one) => one.name === 'sambanova')).toMatchObject({ needsCard: true });
    expect(info.find((one) => one.name === 'sambanova')!.planOff).toBeUndefined();
    // The route knows too: a refused key is not asked first after a restart.
    expect(second.dead('mistral')).toBe(true);
    expect(second.refusals()).toEqual([{ name: 'mistral', dead: true, status: 429, planless: true }, { name: 'sambanova', dead: true, status: 402, unpaid: true }]);
  });

  it('start a key clean when it was replaced while the app was off, or its refusal has run out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dots-'));
    let now = 1_000_000;
    const first = createUsage(join(dir, 'usage.json'), () => now);
    first.fingerprints(prints);
    first.failed('mistral', planOff());
    first.failed('sambanova', card());
    await first.keysSettled();

    const newKey = createUsage(join(dir, 'usage.json'), () => now);
    newKey.fingerprints({ ...prints, mistral: 'm2' });
    await newKey.load();
    expect(newKey.planOff('mistral')).toBe(false);
    expect(newKey.needsCard('sambanova')).toBe(true);

    now += DEAD_MS;
    const later = createUsage(join(dir, 'usage.json'), () => now);
    later.fingerprints(prints);
    await later.load();
    expect(later.needsCard('sambanova')).toBe(false);
    expect(later.refusals()).toEqual([]);
  });

  it('forget a refusal once the key answers, so the next start does not bring it back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dots-'));
    const first = createUsage(join(dir, 'usage.json'), () => 1_000_000);
    first.fingerprints(prints);
    first.failed('mistral', planOff());
    first.record('mistral');
    await first.keysSettled();
    const second = createUsage(join(dir, 'usage.json'), () => 1_000_000);
    second.fingerprints(prints);
    await second.load();
    expect(second.planOff('mistral')).toBe(false);
    expect(second.info([client('mistral')])[0]).toMatchObject({ lastAnswerAt: 1_000_000 });
  });

  it('keeps a hash of the key, never the key', () => {
    expect(keyPrint('sk-secret-value')).toMatch(/^[0-9a-f]{12}$/);
    expect(keyPrint(undefined)).toBeUndefined();
  });
});

describe('a key check that did not pass', () => {
  const status = (code: number, message = `${code} error`) => Object.assign(new Error(message), { status: code });

  it('is named for how it failed: slow at the cap, no such model, provider down, refused, card, plan, or just failed', () => {
    expect(outcomeOf(new Error('aborted'), true)).toBe('slow');
    expect(outcomeOf(status(404, '404 No endpoints found'))).toBe('not-found');
    expect(outcomeOf(status(503))).toBe('down');
    expect(outcomeOf(status(500))).toBe('down');
    expect(outcomeOf(status(401))).toBe('refused');
    expect(outcomeOf(card())).toBe('card');
    expect(outcomeOf(planOff())).toBe('plan');
    expect(outcomeOf(new Error('socket hang up'))).toBe('failed');
  });

  it('is kept in model-dots.json with its time and status, read back after a restart, and never as a pass', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dots-'));
    let now = 2_000_000;
    const first = createUsage(join(dir, 'usage.json'), () => now);
    first.revive('nvidia');
    now += 1000;
    first.checkFailed('nvidia', 'slow');
    first.checkFailed('openrouter-qwen', 'not-found', 404);
    first.checkFailed('cerebras', 'down', 503);
    first.revive('groq');
    await first.keysSettled();
    const kept = JSON.parse(await readFile(join(dir, 'model-dots.json'), 'utf8'));
    expect(kept.keys.nvidia).toEqual({ check: { outcome: 'slow', at: 2_001_000 } });
    expect(kept.keys['openrouter-qwen']).toEqual({ check: { outcome: 'not-found', at: 2_001_000, status: 404 } });
    expect(kept.keys.groq).toEqual({ check: { outcome: 'ok', at: 2_001_000 } });

    now += 60_000;
    const second = createUsage(join(dir, 'usage.json'), () => now);
    await second.load();
    expect(second.checks()).toMatchObject({ nvidia: { outcome: 'slow' }, 'openrouter-qwen': { outcome: 'not-found', status: 404 }, cerebras: { outcome: 'down', status: 503 }, groq: { outcome: 'ok' } });
    const info = second.info(['nvidia', 'openrouter-qwen', 'cerebras', 'groq'].map(client));
    for (const name of ['nvidia', 'openrouter-qwen', 'cerebras']) expect(info.find((one) => one.name === name)!.checked).toBeUndefined();
    expect(info.find((one) => one.name === 'nvidia')).toMatchObject({ check: { outcome: 'slow', at: 2_001_000 } });
    expect(info.find((one) => one.name === 'groq')).toMatchObject({ checked: true, check: { outcome: 'ok' } });
  });

  it('reads a file from before outcomes, whose `checked: true` was a pass', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dots-'));
    await writeFile(join(dir, 'model-dots.json'), JSON.stringify({ keys: { groq: { checked: true, answeredAt: 5 } } }));
    const usage = createUsage(join(dir, 'usage.json'), () => 10);
    await usage.load();
    expect(usage.checks()).toEqual({ groq: { outcome: 'ok', at: 5 } });
  });

  it('is one key of a provider: one that passed is the provider passing', () => {
    const usage = createUsage(null, () => 1);
    usage.checkFailed('groq#2', 'slow');
    usage.revive('groq');
    expect(usage.info([client('groq'), client('groq#2')])[0]).toMatchObject({ checked: true, check: { outcome: 'ok' } });
  });
});
