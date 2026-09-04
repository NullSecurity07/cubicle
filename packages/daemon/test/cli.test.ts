import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';

let chunks: unknown[] = [];
let server: http.Server;
let base: string;
let dir: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-cli-'));
  process.env.ALPHA_KEY = 'k';
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.ALPHA_KEY; });

function providersFile(): string {
  const p = path.join(dir, 'providers.yaml');
  writeFileSync(p, `cascade: [alpha]\nproviders:\n  - id: alpha\n    base_url: ${base}/alpha/v1\n    api_key_env: ALPHA_KEY\n    models:\n      - { id: alpha-strong, tier: strong, tools: native, context: 100000, limits: { rpm: 100, rpd: 1000, tpm: 1000000 } }\n`);
  return p;
}

/** Everything the command printed while `fn` ran, in order: raw stdout writes and console.log lines alike. */
async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const writes: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  const realLog = console.log;
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = ((c: string | Uint8Array) => {
    writes.push(typeof c === 'string' ? c : Buffer.from(c).toString());
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => { writes.push(args.map(String).join(' ') + '\n'); };
  try { await fn(); } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = realWrite;
    console.log = realLog;
  }
  return writes;
}

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: finish }] });

describe('cubicle chat streams (D9)', () => {
  it('writes each content chunk to stdout as it arrives, then the provider/model line', async () => {
    chunks = [delta({ content: 'Hel' }), delta({ content: 'lo ' }), delta({ content: 'world' }, 'stop'), { id: 'x', choices: [], usage: { prompt_tokens: 4, completion_tokens: 3 } }];
    const writes = await captureStdout(() => main(['chat', '--tier', 'strong', '--providers', providersFile(), 'say hello']));

    expect(process.exitCode ?? 0).toBe(0);
    // Streamed, not printed in one go: each delta reached stdout on its own.
    expect(writes).toContain('Hel');
    expect(writes).toContain('lo ');
    expect(writes).toContain('world');
    const all = writes.join('');
    expect(all).toContain('Hello world');
    expect(all).toContain('alpha/alpha-strong');
    expect(all).toContain('tokens=4/3');
  });
});
