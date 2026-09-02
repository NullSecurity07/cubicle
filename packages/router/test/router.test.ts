import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { openMemoryDb, EventLog } from '@cubicle/core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseProvidersConfig } from '../src/config.js';
import { QuotaTracker } from '../src/quota.js';
import { Router, NoModelAvailableError } from '../src/router.js';
import { providersTest } from '../src/providers-cli.js';

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

  it('downgrades tier only after same-tier options are exhausted, emitting router.downgraded', async () => {
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

  it('falls all the way to the local floor when cloud keys are missing', async () => {
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
