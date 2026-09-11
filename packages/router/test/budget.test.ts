import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseProvidersConfig } from '../src/config.js';
import { budgetedTier, Router } from '../src/router.js';
import { QuotaTracker } from '../src/quota.js';
import { openMemoryDb, EventLog } from '@cubicle/core';

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
    // will still reach for rather than stopping — in order, cheapest first.
    expect(past.map((c) => c.model.id)).toEqual(['small', 'mid', 'big']);
    db.close();
  });

  it('promptBudget reads the budgeted tier too — a demoted division is sized for the cheap model it will actually use', () => {
    const cfg = parseProvidersConfig(`
cascade: [p]
providers:
  - id: p
    base_url: https://example.test/v1
    models:
      - { id: big, tier: strong, tools: native, max_prompt_tokens: 8000 }
      - { id: small, tier: cheap, tools: native, max_prompt_tokens: 2000 }
`);
    const db = openMemoryDb();
    const router = new Router(cfg, new QuotaTracker(db), { env: {} });
    // Unbudgeted: only the strong model is at-or-above the asked tier, so its 8000-token cap applies.
    expect(router.promptBudget({ tier: 'strong', needsTools: true })).toBe(8000);
    // Past quota the request is budgeted down to cheap, so `small`'s smaller cap now governs — reverting
    // promptBudget's `budgetedTier` read (back to `TIER_RANK[req.tier]`) would keep this at 8000 and still be green.
    expect(router.promptBudget({ tier: 'strong', needsTools: true, budget: { used: 10, quota: 10 } })).toBe(2000);
    db.close();
  });
});

describe('chat(): the downgrade reason distinguishes a division budget from an ordinary cascade', () => {
  const behaviours = new Map<string, { status?: number }>();
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const body = JSON.parse(data || '{}');
        const b = behaviours.get(body.model as string) ?? {};
        if (b.status && b.status >= 400) {
          res.writeHead(b.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'boom' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());

  function mk() {
    const cfg = parseProvidersConfig(`
cascade: [p]
providers:
  - id: p
    base_url: ${base}/v1
    api_key_env: P_KEY
    models:
      - { id: big, tier: strong, tools: native, limits: { rpm: 100 } }
      - { id: small, tier: cheap, tools: native, limits: { rpm: 100 } }
`);
    const db = openMemoryDb();
    const events = new EventLog(db, mkdtempSync(path.join(tmpdir(), 'cubicle-router-budget-')));
    const quota = new QuotaTracker(db);
    return { router: new Router(cfg, quota, { env: { P_KEY: 'x' }, events }), events };
  }

  it('reason is "division budget" when the tier was demoted by a spent quota', async () => {
    behaviours.clear();
    const { router, events } = mk();
    const r = await router.chat({ tier: 'strong', needsTools: false, budget: { used: 10, quota: 10 } }, { messages: [{ role: 'user', content: 'hi' }] });
    expect(r.model).toBe('small');
    expect(r.downgraded).toBe(true);
    const ev = events.last('router.downgraded')!;
    expect(ev.payload.requested_tier).toBe('strong');
    expect(ev.payload.reason).toBe('division budget');
  });

  it('reason is "cascade" when the same-tier model is simply unavailable and there is no budget', async () => {
    behaviours.clear();
    behaviours.set('big', { status: 503 });
    const { router, events } = mk();
    const r = await router.chat({ tier: 'strong', needsTools: false }, { messages: [{ role: 'user', content: 'hi' }] });
    expect(r.model).toBe('small');
    expect(r.downgraded).toBe(true);
    const ev = events.last('router.downgraded')!;
    expect(ev.payload.requested_tier).toBe('strong');
    expect(ev.payload.reason).toBe('cascade');
  });
});
