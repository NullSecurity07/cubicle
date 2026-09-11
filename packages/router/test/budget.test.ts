import { describe, it, expect } from 'vitest';
import { parseProvidersConfig } from '../src/config.js';
import { budgetedTier, Router } from '../src/router.js';
import { QuotaTracker } from '../src/quota.js';
import { openMemoryDb } from '@cubicle/core';

describe('a division past its quota drops to the cheapest tier (spec §4)', () => {
  it('demotes strong and medium, and leaves the floor alone', () => {
    const over = { used: 100, quota: 100 };
    expect(budgetedTier('strong', over)).toBe('cheap');
    expect(budgetedTier('medium', over)).toBe('cheap');
    expect(budgetedTier('cheap', over)).toBe('cheap');
    expect(budgetedTier('local', over)).toBe('local');   // never *raised* to cheap, and never stopped
  });

  it('does nothing while there is headroom, and nothing at all without a budget', () => {
    expect(budgetedTier('strong', { used: 99, quota: 100 })).toBe('strong');
    expect(budgetedTier('strong', { used: 0, quota: 0 })).toBe('strong');    // 0 quota is "not budgeted"
    expect(budgetedTier('strong', null)).toBe('strong');
    expect(budgetedTier('strong', undefined)).toBe('strong');
  });

  it('changes which models the router will even consider', () => {
    const cfg = parseProvidersConfig(`
cascade: [p]
providers:
  - id: p
    base_url: https://example.test/v1
    models:
      - { id: big, tier: strong, tools: native }
      - { id: mid, tier: medium, tools: native }
      - { id: small, tier: cheap, tools: native }
`);
    const db = openMemoryDb();
    const router = new Router(cfg, new QuotaTracker(db), { env: {} });
    const within = router.candidates({ tier: 'strong', needsTools: true, budget: { used: 0, quota: 10 } });
    expect(within[0].model.id).toBe('big');
    const past = router.candidates({ tier: 'strong', needsTools: true, budget: { used: 10, quota: 10 } });
    // Same list, reordered: the cheap tier is now what it wants, and the expensive models are the fallback it
    // will still reach for rather than stopping.
    expect(past[0].model.id).toBe('small');
    expect(past.map((c) => c.model.id)).toHaveLength(3);
    db.close();
  });
});
