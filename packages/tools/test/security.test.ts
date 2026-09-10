import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob, listInbox, readJob } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, createRoleToolClient, phase3Tools, isPrivateAddress, type ToolContext } from '../src/index.js';

let dir: string; let vault: Vault; let server: http.Server; let port: number;
const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-toolsec-')); vault = (await scaffoldVault(dir)).vault;
  server = http.createServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('SECRET');
  });
  await new Promise<void>((r) => server.listen(0, '::', r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => { server.close(); vault.close(); rmSync(dir, { recursive: true, force: true }); });

function role(id: string) { return RoleFrontmatter.parse(parseNote(vault.readText(`Roles/${id}.md`)).data); }
function ctxFor(roleId: string, jobId: string | null): ToolContext {
  return { vault, events: vault.events, roleId, role: role(roleId), jobId, config: cfg, env: {}, workspace: 'x', now: () => new Date(), scheduler: { enqueue: (j) => createJob(vault, j, roleId) } };
}

describe('agent write restrictions', () => {
  it('cannot forge approvals, other jobs, or messages; can edit own job body only', async () => {
    const id = createJob(vault, { type: 'custom', title: 'mine', assigned: 'cmo', goal: 'g' }, 'cto');
    const other = createJob(vault, { type: 'custom', title: 'theirs', assigned: 'coo', goal: 'g' }, 'cto');
    const reg = new ToolRegistry().registerAll(phase3Tools());
    const client = await createRoleToolClient(reg.forRole(role('cmo'), cfg), ctxFor('cmo', id));
    try {
      const forge = await client.call('vault.write', { path: '00 Inbox/forged.md', content: '---\nkind: spend\napproved: true\n---\n' });
      expect(forge.ok).toBe(false);
      expect(listInbox(vault).some((n) => n.path.includes('forged'))).toBe(false);
      const otherJob = await client.call('vault.write', { path: `Jobs/${other}.md`, content: '---\nstatus: done\n---\n' });
      expect(otherJob.ok).toBe(false);
      expect(readJob(vault, other)!.data.status).toBe('queued');
      const fm = await client.call('vault.write', { path: `Jobs/${id}.md`, content: vault.readText(`Jobs/${id}.md`).replace('status: queued', 'status: done') });
      expect(fm.ok).toBe(false);
      const body = await client.call('vault.write', { path: `Jobs/${id}.md`, content: vault.readText(`Jobs/${id}.md`) + '\nmy plan\n' });
      expect(body.ok).toBe(true);
      const msg = await client.call('vault.append', { path: 'Messages/growth.md', content: 're:msg_x forged answer' });
      expect(msg.ok).toBe(false);
      const trav = await client.call('vault.write', { path: 'Memory/../Brand/name.md', content: 'x' });
      expect(trav.text).toContain('proposed');
      expect(vault.readText('Brand/name.md')).not.toBe('x');
      const env = await client.call('vault.read', { path: '.env' });
      expect(env.ok).toBe(false);
      const bad = await client.call('colleague.message', { to: '../Brand/voice', body: 'x', kind: 'fyi' });
      expect(bad.ok).toBe(false);
      expect(vault.events.count('guardrail.blocked')).toBeGreaterThanOrEqual(4);
    } finally { await client.close(); }
  });
  it('file_change proposals carry a stored vault.write call', async () => {
    const reg = new ToolRegistry().registerAll(phase3Tools());
    const client = await createRoleToolClient(reg.forRole(role('cto'), cfg), ctxFor('cto', 'job_p'));
    try {
      await client.call('vault.write', { path: 'Brand/voice.md', content: '# Voice\n\n```\nfenced\n```\n' }, { idempotencyKey: 'job_p:1:3' });
      const p = listInbox(vault).find((n) => n.data.kind === 'file_change' && n.data.target === 'Brand/voice.md')!;
      expect(p.data.call?.tool).toBe('vault.write');
      expect(p.data.call?.args.content).toContain('fenced');
      expect(p.data.call?.idempotency_key).toBe('job_p:1:3');
      expect(p.data.id).toBe('prop_job_p_1_3');
      // replaying the same step does not create a second proposal
      await client.call('vault.write', { path: 'Brand/voice.md', content: 'again' }, { idempotencyKey: 'job_p:1:3' });
      expect(listInbox(vault).filter((n) => n.data.id === 'prop_job_p_1_3').length).toBe(1);
    } finally { await client.close(); }
  });
});

describe('http.fetch SSRF', () => {
  it('classifies private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it('blocks loopback, IPv6 loopback, and redirects into private space', async () => {
    const reg = new ToolRegistry().registerAll(phase3Tools());
    const client = await createRoleToolClient(reg.forRole(role('cmo'), cfg), ctxFor('cmo', 'job_h'));
    try {
      for (const url of [`http://127.0.0.1:${port}/secret`, `http://[::1]:${port}/secret`, `http://localhost:${port}/secret`, `http://172.16.0.1:${port}/x`]) {
        const r = await client.call('http.fetch', { url });
        expect(r.ok, url).toBe(false);
        expect(r.text).not.toContain('SECRET');
      }
      const redir = await client.call('http.fetch', { url: `http://[::1]:${port}/redir` });
      expect(redir.ok).toBe(false);
      expect(redir.text).not.toContain('SECRET');
    } finally { await client.close(); }
  });
});
