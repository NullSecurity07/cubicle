import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob, listDecisions, decisionPath } from '@cubicle/core';
import type { Router, RoutedChatResult } from '@cubicle/router';
import { parseToolsConfig, ToolRegistry, createRoleToolClient, phase3Tools, phase5Tools, constitutionGuardrail, hostAllowed, AllowlistProxy, hasDocker, hasSandboxImage, browserFrames, mockOutbound, type ToolContext } from '../src/index.js';

let dir: string; let vault: Vault; let server: http.Server; let port: number;
const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-p5-')); vault = (await scaffoldVault(dir)).vault;
  server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html><head><title>Test Page</title></head><body><h1>Hello ${req.url}</h1><form><input id="q" name="q"><button id="go" type="submit">Go</button></form><a href="/next">next</a><script>document.body.style.background="#ffe";</script></body></html>`); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => { server.close(); vault.close(); rmSync(dir, { recursive: true, force: true }); });

function role(id: string) { return RoleFrontmatter.parse(parseNote(vault.readText(`Roles/${id}.md`)).data); }
function ctxFor(roleId: string, jobId: string | null, extra: Partial<ToolContext> = {}): ToolContext {
  return { vault, events: vault.events, roleId, role: role(roleId), jobId, config: cfg, env: { CUBICLE_ALLOW_LOCAL_FETCH: '1' }, workspace: 'x', now: () => new Date(), scheduler: { enqueue: (j) => createJob(vault, j, roleId) }, ...extra };
}

describe('shell.run', () => {
  it('runs in the sandbox (or local fallback), streams shell.output, rescans Site/', async () => {
    const reg = new ToolRegistry().registerAll(phase5Tools());
    const client = await createRoleToolClient(reg.forRole(role('engineer'), cfg), ctxFor('engineer', 'job_sh'));
    try {
      const r = await client.call('shell.run', { command: 'echo hello-from-sandbox && echo "<h1>built</h1>" > index.html && ls' });
      expect(r.ok).toBe(true);
      expect(r.text).toContain('hello-from-sandbox');
      expect(r.text).toMatch(/\[(docker|local)\] exit 0/);
      expect(vault.readText('Site/index.html')).toContain('built');
      expect(vault.isOwnerChanged('Site/index.html')).toBe(false); // rescanned as engineer/shell
      expect(vault.events.count('shell.output')).toBeGreaterThanOrEqual(2);
      const t = await client.call('shell.run', { command: 'sleep 5', timeout_s: 1 });
      expect(t.ok).toBe(false);
      expect(t.text).toContain('TIMED OUT');
      if (hasDocker() && hasSandboxImage()) {
        const net = await client.call('shell.run', { command: 'timeout 5 curl -sS -m 4 https://example.com >/dev/null && echo reached || echo blocked' });
        expect(net.text).toContain('blocked'); // --network none
      }
    } finally { await client.close(); }
  }, 120_000);
  it('allow-list proxy refuses hosts off the list', async () => {
    expect(hostAllowed('registry.npmjs.org', cfg.sandbox_allowlist)).toBe(true);
    expect(hostAllowed('raw.githubusercontent.com', cfg.sandbox_allowlist)).toBe(true);
    expect(hostAllowed('evil.example', cfg.sandbox_allowlist)).toBe(false);
    const proxy = new AllowlistProxy(['example.com']);
    const { host, port: pp } = await proxy.start('127.0.0.1');
    try {
      const res = await fetch(`http://${host}:${pp}/`, { method: 'GET', headers: { host: 'evil.example' } }).catch(() => null);
      // absolute-form request through the proxy
      const req = await new Promise<number>((resolve) => { const r = http.request({ host, port: pp, path: 'http://evil.example/x', method: 'GET' }, (res2) => resolve(res2.statusCode ?? 0)); r.on('error', () => resolve(0)); r.end(); });
      expect(req).toBe(403);
      expect(proxy.denied).toContain('evil.example');
      void res;
    } finally { await proxy.stop(); }
  });
});

describe('browser.*', () => {
  it('opens a page, streams ≥1 screencast frame to disk + WS emitter, extracts, screenshots, closes', async () => {
    const reg = new ToolRegistry().registerAll(phase5Tools());
    const frames: unknown[] = [];
    const onFrame = (f: unknown) => frames.push(f);
    browserFrames.on('frame', onFrame);
    const client = await createRoleToolClient(reg.forRole(role('head_of_growth'), cfg), ctxFor('head_of_growth', 'job_br'));
    try {
      const open = await client.call('browser.open', { url: `http://127.0.0.1:${port}/start` });
      expect(open.ok).toBe(true);
      const session = (open.data as { session: string }).session;
      const g = await client.call('browser.goto', { url: `http://127.0.0.1:${port}/page2`, session });
      expect(g.text).toContain('Test Page');
      expect(g.text).toContain('Hello /page2');
      await client.call('browser.type', { selector: '#q', text: 'query', session });
      const ex = await client.call('browser.extract', { selector: 'body', links: true, session });
      expect(ex.text).toContain('/next');
      const shot = await client.call('browser.screenshot', { session });
      expect(existsSync(path.join(dir, (shot.data as { path: string }).path))).toBe(true);
      await new Promise((r) => setTimeout(r, 1200));
      const screens = readdirSync(path.join(dir, '.cubicle/screens', session)).filter((f) => f.endsWith('.jpg'));
      expect(screens.length).toBeGreaterThanOrEqual(1);
      expect(frames.length).toBeGreaterThanOrEqual(1);
      expect(vault.events.count('browser.frame')).toBeGreaterThanOrEqual(1);
      expect(vault.events.count('browser.session_started')).toBe(1);
      const rows = vault.db.prepare('SELECT COUNT(*) c FROM screens WHERE session_id = ?').get(session) as { c: number };
      expect(rows.c).toBeGreaterThanOrEqual(1);
      const fp = vault.events.last('browser.frame')!.payload as { path: string };
      expect(JSON.stringify(fp)).not.toContain('base64'); // bytes never in the event log
      await client.call('browser.close', { session });
      expect(vault.events.count('browser.session_ended')).toBe(1);
    } finally { browserFrames.off('frame', onFrame); await client.close(); }
  }, 90_000);
});

describe('constitution guardrail (acceptance test 6)', () => {
  it('blocks outbound email past max_emails_per_day and cheap banned-tactic matches', async () => {
    const g = constitutionGuardrail();
    const ctx = ctxFor('head_of_growth', 'job_g');
    vault.updateNote('Memory/constitution.md', (n) => ({ data: n.data, body: n.body.replace('max_emails_per_day: 20', 'max_emails_per_day: 2') }), 'owner');
    expect(await g.check('email.send', { to: 'a@x', body: 'hi' }, ctx)).toBeNull();
    for (let i = 0; i < 2; i++) vault.events.emit({ type: 'email.sent', agent: 'head_of_growth', payload: { mock: true } });
    expect(await g.check('email.send', { to: 'a@x', body: 'hi' }, ctx)).toMatch(/max_emails_per_day/);
    expect(await g.check('email.send', { to: 'a@x', body: 'Only 2 left! Fake urgency: buy now' }, ctx)).toMatch(/max_emails_per_day|banned tactic/);
    vault.updateNote('Memory/constitution.md', (n) => ({ data: n.data, body: n.body.replace('max_emails_per_day: 2', 'max_emails_per_day: 20').replace('banned_channels: []', 'banned_channels: [reddit]') }), 'owner');
    expect(await g.check('social.post', { channel: 'reddit', body: 'x' }, ctx)).toMatch(/banned/);
    expect(await g.check('social.post', { channel: 'hn', body: 'x' }, ctx)).toBeNull();
    expect(await g.check('email.send', { to: 'a@x', body: 'We use fabricated testimonials' }, ctx)).toMatch(/banned tactic/);
  });

  it('asks the classifier once for the same text, however many times it is checked', async () => {
    let calls = 0;
    const counting = { async chat(): Promise<RoutedChatResult> { calls++; return { content: '{"violates": false, "tactic": ""}', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'local', downgraded: false, parsedToolCalls: [] }; } } as unknown as Router;
    const g = constitutionGuardrail(counting);
    const ctx = ctxFor('head_of_growth', 'job_memo');
    // No banned tactic appears literally, so the cheap substring check misses and the model is asked.
    const body = `A perfectly ordinary note about our roadmap ${Date.now()}`;
    expect(await g.check('email.send', { to: 'a@x', body }, ctx)).toBeNull();
    expect(calls).toBe(1);
    // The harness pre-check and the MCP wrapper both evaluate the same call; the second must be free.
    expect(await g.check('email.send', { to: 'a@x', body }, ctx)).toBeNull();
    expect(calls).toBe(1);
    expect(await g.check('email.send', { to: 'a@x', body: `${body} and something else` }, ctx)).toBeNull();
    expect(calls).toBe(2);
  });

  it('classifies browser.submit field values, the tool social.post hands off to (C2)', async () => {
    const g = constitutionGuardrail();
    const ctx = ctxFor('head_of_growth', 'job_g2');
    expect(vault.constitution().banned_tactics).toContain('fake urgency');
    const args = { url: 'https://example.com/post', fields: { '#title': 'Launch', '#body': 'Only today! Fake urgency, act now' }, submit: '#go' };
    expect(await g.check('browser.submit', args, ctx)).toMatch(/banned tactic "fake urgency"/i);
    expect(await g.check('browser.submit', { ...args, fields: { '#title': 'Launch', '#body': 'We shipped a thing' } }, ctx)).toBeNull();
  });
});

describe('Site/ owner-edit safety (acceptance test 3, tool half)', () => {
  it('an owner-changed Site/ file is read-only for the engineer; system files stay writable', async () => {
    const reg = new ToolRegistry().registerAll([...phase3Tools(), ...phase5Tools()]);
    const client = await createRoleToolClient(reg.forRole(role('engineer'), cfg), ctxFor('engineer', 'job_site'));
    try {
      const ok = await client.call('vault.write', { path: 'Site/about.html', content: '<p>agent</p>' });
      expect(ok.ok).toBe(true);
      writeFileSync(path.join(dir, 'Site/about.html'), '<p>owner edited</p>'); // Obsidian / editor write
      const blocked = await client.call('vault.write', { path: 'Site/about.html', content: '<p>agent again</p>' });
      expect(blocked.ok).toBe(false);
      expect(blocked.text).toContain('changed by the owner');
      expect(readFileSync(path.join(dir, 'Site/about.html'), 'utf8')).toBe('<p>owner edited</p>');
      const other = await client.call('vault.write', { path: 'Site/contact.html', content: '<p>new</p>' });
      expect(other.ok).toBe(true);
    } finally { await client.close(); }
  });
});

describe('meeting.open', () => {
  it('runs round-robin turns and writes Meetings/ + Decisions/', async () => {
    let n = 0;
    const fakeRouter = { async chat(req: { roleId?: string }): Promise<RoutedChatResult> { n++; const text = /close the meeting/i.test('') ? '' : `${req.roleId} says point ${n}`; return { content: n > 100 ? '' : (n % 7 === 0 ? '## Context\nc\n## Options considered\no\n## Chosen\nship it\n## Why\nw\n## Expected effect\ne\n## Review date\n2026-09-16' : text), toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium', downgraded: false, parsedToolCalls: [] }; } } as unknown as Router;
    const reg = new ToolRegistry().registerAll(phase5Tools());
    const client = await createRoleToolClient(reg.forRole({ ...role('ceo'), tools: ['meeting.open'] } as RoleFrontmatter, cfg), ctxFor('ceo', 'job_m', { router: fakeRouter }));
    try {
      const r = await client.call('meeting.open', { room: 'board', participants: ['cto', 'coo'], agenda: 'Two jobs failed. What changes?', rounds: 2 });
      expect(r.ok).toBe(true);
      const meet = (r.data as { path: string; decision: string });
      expect(vault.readText(meet.path)).toContain('Round 2 — coo');
      expect(vault.readText(meet.decision)).toContain('## Chosen');
      expect(vault.events.count('meeting.turn')).toBe(6);
      expect(vault.events.count('meeting.closed')).toBe(1);
    } finally { await client.close(); }
  });

  const HEADS = ['Context', 'Options considered', 'Chosen', 'Why', 'Expected effect', 'Review date'];
  const headingsOf = (body: string) => [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  const routerSaying = (close: string) => {
    let n = 0;
    return { async chat(req: { roleId?: string }): Promise<RoutedChatResult> { n++; return { content: n % 7 === 0 ? close : `${req.roleId} says point ${n}`, toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium', downgraded: false, parsedToolCalls: [] }; } } as unknown as Router;
  };

  it('writes the decision through writeDecision (C5)', async () => {
    const close = '## Context\nboard context line one\nline two of context\n## Options considered\n- cto: keep it\n- coo: move it\n- ceo: wait a cycle\n## Chosen\nship it\n## Why\nfastest path\n## Expected effect\nsignups up\n## Review date\n2026-09-16';
    const reg = new ToolRegistry().registerAll(phase5Tools());
    const client = await createRoleToolClient(reg.forRole({ ...role('ceo'), tools: ['meeting.open'] } as RoleFrontmatter, cfg), ctxFor('ceo', 'job_m5', { router: routerSaying(close) }));
    try {
      const r = await client.call('meeting.open', { room: 'board', participants: ['cto', 'coo'], agenda: 'Ship or wait?', rounds: 2 });
      expect(r.ok).toBe(true);
      const meet = r.data as { path: string; decision: string };
      const note = listDecisions(vault).find((d) => d.path === meet.decision);
      expect(note).toBeDefined();
      expect(meet.decision).toBe(decisionPath(note!.data.id));
      expect(note!.data.decided_by).toBe('ceo');
      expect(note!.data.status).toBe('adopted');
      expect(note!.data.inputs).toContain(`[[${meet.path.replace(/\.md$/, '')}]]`);
      expect(note!.data.review_date).toBe('2026-09-16');
      expect(headingsOf(note!.body)).toEqual(HEADS);
      expect(note!.body).toContain('ship it');
      // Every line of a multi-line section must survive the split, not just the first.
      expect(note!.body).toContain('board context line one\nline two of context');
      for (const bullet of ['- cto: keep it', '- coo: move it', '- ceo: wait a cycle']) expect(note!.body).toContain(bullet);
    } finally { await client.close(); }
  });

  it('keeps the template fallback when the closing summary is malformed (C5)', async () => {
    const reg = new ToolRegistry().registerAll(phase5Tools());
    const client = await createRoleToolClient(reg.forRole({ ...role('ceo'), tools: ['meeting.open'] } as RoleFrontmatter, cfg), ctxFor('ceo', 'job_m6', { router: routerSaying('I could not decide.') }));
    try {
      const r = await client.call('meeting.open', { room: 'meeting', participants: ['cto'], agenda: 'Pick a database', rounds: 1 });
      expect(r.ok).toBe(true);
      const meet = r.data as { path: string; decision: string };
      const note = listDecisions(vault).find((d) => d.path === meet.decision);
      expect(note).toBeDefined();
      expect(headingsOf(note!.body)).toEqual(HEADS);
      expect(note!.body).toContain('Pick a database');
      expect(note!.data.review_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The fallback renders the whole transcript as bullets under Options considered; none may be lost.
      expect(note!.body).toContain('- ceo: ceo says point 1');
      expect(note!.body).toContain('- cto: cto says point 2');
    } finally { await client.close(); }
  });

  it('the decision inputs link resolves to the meeting note that produced it (C5)', async () => {
    const reg = new ToolRegistry().registerAll(phase5Tools());
    const client = await createRoleToolClient(reg.forRole({ ...role('ceo'), tools: ['meeting.open'] } as RoleFrontmatter, cfg), ctxFor('ceo', 'job_m7', { router: routerSaying('nothing structured') }));
    try {
      const r = await client.call('meeting.open', { room: 'meeting', participants: ['cto'], agenda: 'Where does the link point?', rounds: 1 });
      const meet = r.data as { path: string; decision: string };
      const note = listDecisions(vault).find((d) => d.path === meet.decision)!;
      // Ratified deviation: inputs carries the meeting note's path, not `[[Meetings/<meeting id>]]`,
      // because no note lives at the id. The link must therefore resolve to a real file.
      const link = note.data.inputs.find((i) => i.startsWith('[[Meetings/'))!;
      const target = `${link.slice(2, -2)}.md`;
      expect(target).toBe(meet.path);
      expect(vault.exists(target)).toBe(true);
    } finally { await client.close(); }
  });
});

describe('tool-layer enforcement (C1)', () => {
  const setCap = (n: number) => vault.updateNote('Memory/constitution.md', (nn) => ({ data: nn.data, body: nn.body.replace(/max_emails_per_day: \d+/, `max_emails_per_day: ${n}`) }), 'owner');

  it('a direct tool client call past the constitution cap is blocked inside the tool layer (no harness)', async () => {
    setCap(0);
    const blockedBefore = vault.events.count('guardrail.blocked');
    const sentBefore = vault.events.count('email.sent');
    const client = await createRoleToolClient([mockOutbound], ctxFor('head_of_growth', 'job_c1', { guardrails: [constitutionGuardrail()] }));
    try {
      const res = await client.call('mock.outbound', { to: 'a@b.c', body: 'hi' }, { idempotencyKey: 'k1' });
      expect(res.ok).toBe(false);
      expect(res.text).toMatch(/max_emails_per_day/);
      expect(vault.events.count('guardrail.blocked') - blockedBefore).toBe(1);
      expect(vault.events.count('email.sent')).toBe(sentBefore);
    } finally { await client.close(); setCap(20); }
  });

  it('a config-level never is refused by the tool layer even when the caller resolved a different mode', async () => {
    const neverCfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8').replace('mock.outbound:         { mode: auto,', 'mock.outbound:         { mode: never,'));
    const blockedBefore = vault.events.count('guardrail.blocked');
    const sentBefore = vault.events.count('email.sent');
    const client = await createRoleToolClient([mockOutbound], ctxFor('head_of_growth', 'job_c1b', { config: neverCfg }));
    try {
      const res = await client.call('mock.outbound', { to: 'a@b.c', body: 'hi' }, { idempotencyKey: 'k2' });
      expect(res.ok).toBe(false);
      expect(res.text).toMatch(/never/);
      expect(vault.events.count('guardrail.blocked') - blockedBefore).toBe(1);
      expect(vault.events.count('email.sent')).toBe(sentBefore);
    } finally { await client.close(); }
  });
});
