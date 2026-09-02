import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, createRoleToolClient, phase5Tools, phase6Tools, constitutionGuardrail, hasDocker, hasSandboxImage, type ToolContext } from '../src/index.js';

let dir: string; let vault: Vault; let server: http.Server; let port: number;
const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-c56-')); vault = (await scaffoldVault(dir)).vault;
  server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html><body><h1>${req.url}</h1><form action="/posted" method="get"><input id="t" name="t"><button id="go" type="submit">Go</button><button id="plain" type="button">Plain</button></form></body></html>`); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); port = (server.address() as { port: number }).port;
});
afterAll(() => { server.close(); vault.close(); rmSync(dir, { recursive: true, force: true }); });
function role(id: string) { return RoleFrontmatter.parse(parseNote(vault.readText(`Roles/${id}.md`)).data); }
function ctxFor(roleId: string, jobId: string | null, env: NodeJS.ProcessEnv = {}): ToolContext {
  return { vault, events: vault.events, roleId, role: role(roleId), jobId, config: cfg, env, workspace: 'x', now: () => new Date(), scheduler: { enqueue: (j) => createJob(vault, j, roleId) } };
}

describe('browser hardening (B1–B3)', () => {
  it('refuses file:// and private hosts unless explicitly allowed; click cannot submit; submit is self-contained', async () => {
    const reg = new ToolRegistry().registerAll(phase5Tools());
    const strict = await createRoleToolClient(reg.forRole(role('growth'), cfg), ctxFor('growth', 'job_b1'));
    try {
      for (const url of ['file:///etc/hostname', `http://127.0.0.1:${port}/x`, `http://[::1]:${port}/x`, 'http://localhost/x']) {
        const r = await strict.call('browser.open', { url });
        expect(r.ok, url).toBe(false);
        expect(r.text).toContain('blocked');
      }
      expect(vault.events.count('browser.session_started')).toBe(0); // nothing opened on refusal
    } finally { await strict.close(); }
    const lax = await createRoleToolClient(reg.forRole(role('growth'), cfg), ctxFor('growth', 'job_b2', { CUBICLE_ALLOW_LOCAL_FETCH: '1' }));
    try {
      const open = await lax.call('browser.open', { url: `http://127.0.0.1:${port}/form` });
      expect(open.ok).toBe(true);
      const session = (open.data as { session: string }).session;
      const click = await lax.call('browser.click', { selector: '#go', session });
      expect(click.ok).toBe(false);
      expect(click.text).toContain('browser.submit');
      const plain = await lax.call('browser.click', { selector: '#plain', session });
      expect(plain.ok).toBe(true);
      const nl = await lax.call('browser.type', { selector: '#t', text: 'a\nb', session });
      expect(nl.ok).toBe(false);
      const sub = await lax.call('browser.submit', { url: `http://127.0.0.1:${port}/form`, fields: { '#t': 'hello' }, submit: '#go', session }, { idempotencyKey: 'job_b2:1:4' });
      expect(sub.ok).toBe(true);
      expect(sub.text).toContain('/posted?t=hello');
      expect(sub.sideEffectKey).toBe('job_b2:1:4');
      const other = await createRoleToolClient(reg.forRole(role('engineer'), cfg), ctxFor('engineer', 'job_b3', { CUBICLE_ALLOW_LOCAL_FETCH: '1' }));
      try { const steal = await other.call('browser.extract', { session }); expect(steal.ok).toBe(false); expect(steal.text).toContain('belongs to'); } finally { await other.close(); }
      await lax.call('browser.close', { session });
    } finally { await lax.close(); }
  }, 90_000);
});

describe('guardrails at the tool layer (B4, B8)', () => {
  it('banned channels are matched on URL hostnames, including browser tools', async () => {
    vault.updateNote('Memory/constitution.md', (n) => ({ data: n.data, body: n.body.replace('banned_channels: []', 'banned_channels: [reddit]') }), 'owner');
    const g = constitutionGuardrail();
    const ctx = ctxFor('growth', 'job_g');
    expect(await g.check('social.post', { channel: 'forum', url: 'https://www.reddit.com/r/x/submit', title: 't', body: 'b' }, ctx)).toMatch(/banned/);
    expect(await g.check('browser.goto', { url: 'https://old.reddit.com/' }, ctx)).toMatch(/banned/);
    expect(await g.check('browser.goto', { url: 'https://news.ycombinator.com/' }, ctx)).toBeNull();
    vault.updateNote('Memory/constitution.md', (n) => ({ data: n.data, body: n.body.replace('banned_channels: [reddit]', 'banned_channels: []') }), 'owner');
  });
  it('email.send itself enforces max_emails_per_day (not only the harness pre-check)', async () => {
    vault.updateNote('Memory/constitution.md', (n) => ({ data: n.data, body: n.body.replace('max_emails_per_day: 20', 'max_emails_per_day: 1') }), 'owner');
    const client = await createRoleToolClient(new ToolRegistry().registerAll(phase6Tools()).forRole(role('growth'), cfg), ctxFor('growth', 'job_cap'));
    try {
      expect((await client.call('email.send', { to: 'one@x.example', subject: 's', body: 'b' }, { idempotencyKey: 'job_cap:1:1' })).ok).toBe(true);
      const second = await client.call('email.send', { to: 'two@x.example', subject: 's', body: 'b' }, { idempotencyKey: 'job_cap:1:2' });
      expect(second.ok).toBe(false);
      expect(second.text).toContain('max_emails_per_day');
      expect(vault.events.count('email.sent')).toBe(1);
    } finally { await client.close(); vault.updateNote('Memory/constitution.md', (n) => ({ data: n.data, body: n.body.replace('max_emails_per_day: 1', 'max_emails_per_day: 20') }), 'owner'); }
  });
});

describe('deploy.site dir (B7) and local shell fallback (B10)', () => {
  it('refuses anything outside Site/<build dir> and bad project names', async () => {
    const client = await createRoleToolClient(new ToolRegistry().registerAll(phase6Tools()).forRole(role('engineer'), cfg), ctxFor('engineer', 'job_dd'));
    try {
      mkdirSync(path.join(dir, 'Site/dist'), { recursive: true }); writeFileSync(path.join(dir, 'Site/dist/index.html'), 'x');
      for (const d of ['', '.', 'Customers', '.cubicle', 'Site', 'Site/node_modules', 'Site/../Customers']) {
        const r = await client.call('deploy.site', { dir: d }, { idempotencyKey: `job_dd:1:${d.length + 1}` });
        expect(r.ok, d).toBe(false);
      }
      expect((await client.call('deploy.site', { dir: 'Site/dist', project: '--bad' }, { idempotencyKey: 'job_dd:1:90' })).ok).toBe(false);
      expect((await client.call('deploy.site', { dir: 'Site/dist' }, { idempotencyKey: 'job_dd:1:91' })).ok).toBe(true);
    } finally { await client.close(); }
  });
  it('without a sandbox the local shell is refused unless the owner opted in', async () => {
    if (hasDocker() && hasSandboxImage()) { expect(true).toBe(true); return; } // covered by the docker path on this machine
    const client = await createRoleToolClient(new ToolRegistry().registerAll(phase5Tools()).forRole(role('engineer'), cfg), ctxFor('engineer', 'job_ls'));
    try { const r = await client.call('shell.run', { command: 'echo hi' }); expect(r.ok).toBe(false); expect(r.text).toContain('shell_local_fallback'); } finally { await client.close(); }
  });
});

describe('screencast pruning (B9)', () => {
  it('keeps every 5th frame after 7 days and caps frames per session', async () => {
    const { pruneScreens } = await import('@cubicle/daemon');
    const sdir = path.join(dir, '.cubicle/screens/sess1'); mkdirSync(sdir, { recursive: true });
    const ins = vault.db.prepare('INSERT OR REPLACE INTO screens(session_id, seq, ts, path) VALUES (?, ?, ?, ?)');
    const old = new Date(Date.now() - 10 * 86400_000);
    for (let i = 1; i <= 20; i++) { const f = path.join(sdir, `${String(i).padStart(5, '0')}.jpg`); writeFileSync(f, 'x'); utimesSync(f, old, old); ins.run('sess1', i, old.toISOString(), `.cubicle/screens/sess1/${String(i).padStart(5, '0')}.jpg`); }
    const removed = pruneScreens(vault);
    expect(removed).toBe(16);
    expect(existsSync(path.join(sdir, '00005.jpg'))).toBe(true);
    expect(existsSync(path.join(sdir, '00004.jpg'))).toBe(false);
    expect((vault.db.prepare('SELECT COUNT(*) c FROM screens WHERE session_id = ?').get('sess1') as { c: number }).c).toBe(4);
  });
});
