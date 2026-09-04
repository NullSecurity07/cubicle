import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openMemoryDb, EventLog } from '@cubicle/core';
import { parseProvidersConfig } from '../src/config.js';
import { QuotaTracker } from '../src/quota.js';
import { Router } from '../src/router.js';
import { chatOnce } from '../src/client.js';

/** Server-sent chunks for the next request, as raw objects; `[DONE]` is appended for you. */
let chunks: unknown[] = [];
let lastBody: Record<string, unknown> = {};
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      lastBody = JSON.parse(data || '{}');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());
beforeEach(() => { chunks = []; });

const env = { ALPHA_KEY: 'k' } as NodeJS.ProcessEnv;

function config() {
  return parseProvidersConfig(`
cascade: [alpha]
providers:
  - id: alpha
    base_url: ${base}/alpha/v1
    api_key_env: ALPHA_KEY
    models:
      - { id: alpha-strong, tier: strong, tools: native, context: 100000, limits: { rpm: 100, rpd: 1000, tpm: 1000000 } }
`);
}

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: finish }] });
const usageChunk = (prompt: number, completion: number) => ({ id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } });

describe('streaming completions (D9)', () => {
  it('calls onDelta once per content chunk and returns the joined text, finish reason and usage', async () => {
    chunks = [delta({ content: 'Hel' }), delta({ content: 'lo ' }), delta({ content: 'world' }, 'stop'), usageChunk(11, 3)];
    const seen: string[] = [];
    const res = await chatOnce(config().providers[0], 'alpha-strong', {
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (t) => seen.push(t),
    }, env);

    expect(seen).toEqual(['Hel', 'lo ', 'world']);
    expect(res.content).toBe('Hello world');
    expect(res.finishReason).toBe('stop');
    expect(res.usage).toEqual({ prompt_tokens: 11, completion_tokens: 3 });
    expect(lastBody.stream).toBe(true);
  });

  it('reassembles a tool call whose name and arguments arrive across several chunks', async () => {
    chunks = [
      delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'pi', arguments: '{"value"' } }] }),
      delta({ tool_calls: [{ index: 0, function: { name: 'ng', arguments: ':1' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }),
      delta({}, 'tool_calls'),
      usageChunk(7, 5),
    ];
    const seen: string[] = [];
    const res = await chatOnce(config().providers[0], 'alpha-strong', {
      messages: [{ role: 'user', content: 'call it' }],
      tools: [{ type: 'function', function: { name: 'ping', description: 'p', parameters: { type: 'object', properties: {} } } }],
      onDelta: (t) => seen.push(t),
    }, env);

    expect(seen).toEqual([]); // no content deltas in a pure tool-call reply
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'ping', arguments: '{"value":1}' }]);
    expect(JSON.parse(res.toolCalls[0].arguments)).toEqual({ value: 1 });
    expect(res.finishReason).toBe('tool_calls');
    expect(res.usage).toEqual({ prompt_tokens: 7, completion_tokens: 5 });
  });

  it('a caller that passes onDelta through the Router still streams, and the call is recorded as usual', async () => {
    chunks = [delta({ content: 'po' }), delta({ content: 'ng' }, 'stop'), usageChunk(4, 2)];
    const db = openMemoryDb();
    const events = new EventLog(db, mkdtempSync(path.join(tmpdir(), 'cubicle-client-')));
    const router = new Router(config(), new QuotaTracker(db), { env, events });
    const seen: string[] = [];

    const res = await router.chat({ tier: 'strong', needsTools: false }, { messages: [{ role: 'user', content: 'ping' }], onDelta: (t) => seen.push(t) });

    expect(seen).toEqual(['po', 'ng']);
    expect(res.content).toBe('pong');
    expect(res.provider).toBe('alpha');
    expect(events.count('router.call')).toBe(1);
    db.close();
  });
});
