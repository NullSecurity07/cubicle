import { describe, expect, it } from 'vitest';
import { keyChecks } from '../openends/health.ts';
import { ENTRIES, needs } from '../providers.ts';
import { catalogue, fallbackLine } from './catalogue.ts';

describe('the keys the app knows', () => {
  it('has a row for every name models.json needs, once, with where to get it', () => {
    const rows = catalogue();
    const names = rows.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of new Set(ENTRIES.flatMap(needs))) {
      const row = rows.find((one) => one.name === name);
      expect(row?.group, name).toBe('Models');
      expect(row?.where, name).toBeTruthy();
    }
  });

  it('names each service key under the Health row that asks for it, in that row\'s own words', () => {
    const checks = keyChecks({}, '/nowhere');
    for (const row of catalogue().filter((one) => !['Models', 'Phone'].includes(one.group))) {
      const check = checks.find((one) => one.name === row.group);
      expect(check, row.group).toBeTruthy();
      // The Cloudflare names are shown under Models; Drawing pictures names them too.
      expect(`${check!.detail} ${check!.fix}`, row.name).toContain(row.group === 'Finding leads' ? 'OPENOUTFIND_' : row.name);
    }
  });

  it('gives a provider it has no words for a row under its own name', () => {
    expect(catalogue([{ name: 'newcomer', keyEnv: 'NEWCOMER_KEY', baseURL: 'https://x/${NEWCOMER_ACCOUNT}' }]).slice(0, 2))
      .toEqual([{ name: 'NEWCOMER_KEY', group: 'Models', label: 'newcomer', where: undefined, restart: true }, { name: 'NEWCOMER_ACCOUNT', group: 'Models', label: 'newcomer', where: undefined, restart: true }]);
  });
});

describe('the keys that would add a fallback (round 5)', () => {
  it('names each free sign-up that is not set, with where to make it and the models it brings', () => {
    const line = fallbackLine(() => false)!;
    expect(line).toBe('Keys that would add a fallback, each a free sign-up: NVIDIA at build.nvidia.com (nemotron-3-super-120b-a12b, kimi-k3); Mistral at console.mistral.ai (mistral-small-latest); '
      + 'Cerebras at cloud.cerebras.ai (gpt-oss-120b, qwen-3.8-27b); OpenRouter at openrouter.ai/keys (nemotron-3-super-120b-a12b:free, dots-3-note-preview:free).');
  });

  it('leaves out the ones set, and says nothing when all are', () => {
    const line = fallbackLine((name) => name !== 'MISTRAL_API_KEY')!;
    expect(line).toBe('Keys that would add a fallback, each a free sign-up: Mistral at console.mistral.ai (mistral-small-latest).');
    expect(fallbackLine(() => true)).toBeNull();
  });
});
