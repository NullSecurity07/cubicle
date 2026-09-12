import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';
import { scaffoldVault, Vault, createJob, readJob, updateJob } from '@cubicle/core';
import { allowProviderBaseUrl } from '@cubicle/router';

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
  // The stub above is this process answering itself, not a provider: vouch for it so the repo-wide guard in
  // packages/router/test-setup.ts lets `cubicle chat`'s real Router reach it. Nothing else is allowed out.
  allowProviderBaseUrl(base);
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

describe('cubicle job cancel (M3)', () => {
  /** A vault with one job in `status`, and the ids needed to inspect it afterwards. */
  async function vaultWithJob(status: 'queued' | 'running'): Promise<{ id: string }> {
    const { vault } = await scaffoldVault(dir);
    const id = createJob(vault, { type: 'research', title: 'r', assigned: 'cmo', goal: 'g' }, 'cto');
    if (status === 'running') updateJob(vault, id, { status, checkpoint_step: 2 }, 'cmo');
    vault.close();
    return { id };
  }

  it('cancels a queued job and announces it once', async () => {
    const { id } = await vaultWithJob('queued');
    const out = await captureStdout(() => main(['job', 'cancel', id, '--vault', dir]));
    expect(out.join('')).toContain(`cancelled ${id}`);
    const vault = Vault.open(dir);
    try {
      expect(readJob(vault, id)!.data.status).toBe('cancelled');
      expect(vault.events.count('job.cancelled')).toBe(1);
    } finally { vault.close(); }
  });

  it('cancels a running job by writing the flag, leaving the single announcement to its loop', async () => {
    const { id } = await vaultWithJob('running');
    await captureStdout(() => main(['job', 'cancel', id, '--vault', dir]));
    const vault = Vault.open(dir);
    try {
      const j = readJob(vault, id)!;
      expect(j.data.status).toBe('cancelled');
      expect(j.body).toContain('cancelled (cancelled by owner (cli))');
      // The harness loop emits when the job stops at its next tool step; emitting here too logged the stop twice.
      expect(vault.events.count('job.cancelled')).toBe(0);
    } finally { vault.close(); }
  });
});
