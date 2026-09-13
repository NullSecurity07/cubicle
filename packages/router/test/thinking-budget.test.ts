import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openMemoryDb, EventLog } from '@cubicle/core';
import { parseProvidersConfig, loadProvidersConfig } from '../src/config.js';
import { QuotaTracker } from '../src/quota.js';
import { Router, THINKING_MIN_VISIBLE_TOKENS } from '../src/router.js';
import { allowProviderBaseUrl } from '../src/test-guard.js';
import { repoRoot } from '@cubicle/core';

/**
 * FR-2 (2026-09-13 first-run fixes): a thinking model bills its reasoning to the output budget, so the
 * caller's `maxTokens` must not become the provider's cap, and a reply that stopped at `length` with nothing
 * but a fragment to show for it is not an answer.
 */

/** What the stub answers with, per model id. */
type Behaviour = { content?: string; finish?: string; completion?: number };
const behaviours = new Map<string, Behaviour>();
/** Every request body the stub received, in order. */
const seen: { model: string; max_tokens: number | undefined }[] = [];
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = JSON.parse(data || '{}') as { model: string; max_tokens?: number };
      seen.push({ model: body.model, max_tokens: body.max_tokens });
      const b = behaviours.get(body.model) ?? {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x',
        choices: [{ index: 0, message: { role: 'assistant', content: b.content ?? 'a full answer' }, finish_reason: b.finish ?? 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: b.completion ?? 20 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  allowProviderBaseUrl(base);
});
afterAll(() => server.close());
beforeEach(() => { behaviours.clear(); seen.length = 0; });

const config = () => parseProvidersConfig(`
cascade: [thinker, plain]
providers:
  - id: thinker
    base_url: ${base}/thinker/v1
    api_key_env: T_KEY
    models:
      - { id: think-strong, thinking: true, tier: strong, tools: native, context: 100000, max_prompt_tokens: 8000, max_output_tokens: 4096, limits: { rpm: 100 } }
  - id: plain
    base_url: ${base}/plain/v1
    api_key_env: P_KEY
    models:
      - { id: plain-strong, tier: strong, tools: native, context: 100000, max_prompt_tokens: 8000, max_output_tokens: 4096, limits: { rpm: 100 } }
`);

function mk() {
  const db = openMemoryDb();
  const events = new EventLog(db, mkdtempSync(path.join(tmpdir(), 'cubicle-thinking-')));
  return { router: new Router(config(), new QuotaTracker(db), { env: { T_KEY: 't', P_KEY: 'p' }, events, backoffBaseMs: 10 }), events };
}

describe('config: thinking', () => {
  it('parses `thinking: true` and defaults to false', () => {
    const cfg = config();
    expect(cfg.providers[0].models[0].thinking).toBe(true);
    expect(cfg.providers[1].models[0].thinking).toBe(false);
  });

  it('config/providers.yaml marks the Gemini 3.x flash models as thinking, and nothing else', () => {
    const shipped = loadProvidersConfig(path.join(repoRoot(), 'config', 'providers.yaml'), {});
    const thinking = shipped.providers.flatMap((p) => p.models.filter((m) => m.thinking).map((m) => m.id)).sort();
    expect(thinking).toEqual(['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash']);
  });
});

describe('Router output cap for thinking models (FR-2)', () => {
  it('sends the model’s full max_output_tokens to a thinking model and min(maxTokens, cap) to a plain one', async () => {
    const { router } = mk();
    await router.chat({ tier: 'strong', needsTools: false }, { messages: [{ role: 'user', content: 'hi' }], maxTokens: 800 });
    expect(seen).toEqual([{ model: 'think-strong', max_tokens: 4096 }]);

    seen.length = 0;
    await router.chat({ tier: 'strong', needsTools: false, exclude: ['thinker'] }, { messages: [{ role: 'user', content: 'hi' }], maxTokens: 800 });
    expect(seen).toEqual([{ model: 'plain-strong', max_tokens: 800 }]);

    // A caller asking for more than the model can produce is still capped by the model.
    seen.length = 0;
    await router.chat({ tier: 'strong', needsTools: false, exclude: ['thinker'] }, { messages: [{ role: 'user', content: 'hi' }], maxTokens: 99_000 });
    expect(seen).toEqual([{ model: 'plain-strong', max_tokens: 4096 }]);
  });

  it('a thinking model cut off at `length` with only a fragment falls through to the next candidate, once', async () => {
    behaviours.set('think-strong', { content: 'Here are three ideas:', finish: 'length', completion: 20 });
    const { router, events } = mk();
    const r = await router.chat({ tier: 'strong', needsTools: false }, { messages: [{ role: 'user', content: 'surprise me' }], maxTokens: 800 });
    expect(r.model).toBe('plain-strong');
    expect(r.content).toBe('a full answer');
    // One call to the thinking model, not a retry of the same model.
    expect(seen.map((s) => s.model)).toEqual(['think-strong', 'plain-strong']);
    const warn = events.last('daemon.warning')!;
    expect(warn.payload.where).toBe('thinking_truncated');
    expect(warn.payload.finish_reason).toBe('length');
    // The call itself is still recorded with its finish reason, as before.
    const calls = events.query({ types: ['router.call'] });
    expect(calls.map((e) => e.payload.finish_reason)).toEqual(['length', 'stop']);
  });

  it('keeps a long answer that merely ran out of room, and a plain model’s short `length` reply', async () => {
    const long = 'word '.repeat(THINKING_MIN_VISIBLE_TOKENS * 2);
    behaviours.set('think-strong', { content: long, finish: 'length', completion: 400 });
    const { router } = mk();
    const r = await router.chat({ tier: 'strong', needsTools: false }, { messages: [{ role: 'user', content: 'hi' }] });
    expect(r.model).toBe('think-strong');
    expect(r.finishReason).toBe('length');

    behaviours.set('plain-strong', { content: 'cut', finish: 'length', completion: 3 });
    seen.length = 0;
    const p = await mk().router.chat({ tier: 'strong', needsTools: false, exclude: ['thinker'] }, { messages: [{ role: 'user', content: 'hi' }] });
    expect(p.model).toBe('plain-strong');
    expect(p.content).toBe('cut');
  });

  it('returns the fragment rather than throwing when no other candidate answers', async () => {
    behaviours.set('think-strong', { content: 'half a', finish: 'length', completion: 5 });
    behaviours.set('plain-strong', { content: '', finish: 'stop', completion: 0 });
    const { router } = mk();
    const r = await router.chat({ tier: 'strong', needsTools: false }, { messages: [{ role: 'user', content: 'hi' }] });
    // Both candidates were unusable; the caller gets the fragment, not the reply with nothing in it.
    expect(seen.map((s) => s.model)).toEqual(['think-strong', 'plain-strong']);
    expect(r.model).toBe('think-strong');
    expect(r.content).toBe('half a');
  });
});
