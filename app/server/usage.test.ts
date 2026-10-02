import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEAD_MS } from './breaker.ts';
import type { ModelClient } from './providers.ts';
import { createUsage, keyPrint } from './usage.ts';

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
