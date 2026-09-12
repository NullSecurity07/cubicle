import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import { openMemoryDb, EventLog } from '@cubicle/core';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseProvidersConfig } from '../src/config.js';
import { QuotaTracker } from '../src/quota.js';
import { Router, NoModelAvailableError } from '../src/router.js';
import { providersTest } from '../src/providers-cli.js';
import { allowProviderBaseUrl } from '../src/test-guard.js';

type Behaviour = { status?: number; retryAfter?: string; content?: string; toolCall?: boolean; fail?: number };
const behaviours = new Map<string, Behaviour>();
const hits: string[] = [];
let server: http.Server;
let base: string;

function reply(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = JSON.parse(data || '{}');
      const key = `${req.headers['x-provider'] ?? req.url}|${body.model}`;
      hits.push(`${req.url}|${body.model}`);
      const b = behaviours.get(body.model) ?? {};
      if (b.status === 429) return reply(res, 429, { error: { message: 'slow down' } }, b.retryAfter ? { 'retry-after': b.retryAfter } : {});
      if (b.status && b.status >= 400) return reply(res, b.status, { error: { message: 'boom' } });
      const msg: Record<string, unknown> = { role: 'assistant', content: b.content ?? 'pong' };
      if (b.toolCall || (body.tools && b.toolCall !== false)) msg.tool_calls = [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{"value":1}' } }];
      return reply(res, 200, { id: 'x', choices: [{ index: 0, message: msg, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  // The stub above is this process answering itself, not a provider: vouch for it so the repo-wide guard in
  // packages/router/test-setup.ts lets the Router reach it. Every other destination stays refused.
  allowProviderBaseUrl(base);
});
afterAll(() => server.close());

function config(overrides = '') {
  return parseProvidersConfig(`
cascade: [alpha, beta, local]
providers:
  - id: alpha
    base_url: ${base}/alpha/v1
    api_key_env: ALPHA_KEY
    models:
      - { id: alpha-strong, tier: strong, tools: native, context: 100000, max_prompt_tokens: 8000, limits: { rpm: 2, rpd: 100, tpm: 100000 } }
      - { id: alpha-cheap, tier: cheap, tools: native, context: 100000, limits: { rpm: 100 } }
  - id: beta
    base_url: ${base}/beta/v1
    api_key_env: BETA_KEY
    models:
      - { id: beta-strong, tier: strong, tools: json, context: 32000, limits: { rpm: 100 } }
  - id: local
    base_url: ${base}/local/v1
    privacy: local
    models:
      - { id: local-small, tier: local, tools: json, context: 8000, limits: {} }
${overrides}`);
}

const env = { ALPHA_KEY: 'a', BETA_KEY: 'b' };

function mk(cfg = config(), e: NodeJS.ProcessEnv = env) {
  const db = openMemoryDb();
  const events = new EventLog(db, mkdtempSync(path.join(tmpdir(), 'cubicle-router-')));
  const quota = new QuotaTracker(db);
  return { router: new Router(cfg, quota, { env: e, events, backoffBaseMs: 50 }), events, quota };
}

describe('Router', () => {
  it('routes to the first same-tier model in cascade order', async () => {
    behaviours.clear();
    const { router } = mk();
    const r = await router.chat({ tier: 'strong', needsTools: false }, { messages: [{ role: 'user', content: 'hi' }] });
    expect(r.provider).toBe('alpha');
    expect(r.model).toBe('alpha-strong');
    expect(r.downgraded).toBe(false);
    expect(r.content).toBe('pong');
  });

  it('cascades on 429, marks cooling, honours Retry-After, no downgrade event for same tier', async () => {
    behaviours.clear();
    behaviours.set('alpha-strong', { status: 429, retryAfter: '30' });
    const { router, events, quota } = mk();
    const r = await router.chat({ tier: 'strong', needsTools: false }, { messages: [{ role: 'user', content: 'hi' }] });
    expect(r.provider).toBe('beta');
    expect(r.downgraded).toBe(false);
    expect(quota.coolingUntil('alpha', 'alpha-strong')).not.toBeNull();
    expect(events.count('router.downgraded')).toBe(0);
    expect(events.count('router.call')).toBe(1);
    // Cooling model is skipped without a network call on the next request
    const before = hits.length;
    const r2 = await router.chat({ tier: 'strong', needsTools: false }, { messages: [{ role: 'user', content: 'hi' }] });
    expect(r2.provider).toBe('beta');
    expect(hits.slice(before).some((h) => h.includes('alpha-strong'))).toBe(false);
  });

  it('downgrades tier only after same-tier options are exhausted, emitting router.downgraded (acceptance test 4, same-tier first)', async () => {
    behaviours.clear();
    behaviours.set('alpha-strong', { status: 429 });
    behaviours.set('beta-strong', { status: 503 });
    const { router, events } = mk();
    const r = await router.chat({ tier: 'strong', needsTools: false }, { messages: [{ role: 'user', content: 'hi' }] });
    expect(r.provider).toBe('alpha');
    expect(r.model).toBe('alpha-cheap');
    expect(r.downgraded).toBe(true);
    expect(events.count('router.downgraded')).toBe(1);
    const ev = events.last('router.downgraded')!;
    expect(ev.payload.requested_tier).toBe('strong');
    expect(ev.payload.chosen_tier).toBe('cheap');
  });

  it('falls all the way to the local floor when cloud keys are missing (acceptance test 4, synthetic cascade)', async () => {
    behaviours.clear();
    const { router, events } = mk(config(), {});
    const r = await router.chat({ tier: 'strong', needsTools: true }, { messages: [{ role: 'user', content: 'hi' }] });
    expect(r.provider).toBe('local');
    expect(r.downgraded).toBe(true);
    expect(events.count('router.downgraded')).toBe(1);
  });

  it('respects rpm quota headroom', async () => {
    behaviours.clear();
    const { router } = mk();
    const req = { tier: 'strong' as const, needsTools: false };
    const a = await router.chat(req, { messages: [{ role: 'user', content: 'hi' }] });
    const b = await router.chat(req, { messages: [{ role: 'user', content: 'hi' }] });
    const c = await router.chat(req, { messages: [{ role: 'user', content: 'hi' }] });
    expect([a.model, b.model, c.model]).toEqual(['alpha-strong', 'alpha-strong', 'beta-strong']);
  });

  it('privacy: local forces the local provider', async () => {
    behaviours.clear();
    const { router } = mk();
    const r = await router.chat({ tier: 'strong', needsTools: false, privacy: 'local' }, { messages: [{ role: 'user', content: 'hi' }] });
    expect(r.provider).toBe('local');
  });

  it('uses native tools on native models and prompt-based JSON tools on json models', async () => {
    behaviours.clear();
    behaviours.set('beta-strong', { content: '```json\n{"tool":"ping","args":{"value":2,}}\n```', toolCall: false });
    const { router } = mk();
    const tools = [{ name: 'ping', description: 'ping', parameters: { type: 'object', properties: { value: { type: 'number' } } } }];
    const native = await router.chat({ tier: 'strong', needsTools: true }, { messages: [{ role: 'user', content: 'go' }], tools });
    expect(native.model).toBe('alpha-strong');
    expect(native.parsedToolCalls).toEqual([{ name: 'ping', args: { value: 1 } }]);
    const json = await router.chat({ tier: 'strong', needsTools: true, exclude: ['alpha'] }, { messages: [{ role: 'user', content: 'go' }], tools });
    expect(json.model).toBe('beta-strong');
    expect(json.parsedToolCalls).toEqual([{ name: 'ping', args: { value: 2 } }]);
  });

  it('throws NoModelAvailableError when everything is down', async () => {
    behaviours.clear();
    for (const m of ['alpha-strong', 'alpha-cheap', 'beta-strong', 'local-small']) behaviours.set(m, { status: 500 });
    const { router } = mk();
    await expect(router.chat({ tier: 'cheap', needsTools: false }, { messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(NoModelAvailableError);
  });

  it('missingKeyProviders lists enabled cascade providers whose api_key_env is unset, in cascade order, never the keyless local floor', () => {
    expect(mk(config(), {}).router.missingKeyProviders()).toEqual([{ id: 'alpha', env: 'ALPHA_KEY' }, { id: 'beta', env: 'BETA_KEY' }]);
    expect(mk(config(), { ALPHA_KEY: 'a', BETA_KEY: '   ' }).router.missingKeyProviders()).toEqual([{ id: 'beta', env: 'BETA_KEY' }]); // blank counts as unset, like apiKeyFor
    expect(mk(config(), env).router.missingKeyProviders()).toEqual([]);
    // A disabled provider is not missing anything: it was never going to be dialled.
    expect(mk(config('  - id: gamma\n    enabled: false\n    base_url: http://127.0.0.1:1/v1\n    api_key_env: GAMMA_KEY\n    models: []\n'), env).router.missingKeyProviders()).toEqual([]);
  });

  it('providersTest reports per-model status', async () => {
    behaviours.clear();
    behaviours.set('beta-strong', { status: 401 });
    const rows = await providersTest(config(), env, { toolsCheck: true });
    const byModel = Object.fromEntries(rows.map((r) => [r.model, r]));
    expect(byModel['alpha-strong'].ok).toBe(true);
    expect(byModel['alpha-strong'].detail).toContain('tools:ok');
    expect(byModel['beta-strong'].ok).toBe(false);
    expect(byModel['beta-strong'].detail).toContain('401');
  });
});

/**
 * Acceptance test 4, against the file that actually ships. The synthetic cascade above proves the *mechanics*
 * (same tier first, then one downgrade); this proves the *configuration*: with `config/providers.yaml` as
 * written, a strong request walks gemini → groq → openrouter → ollama and lands on the local floor exactly
 * once, whether the cloud is refusing calls or has no key at all. Every base_url is rebound to a loopback
 * server, so the test cannot reach a provider even if a key is exported in the environment.
 * (`cerebras` and `xai` ship disabled and are absent from `cascade:`, so they are not in the chain.)
 */
describe('the shipped cascade (acceptance test 4, config/providers.yaml)', () => {
  const CASCADE = ['gemini', 'groq', 'openrouter', 'ollama'];
  const KEYS = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', OPENROUTER_API_KEY: 'o' };
  let fakes: http.Server[] = [];
  let undoAllowances: (() => void)[] = [];
  let seen: string[] = [];

  /** Parse the shipped file and point every provider at its own loopback server. Cloud providers answer with
   *  `cloudStatus`; the local floor always answers, the way an Ollama on the machine would. */
  async function shipped(cloudStatus: number) {
    seen = [];
    const cfg = parseProvidersConfig(readFileSync(path.resolve(__dirname, '../../../config/providers.yaml'), 'utf8'));
    for (const p of cfg.providers) {
      const isCloud = !!p.api_key_env;
      const s = http.createServer((req, res) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => {
          seen.push(`${p.id}/${(JSON.parse(data || '{}') as { model?: string }).model ?? '?'}`);
          if (isCloud) return reply(res, cloudStatus, { error: { message: 'down' } });
          reply(res, 200, { id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
        });
      });
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
      fakes.push(s);
      p.base_url = `http://127.0.0.1:${(s.address() as { port: number }).port}/v1`;
      // Each provider of the *shipped* cascade is standing in on its own loopback port here — ollama included,
      // which is the one that would otherwise find a real model server on this machine. Vouch for the stub, and
      // take the allowance back with the server in `afterEach`, so it can never outlive the port it names.
      undoAllowances.push(allowProviderBaseUrl(p.base_url));
    }
    return cfg;
  }

  afterEach(() => { for (const s of fakes) s.close(); fakes = []; for (const undo of undoAllowances) undo(); undoAllowances = []; });

  it('walks gemini → groq → openrouter → ollama when the cloud is down (acceptance test 4)', async () => {
    const cfg = await shipped(503);
    const { router, events } = mk(cfg, KEYS);
    expect(router.availableProviders().map((p) => p.id)).toEqual(CASCADE);
    const r = await router.chat({ tier: 'strong', needsTools: true }, { messages: [{ role: 'user', content: 'hi' }] });
    expect([...new Set(seen.map((h) => h.split('/')[0]))]).toEqual(CASCADE);
    expect(seen[0]).toBe('gemini/gemini-3.5-flash');           // the one strong model, tried first
    expect(seen[seen.length - 1]).toBe('ollama/qwen2.5:7b');   // the local floor, tried last
    expect(r.provider).toBe('ollama');
    expect(r.tier).toBe('local');
    expect(r.downgraded).toBe(true);
    expect(events.count('router.downgraded')).toBe(1);
    expect(events.last('router.downgraded')!.payload.requested_tier).toBe('strong');
  });

  it('reaches the local floor without a single cloud call when every api_key_env is unset (acceptance test 4)', async () => {
    const cfg = await shipped(503);
    const { router, events } = mk(cfg, {});   // no GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, …
    expect(router.availableProviders().map((p) => p.id)).toEqual(['ollama']);
    const r = await router.chat({ tier: 'strong', needsTools: true }, { messages: [{ role: 'user', content: 'hi' }] });
    expect(seen).toEqual(['ollama/qwen2.5:7b']);               // keyless providers are never dialled
    expect(r.provider).toBe('ollama');
    expect(r.downgraded).toBe(true);
    expect(events.count('router.downgraded')).toBe(1);
  });
});

describe('an aborted request is the caller giving up, not a provider failing', () => {
  it('a signal that is already dead dials nobody, records nothing and does not cascade', async () => {
    behaviours.clear();
    const before = hits.length;
    const { router, events, quota } = mk();
    const ac = new AbortController();
    ac.abort();   // the gap between two candidates, or a job cancelled while its request was assembled

    await expect(router.chat({ tier: 'strong', needsTools: false }, { messages: [{ role: 'user', content: 'hi' }], signal: ac.signal }))
      .rejects.toThrow(/aborted this request before it was sent/);

    expect(hits.length).toBe(before);                       // no model was dialled at all
    expect(events.count('router.call')).toBe(0);
    expect(events.count('daemon.warning')).toBe(0);         // an abort is not an outage
    expect(events.count('quota.updated')).toBe(0);
    expect(quota.coolingUntil('alpha', 'alpha-strong')).toBeNull();
  });
});

describe('overloaded models are skipped for a while (503 high demand)', () => {
  it('a 503 marks the model cooling so the next call cascades without paying for the failed round-trip', async () => {
    behaviours.clear();
    behaviours.set('alpha-strong', { status: 503 });
    const { router, events, quota } = mk();
    const r = await router.chat({ tier: 'strong', needsTools: false }, { messages: [{ role: 'user', content: 'hi' }] });
    expect(r.provider).toBe('beta');
    expect(quota.coolingUntil('alpha', 'alpha-strong')).not.toBeNull();
    const ev = events.query({ types: ['quota.updated'] }).find((e) => e.payload.reason === '503');
    expect(ev?.payload.model).toBe('alpha-strong');
    const before = hits.length;
    const r2 = await router.chat({ tier: 'strong', needsTools: false }, { messages: [{ role: 'user', content: 'hi' }] });
    expect(r2.provider).toBe('beta');
    expect(hits.slice(before).some((h) => h.includes('alpha-strong'))).toBe(false);
  });
});

describe('requests that cannot fit or cannot be parsed do not burn the cascade', () => {
  it('skips a model whose max_prompt_tokens is below the prompt instead of paying for a 413', async () => {
    behaviours.clear(); hits.length = 0;
    const cfg = config(`
  - id: tiny
    base_url: ${base}/tiny/v1
    api_key_env: ALPHA_KEY
    models:
      - { id: tiny-strong, tier: strong, tools: native, context: 100000, max_prompt_tokens: 300, limits: { rpm: 100 } }`);
    // Put tiny first in the cascade so it would be tried before alpha if size were ignored.
    cfg.cascade = ['tiny', 'alpha', 'beta', 'local'];
    const { router } = mk(cfg);
    const big = 'x'.repeat(4000); // ~1000 tokens, over tiny's 300-token cap but under alpha's 8000
    const res = await router.chat({ tier: 'strong', privacy: 'cloud' }, { messages: [{ role: 'user', content: big }] });
    expect(res.model).toBe('alpha-strong');
    expect(hits.some((h) => h.includes('tiny-strong'))).toBe(false);
  });

  it('a 400 (the provider rejected the request shape) skips the rest of that provider, not just that model', async () => {
    behaviours.clear(); hits.length = 0;
    behaviours.set('alpha-strong', { status: 400 });
    const { router, events } = mk(config(), { ALPHA_KEY: 'a' }); // beta has no key, so alpha-cheap is next in line
    const res = await router.chat({ tier: 'strong', privacy: 'cloud' }, { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.model).toBe('local-small');
    expect(hits.filter((h) => h.includes('alpha-cheap'))).toHaveLength(0);
    expect(events.last('router.downgraded')!.payload.tried).toContain('alpha/alpha-cheap (provider 400)');
  });

  it('router.call events carry the finish reason so empty replies can be diagnosed from the event log', async () => {
    behaviours.clear(); hits.length = 0;
    behaviours.set('alpha-strong', { content: '' , toolCall: false });
    const { router, events } = mk();
    await router.chat({ tier: 'strong', privacy: 'cloud' }, { messages: [{ role: 'user', content: 'hi' }] });
    const ev = events.last('router.call')!;
    expect(ev.payload.finish_reason).toBe('stop');
  });
});

describe('empty replies cascade instead of being retried on the same model', () => {
  // 2026-09-10: twelve replies with no content and no tool call, in runs of two or three at one step, each run
  // costing the job an attempt. Rebuilding those prompts reproduced nothing, so treat an empty reply as a failed
  // call: warn with the finish reason, move to the next candidate, and only return empty when every model did.
  it('an empty reply moves on to the next model and warns with the finish reason', async () => {
    behaviours.clear(); hits.length = 0;
    behaviours.set('alpha-strong', { content: '', toolCall: false });
    const { router, events } = mk();
    const res = await router.chat({ tier: 'strong', privacy: 'cloud' }, { messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'ping', description: 'p', parameters: { type: 'object', properties: {} } }] });
    expect(res.model).toBe('beta-strong');
    const warn = events.query({ types: ['daemon.warning'] }).find((e) => e.payload.where === 'empty_reply')!;
    expect(warn).toBeTruthy();
    expect(warn.payload.model).toBe('alpha-strong');
    expect(warn.payload.finish_reason).toBe('stop');
    expect(hits.map((h) => h.split('|')[1])).toEqual(['alpha-strong', 'beta-strong']); // one try each, no same-model retry
  });

  it('when every model replies empty the last empty reply is returned rather than NoModelAvailable', async () => {
    behaviours.clear(); hits.length = 0;
    for (const m of ['alpha-strong', 'beta-strong', 'alpha-cheap', 'local-small']) behaviours.set(m, { content: '', toolCall: false });
    const { router } = mk();
    const res = await router.chat({ tier: 'strong', privacy: 'cloud' }, { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('');
    expect(res.parsedToolCalls).toHaveLength(0);
  });

  it('the token estimate counts the tool schemas, which are part of the prompt the provider bills', () => {
    const { router } = mk();
    const tools = [{ name: 'big', description: 'x'.repeat(4000), parameters: { type: 'object', properties: {} } }];
    expect(router.estimatePrompt({ messages: [{ role: 'user', content: 'hi' }], tools })).toBeGreaterThan(1000);
    expect(router.estimatePrompt({ messages: [{ role: 'user', content: 'hi' }] })).toBeLessThan(10);
  });
});
