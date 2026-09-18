/**
 * Ruling W4-13, the router's half: `Metrics/quota.md` never says something the router does not believe.
 *
 * Two things it said on 2026-09-14. gemini-3.7-flash at "21/20" calls a day, past a limit `hasHeadroom` checks
 * on every call — the check and the `record` are two steps with an HTTP round trip between them, and the daemon
 * runs several role workers at once. And all five openrouter models as "ok" while `OPENROUTER_API_KEY` was
 * empty in `.env`, which is exactly what an idle cloud tier looks like.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseProvidersConfig } from '../src/config.js';
import { Router } from '../src/router.js';
import { QuotaTracker } from '../src/quota.js';
import { renderQuotaMarkdown } from '../src/metrics.js';
import { openMemoryDb, EventLog } from '@cubicle/core';
import { allowProviderBaseUrl } from '../src/test-guard.js';

const model = (id: string, rpd: number) => ({ id, tier: 'cheap' as const, tools: 'native' as const, limits: { rpm: 0, rpd, tpm: 0, tpd: 0 }, enabled: true, context: 8192, max_prompt_tokens: 8000, max_output_tokens: 1024, thinking: false });

describe('the daily limit is never exceeded (W4-13)', () => {
  it('a call in flight counts against the limit before it has been recorded', () => {
    const db = openMemoryDb();
    const q = new QuotaTracker(db);
    const m = model('flash', 20);
    for (let i = 0; i < 19; i++) q.record('gemini', 'flash', 10, 2, true);
    // 19/20 recorded: one more fits.
    expect(q.hasHeadroom('gemini', m, 100).ok).toBe(true);
    // Worker A dials. Worker B reads the very same table a millisecond later and must not see room.
    const release = q.reserve('gemini', 'flash');
    expect(q.reserved('gemini', 'flash')).toBe(1);
    expect(q.hasHeadroom('gemini', m, 100)).toEqual({ ok: false, reason: 'rpd' });
    // A's call lands and the slot becomes a recorded call. Still 20/20, still no room — and never 21.
    q.record('gemini', 'flash', 10, 2, true);
    release();
    expect(q.status('gemini', m).rpd_used).toBe(20);
    expect(q.hasHeadroom('gemini', m, 100)).toEqual({ ok: false, reason: 'rpd' });
    db.close();
  });

  it('a request that throws gives its slot back, so one network error does not cost the rest of the day', () => {
    const db = openMemoryDb();
    const q = new QuotaTracker(db);
    const m = model('flash', 20);
    const release = q.reserve('gemini', 'flash');
    release();
    release();                                       // releasing twice is safe: the `finally` may follow a `catch`
    expect(q.reserved('gemini', 'flash')).toBe(0);
    expect(q.hasHeadroom('gemini', m, 100).ok).toBe(true);
    db.close();
  });
});

describe('chat() never dials past the daily limit, however many workers ask at once (W4-13)', () => {
  let server: http.Server; let base: string;
  /** Every model this server was actually asked for, in order. */
  const dialled: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        dialled.push(JSON.parse(data || '{}').model as string);
        // Slowly, so the second request is genuinely in the window the reservation closes.
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
        }, 40);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    allowProviderBaseUrl(base);
  });
  afterAll(() => server.close());

  it('two workers racing on the last free call of the day spend it once', async () => {
    dialled.length = 0;
    const cfg = parseProvidersConfig(`
cascade: [p]
providers:
  - id: p
    base_url: ${base}/v1
    api_key_env: P_KEY
    models:
      - { id: big, tier: strong, tools: native, limits: { rpd: 1 } }
      - { id: small, tier: cheap, tools: native, limits: { rpd: 50 } }
`);
    const db = openMemoryDb();
    const events = new EventLog(db, mkdtempSync(path.join(tmpdir(), 'cubicle-quota-truth-')));
    const router = new Router(cfg, new QuotaTracker(db), { env: { P_KEY: 'x' }, events });

    const both = await Promise.all([
      router.chat({ tier: 'strong', needsTools: false }, { messages: [{ role: 'user', content: 'hi' }] }),
      router.chat({ tier: 'strong', needsTools: false }, { messages: [{ role: 'user', content: 'hi' }] }),
    ]);
    // `big` has one call a day. Exactly one of the two got it; the other cascaded to `small` rather than
    // dialling a model with no headroom left.
    expect(dialled.filter((m) => m === 'big')).toHaveLength(1);
    expect(both.map((r) => r.model).sort()).toEqual(['big', 'small']);
    db.close();
  });
});

describe('Metrics/quota.md says "no key" rather than "ok" (W4-13)', () => {
  const statusRow = (md: string, model: string) => md.split('\n').find((l) => l.includes(`| ${model} |`))!;

  it('a provider whose api_key_env is unset reads "no key" on every one of its models', () => {
    const cfg = parseProvidersConfig(`
cascade: [gemini, openrouter]
providers:
  - id: gemini
    base_url: https://example.test/v1
    api_key_env: GEMINI_API_KEY
    models:
      - { id: gemini-3.5-flash, tier: strong, tools: native, limits: { rpd: 250 } }
  - id: openrouter
    base_url: https://example.test/or
    api_key_env: OPENROUTER_API_KEY
    models:
      - { id: free-a, tier: medium, tools: native, limits: { rpd: 250 } }
      - { id: free-b, tier: cheap, tools: native, limits: { rpd: 250 } }
`);
    const db = openMemoryDb();
    // The exact shape of the live `.env`: gemini keyed, openrouter empty.
    const router = new Router(cfg, new QuotaTracker(db), { env: { GEMINI_API_KEY: 'g', OPENROUTER_API_KEY: '' } });
    const md = renderQuotaMarkdown(router.quotaSnapshot(), new Date('2026-09-14T12:00:00.000Z'));

    expect(statusRow(md, 'free-a')).toContain('| no key |');
    expect(statusRow(md, 'free-b')).toContain('| no key |');
    expect(statusRow(md, 'free-a')).not.toContain('| ok |');
    // …and a provider that does have its key is unchanged.
    expect(statusRow(md, 'gemini-3.5-flash')).toContain('| ok |');
    // The header says what "no key" means, so the owner does not have to guess.
    expect(md).toContain('API key is not set');
    db.close();
  });
});
