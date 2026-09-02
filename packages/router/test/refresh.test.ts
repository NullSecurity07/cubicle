import { describe, it, expect } from 'vitest';
import { refreshOpenRouterBlock } from '../src/providers-cli.js';
import { parseProvidersConfig } from '../src/config.js';

const yaml = `# providers — verified 2026-09-02
cascade: [gemini, openrouter]
providers:
  - id: gemini   # keep me
    base_url: https://example.com/v1
    api_key_env: GEMINI_API_KEY
    models:
      - { id: g1, tier: strong, tools: native, context: 1000000 }
  - id: openrouter
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY
    models:
      - { id: keep/me:free, tier: cheap, tools: json, context: 8000, manual: true }
      - { id: old/model:free, tier: medium, tools: native, context: 200000 }
`;

describe('providers refresh', () => {
  it('rewrites the openrouter block, keeps comments, manual entries, and other providers', () => {
    const out = refreshOpenRouterBlock(yaml, [
      { id: 'big/model:free', context_length: 262144, supported_parameters: ['tools'] },
      { id: 'small/model:free', context_length: 65536, supported_parameters: [] },
    ], '2026-09-02');
    expect(out).toContain('# keep me');
    expect(out).toContain('keep/me:free');
    expect(out).not.toContain('old/model:free');
    const cfg = parseProvidersConfig(out);
    const or = cfg.providers.find((p) => p.id === 'openrouter')!;
    expect(or.models.map((m) => m.id)).toEqual(['keep/me:free', 'big/model:free', 'small/model:free']);
    expect(or.models[1].tools).toBe('native');
    expect(or.models[1].tier).toBe('medium');
    expect(or.models[2].tools).toBe('json');
    expect(or.note).toContain('2026-09-02');
    expect(cfg.providers[0].models[0].id).toBe('g1');
  });
});
