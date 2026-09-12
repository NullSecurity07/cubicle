import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseProvidersConfig } from '../src/config.js';
import { modelCostMicro, microToCents, shadowCost, hasPrices, findModel } from '../src/price.js';

const PRICED = parseProvidersConfig(`
cascade: [paid, free]
prices_verified: "2026-09-12"
providers:
  - id: paid
    base_url: https://example.test/v1
    models:
      - { id: big, tier: strong, tools: native, price: { input_per_mtok: 300, output_per_mtok: 1500 } }
      - { id: small, tier: cheap, tools: native, price: { input_per_mtok: 5, output_per_mtok: 20 } }
  - id: free
    base_url: https://example.test/v1
    models:
      - { id: gratis, tier: medium, tools: native }
`);

describe('what a model costs (spec §3)', () => {
  it('is exact integer micro-cents: cents per million tokens times tokens', () => {
    const big = findModel(PRICED, 'paid', 'big')!;
    expect(modelCostMicro(big, { prompt_tokens: 1_000_000, completion_tokens: 0 })).toBe(300_000_000);
    expect(microToCents(300_000_000)).toBe(300);
    expect(modelCostMicro(big, { prompt_tokens: 2_000, completion_tokens: 500 })).toBe(2_000 * 300 + 500 * 1500);
  });

  it('a model with no price is free, and nothing rounds a free call into a cost', () => {
    const free = findModel(PRICED, 'free', 'gratis')!;
    expect(free.price).toBeUndefined();
    expect(modelCostMicro(free, { prompt_tokens: 9_999_999, completion_tokens: 9_999_999 })).toBe(0);
    expect(findModel(PRICED, 'nope', 'nope')).toBeNull();
  });

  it('sums in micro-cents and rounds once, so a thousand half-cent calls are not lost', () => {
    // 1 667 prompt tokens on `small` is 8 335 micro-cents — under a hundredth of a cent each. Rounding per call
    // would make a thousand of them cost nothing at all.
    const calls = Array.from({ length: 1000 }, () => ({ provider: 'paid', model: 'small', prompt_tokens: 1667, completion_tokens: 0 }));
    const r = shadowCost(PRICED, calls);
    expect(r.paidCalls).toBe(1000);
    expect(r.cents).toBe(Math.round(1000 * 1667 * 5 / 1_000_000));
    expect(r.cents).toBeGreaterThan(0);
  });

  it('a token count that is not a finite number costs nothing, and never turns a sum into NaN (I1)', () => {
    // Reachable from the event log: a provider that answered without usage, a hand-edited row, a rebuilt log.
    // `Math.trunc(NaN)` is `NaN`, `NaN <= 0` is false, and the accrual would then hand `cents: NaN` to the
    // ledger's schema, throw a ZodError into the heartbeat's money step and cost the company its whole cycle.
    const big = findModel(PRICED, 'paid', 'big')!;
    for (const bad of ['x', null, undefined, NaN, Infinity, -Infinity, -5, {}] as unknown[]) {
      expect(modelCostMicro(big, { prompt_tokens: bad as number, completion_tokens: bad as number })).toBe(0);
    }
    expect(modelCostMicro(big, { prompt_tokens: 1_000_000, completion_tokens: 'x' as unknown as number })).toBe(300_000_000);
    const r = shadowCost(PRICED, [
      { provider: 'paid', model: 'big', prompt_tokens: 1_000_000, completion_tokens: 0 },
      { provider: 'paid', model: 'big', prompt_tokens: 'nonsense' as unknown as number, completion_tokens: undefined as unknown as number },
    ]);
    expect(r).toEqual({ cents: 300, paidCalls: 2 });
    expect(microToCents(NaN)).toBe(0);
  });

  it('counts only the calls that were on a priced model', () => {
    const r = shadowCost(PRICED, [
      { provider: 'paid', model: 'big', prompt_tokens: 1_000_000, completion_tokens: 0 },
      { provider: 'free', model: 'gratis', prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      { provider: 'gone', model: 'ghost', prompt_tokens: 1_000_000, completion_tokens: 0 },
    ]);
    expect(r).toEqual({ cents: 300, paidCalls: 1 });
  });

  it('says whether anything is priced at all, so the runway note can say why the cost is zero', () => {
    expect(hasPrices(PRICED)).toBe(true);
    expect(hasPrices(parseProvidersConfig('providers: [{ id: a, base_url: "https://x.test/v1", models: [{ id: m, tier: cheap }] }]'))).toBe(false);
  });

  it('the shipped file carries no prices, on purpose', () => {
    // A remembered vendor price goes stale and would put a wrong runway on the owner's bank screen. The schema
    // ships; the numbers are theirs to add. Read the same way `test/router.test.ts` already reads this file.
    const shipped = parseProvidersConfig(readFileSync(path.resolve(__dirname, '../../../config/providers.yaml'), 'utf8'));
    expect(hasPrices(shipped)).toBe(false);
  });
});
