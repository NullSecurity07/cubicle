import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob, listInbox, listJobs } from '@cubicle/core';
import { parseToolsConfig, resolveMode, ToolRegistry, createRoleToolClient, phase3Tools, unreadMessages, findAnswer, type ToolContext } from '../src/index.js';

let dir: string; let vault: Vault;
const cfgText = readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8');
const cfg = parseToolsConfig(cfgText);

beforeAll(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-tools-')); vault = (await scaffoldVault(dir)).vault; });
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

function role(id: string) { const n = parseNote(vault.readText(`Roles/${id}.md`)); return RoleFrontmatter.parse(n.data); }

function ctxFor(roleId: string, jobId: string | null = 'job_t'): ToolContext {
  return {
    vault, events: vault.events, roleId, role: role(roleId), jobId, config: cfg, env: {}, workspace: '.cubicle/workspace/job_t', now: () => new Date(),
    scheduler: { enqueue: (j) => createJob(vault, j, roleId) },
  };
}

describe('approval resolution', () => {
  it('tools.yaml → role tightens → owner overrides, never sticks', () => {
    expect(resolveMode('email.send', cfg)).toBe('ask');
    expect(resolveMode('vault.read', cfg, { approval_overrides: { 'vault.read': 'ask' } })).toBe('ask');
    expect(resolveMode('email.send', cfg, { approval_overrides: { 'email.send': 'auto' } })).toBe('ask'); // roles cannot loosen
    expect(resolveMode('email.send', cfg, undefined, { approvals: { 'email.send': 'auto' } })).toBe('auto'); // owner can
    const strict = parseToolsConfig(cfgText.replace('social.post:           { mode: ask', 'social.post:           { mode: never'));
    expect(resolveMode('social.post', strict, undefined, { approvals: { 'social.post': 'auto' } })).toBe('never');
  });
  it('filters tools per role with wildcards and role restrictions', () => {
    const reg = new ToolRegistry().registerAll(phase3Tools({ includeMock: true }));
    const names = reg.forRole(role('growth'), cfg).map((t) => t.name);
    expect(names).toContain('vault.read');
    expect(names).toContain('http.fetch');
    expect(names).not.toContain('mock.outbound');
    const eng = { ...role('engineer'), tools: ['shell.run', 'vault.*'] } as RoleFrontmatter;
    expect(reg.forRole(eng, cfg).map((t) => t.name)).toEqual(expect.arrayContaining(['vault.read', 'vault.write']));
    const growthShell = { ...role('growth'), tools: ['shell.run'] } as RoleFrontmatter;
    expect(reg.forRole(growthShell, cfg)).toEqual([]); // shell.run restricted to engineer (and not registered in phase 3 anyway)
  });
});

describe('MCP tools', () => {
  it('round-trips vault tools through the in-process MCP client, guarding owner-owned paths', async () => {
    const reg = new ToolRegistry().registerAll(phase3Tools({ includeMock: true }));
    const client = await createRoleToolClient(reg.forRole({ ...role('cto'), tools: ['vault.*', 'proposal.create', 'colleague.message', 'scheduler.request', 'skills.*', 'finish', 'mock.outbound'] } as RoleFrontmatter, cfg), ctxFor('cto'));
    try {
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('vault.write');
      expect(tools.find((t) => t.name === 'vault.read')!.parameters).toMatchObject({ type: 'object' });
      const w = await client.call('vault.write', { path: 'Plans/notes.md', content: '# notes' });
      expect(w.ok).toBe(true);
      expect(vault.readText('Plans/notes.md')).toBe('# notes');
      const r = await client.call('vault.read', { path: 'Plans/notes.md' });
      expect(r.text).toBe('# notes');
      const own = await client.call('vault.write', { path: 'Brand/name.md', content: 'x' });
      expect(own.ok).toBe(true);
      expect(own.text).toContain('proposed');
      const inbox = listInbox(vault);
      expect(inbox.some((n) => n.data.kind === 'file_change' && n.data.target === 'Brand/name.md')).toBe(true);
      expect(vault.readText('Brand/name.md')).not.toBe('x');
      const s = await client.call('vault.search', { query: 'constitution' });
      expect(s.text).toContain('Memory/constitution.md');
      const mock = await client.call('mock.outbound', { to: 'a@b.c', body: 'hi' }, { idempotencyKey: 'job_t:1:3' });
      expect(mock.sideEffectKey).toBe('job_t:1:3');
      const fin = await client.call('finish', { status: 'done', summary: 'ok' });
      expect(fin.finished).toBe(true);
    } finally { await client.close(); }
  });

  it('colleague.message writes Messages/, blocks on questions, hands off as jobs; answers are found', async () => {
    const reg = new ToolRegistry().registerAll(phase3Tools());
    const client = await createRoleToolClient(reg.forRole(role('engineer'), cfg), ctxFor('engineer'));
    try {
      const q = await client.call('colleague.message', { to: 'cto', body: 'Which framework?', kind: 'question' });
      expect(q.block).toMatchObject({ kind: 'message' });
      const unread = unreadMessages(vault, 'cto');
      expect(unread.length).toBe(1);
      expect(unread[0].from).toBe('engineer');
      expect(unreadMessages(vault, 'cto', true).length).toBe(1);
      expect(unreadMessages(vault, 'cto').length).toBe(0); // marked read
      const qid = (q.data as { id: string }).id;
      // CTO answers
      const cto = await createRoleToolClient(reg.forRole(role('cto'), cfg), ctxFor('cto'));
      await cto.call('colleague.message', { to: 'engineer', body: `re:${qid} Use Astro.`, kind: 'fyi' });
      await cto.close();
      expect(findAnswer(vault, 'engineer', qid)?.body).toContain('Use Astro');
      const h = await client.call('colleague.message', { to: 'coo', body: 'please verify', kind: 'handoff' });
      expect(h.ok).toBe(true);
      expect(listJobs(vault, { assigned: 'coo' }).length).toBe(1);
      expect(vault.events.count('agent.spoke')).toBeGreaterThanOrEqual(3);
    } finally { await client.close(); }
  });

  it('skills save/load/search fall back to text search without embeddings', async () => {
    const reg = new ToolRegistry().registerAll(phase3Tools());
    const client = await createRoleToolClient(reg.forRole(role('engineer'), cfg), ctxFor('engineer'));
    try {
      await client.call('skills.save', { name: 'Deploy to Cloudflare Pages', when_to_use: 'when publishing Site/', steps: ['build', 'wrangler pages deploy'] });
      const s = await client.call('skills.search', { query: 'deploy cloudflare' });
      expect(s.text).toContain('Skills/deploy-to-cloudflare-pages.md');
      const l = await client.call('skills.load', { name: 'Deploy to Cloudflare Pages' });
      expect(l.text).toContain('wrangler');
    } finally { await client.close(); }
  });
});
