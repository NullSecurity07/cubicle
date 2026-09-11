import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, RoleFrontmatter } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools, archivePath, archiveNote, type ToolContext } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault; let reg: ToolRegistry;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-archive-')); vault = (await scaffoldVault(dir)).vault; reg = new ToolRegistry().registerAll(phase3Tools()); });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); });

const role = (id: string) => RoleFrontmatter.parse(vault.readNoteOrNull(`Roles/${id}.md`)!.data);
const ctx = (): ToolContext => ({ vault, events: vault.events, roleId: 'intelligence_analyst', role: role('intelligence_analyst'), jobId: 'job_i', config: cfg, env: { CUBICLE_ALLOW_LOCAL_FETCH: '1' }, workspace: '.cubicle/workspace/job_i', now: () => new Date('2026-09-11T09:00:00.000Z'), scheduler: { enqueue: (j) => createJob(vault, j, 'daemon') } });

describe('archive path and note', () => {
  it('is dated, host-readable and url-unique', () => {
    const p = archivePath('https://www.example.com/pricing?x=1', '2026-09-11');
    expect(p).toMatch(/^Research\/archive\/2026-09-11-example\.com-[0-9a-f]{8}\.md$/);
    expect(archivePath('https://www.example.com/pricing?x=1', '2026-09-11')).toBe(p);
    expect(archivePath('https://www.example.com/other', '2026-09-11')).not.toBe(p);
  });
  it('strips the port from the host', () => {
    const p = archivePath('https://example.com:8443/pricing', '2026-09-11');
    expect(p).toMatch(/^Research\/archive\/2026-09-11-example\.com-[0-9a-f]{8}\.md$/);
  });
  it('the note carries the provenance a citation needs', () => {
    const n = archiveNote({ url: 'https://example.com/a', fetched: '2026-09-11T09:00:00.000Z', status: 200, contentType: 'text/html', title: 'Example pricing' }, 'body text');
    expect(n).toMatch(/^url: https:\/\/example\.com\/a$/m);
    expect(n).toMatch(/^fetched: 2026-09-11T09:00:00\.000Z$/m);
    expect(n).toMatch(/^status: 200$/m);
    expect(n).toMatch(/^title: Example pricing$/m);
    expect(n).toMatch(/body text/);
  });
});

describe('http.fetch { archive: true }', () => {
  it('snapshots the page into Research/archive/ and returns the path', async () => {
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const u = String(input);
      if (u.endsWith('/robots.txt')) return new Response('', { status: 404 });
      return new Response('<html><head><title>Example pricing</title></head><body><p>Ten dollars</p></body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    });
    const r = await reg.get('http.fetch')!.handler({ url: 'https://example.com/pricing', archive: true } as never, ctx());
    expect(r.ok).toBe(true);
    const p = (r.data as { archive?: string }).archive!;
    expect(p).toMatch(/^Research\/archive\/2026-09-11-example\.com-[0-9a-f]{8}\.md$/);
    expect(r.text).toMatch(new RegExp(`archived at ${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const note = vault.readText(p);
    expect(note).toMatch(/title: Example pricing/);
    expect(note).toMatch(/Ten dollars/);
  });

  it('without archive it writes nothing, and a failed fetch is never archived', async () => {
    vi.stubGlobal('fetch', async (input: string | URL) => {
      if (String(input).endsWith('/robots.txt')) return new Response('', { status: 404 });
      return new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } });
    });
    const plain = await reg.get('http.fetch')!.handler({ url: 'https://example.com/pricing' } as never, ctx());
    expect((plain.data as { archive?: string }).archive).toBeUndefined();
    const failed = await reg.get('http.fetch')!.handler({ url: 'https://example.com/pricing', archive: true } as never, ctx());
    expect(failed.ok).toBe(false);
    expect((failed.data as { archive?: string }).archive).toBeUndefined();
    expect(vault.list('Research/archive', { ext: '.md' })).toEqual([]);
  });

  it('a successful fetch is still returned when the archive write fails', async () => {
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const u = String(input);
      if (u.endsWith('/robots.txt')) return new Response('', { status: 404 });
      return new Response('<html><head><title>Example pricing</title></head><body><p>Ten dollars</p></body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    });
    const spy = vi.spyOn(vault, 'writeText').mockImplementation(() => { throw new Error('disk full'); });
    const r = await reg.get('http.fetch')!.handler({ url: 'https://example.com/pricing', archive: true } as never, ctx());
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Ten dollars/);
    expect(r.text).toMatch(/archive failed: disk full/);
    expect((r.data as { archive?: string }).archive).toBeUndefined();
    spy.mockRestore();
  });
});
