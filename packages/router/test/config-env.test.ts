import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadProvidersConfig, disabledProvidersFromEnv } from '../src/config.js';

const shipped = path.resolve(__dirname, '../../../config/providers.yaml');

describe('CUBICLE_DISABLE_PROVIDERS', () => {
  it('parses a comma list, trimming and dropping blanks', () => {
    expect([...disabledProvidersFromEnv({ CUBICLE_DISABLE_PROVIDERS: ' ollama, xai ,, ' })]).toEqual(['ollama', 'xai']);
    expect(disabledProvidersFromEnv({}).size).toBe(0);
  });
  it('switches the named providers off for this process without touching the file', () => {
    const on = loadProvidersConfig(shipped, {});
    const off = loadProvidersConfig(shipped, { CUBICLE_DISABLE_PROVIDERS: 'ollama' });
    expect(on.providers.find((p) => p.id === 'ollama')?.enabled).toBe(true);
    expect(off.providers.find((p) => p.id === 'ollama')?.enabled).toBe(false);
    // Everyone else is exactly as the file says, and an id that matches nothing is ignored.
    for (const p of off.providers) if (p.id !== 'ollama') expect(p.enabled).toBe(on.providers.find((q) => q.id === p.id)?.enabled);
    expect(loadProvidersConfig(shipped, { CUBICLE_DISABLE_PROVIDERS: 'nobody' }).providers.map((p) => p.enabled)).toEqual(on.providers.map((p) => p.enabled));
  });
});
