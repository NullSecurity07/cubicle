import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob, listJobs, listInbox, recordTrustVerdict, TRUST_GATES } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, createRoleToolClient, phase6Tools, emailSend, suppressed, extractPlainText, customerPath, isUnsubscribeRequest, type ToolContext } from '../src/index.js';

let dir: string; let vault: Vault;
const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
beforeAll(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-p6-')); vault = (await scaffoldVault(dir)).vault; });
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });
function role(id: string) { return RoleFrontmatter.parse(parseNote(vault.readText(`Roles/${id}.md`)).data); }
function ctxFor(roleId: string, jobId: string | null, extra: Partial<ToolContext> = {}): ToolContext {
  return { vault, events: vault.events, roleId, role: role(roleId), jobId, config: cfg, env: {}, workspace: 'x', now: () => new Date(), scheduler: { enqueue: (j) => createJob(vault, j, roleId) }, ...extra };
}
/** Both offices cleared this exact call — what SP5 requires of anything that leaves the company. */
const clear = (key: string) => { for (const gate of TRUST_GATES) recordTrustVerdict(vault, { key, proposal: 'prop_t', gate, verdict: 'pass', by: 'daemon' }); };
const mockLines = (name: string) => existsSync(path.join(dir, `.cubicle/mock/${name}.jsonl`)) ? readFileSync(path.join(dir, `.cubicle/mock/${name}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];

describe('email.send (mock)', () => {
  it('adds the footer, records the customer touch, refuses suppressed addresses, needs a key', async () => {
    const client = await createRoleToolClient(new ToolRegistry().registerAll(phase6Tools()).forRole(role('cmo'), cfg), ctxFor('cmo', 'job_e'));
    try {
      // No idempotency key. Since SP5 this is refused one layer above `email.send`'s own `requireKey`: a leaving
      // call with no key carries no filed proposal, so no office can have reviewed it, and the handler never
      // runs. Assert the text, or this case reads as "the tool needs a key" while testing the trust veto —
      // and `requireKey`'s own refusal would go uncovered without anyone noticing (review minor 7).
      const nokey = await client.call('email.send', { to: 'a@example.com', subject: 'hi', body: 'hello' });
      expect(nokey.ok).toBe(false);
      expect(nokey.text).toContain('carries no filed proposal');
      expect(nokey.guardrailBlocked).toContain('carries no filed proposal');
      expect(vault.events.count('email.sent')).toBe(0);
      // `email.send`'s own key check is the layer below, unreachable through the wrapper now that a keyless
      // leaving call is refused before it. Called directly, it still says so.
      expect(await emailSend.handler({ to: 'a@example.com', subject: 'hi', body: 'hello' } as never, ctxFor('cmo', 'job_e'))).toMatchObject({ ok: false, text: 'email.send requires an idempotency key (harness bug)' });
      clear('job_e:1:2');
      // Ruling S-3: a recipient with no `Customers/` note saying where the address came from is refused before
      // anything else. This one was researched, so the note says so and the send goes through.
      vault.writeNote(customerPath('a@example.com'), { email: 'a@example.com', source: 'https://example.com/team' }, '# A\n', 'cmo');
      const r = await client.call('email.send', { to: 'a@example.com', subject: 'hi', body: 'hello there' }, { idempotencyKey: 'job_e:1:2' });
      expect(r.ok).toBe(true);
      expect(r.sideEffectKey).toBe('job_e:1:2');
      const sent = mockLines('email');
      expect(sent.length).toBe(1);
      expect(sent[0].text).toContain('unsubscribe');
      expect(vault.readText(customerPath('a@example.com'))).toContain('email sent by cmo');
      expect(vault.events.count('email.sent')).toBe(1);
      vault.appendText('Customers/_suppression.md', 'a@example.com\n', 'owner');
      expect(suppressed(vault, 'A@Example.com')).toBe(true);
      clear('job_e:1:3');   // cleared by both offices, so the refusal below is the suppression list's, not a missing review
      const blocked = await client.call('email.send', { to: 'a@example.com', subject: 'again', body: 'x' }, { idempotencyKey: 'job_e:1:3' });
      expect(blocked.ok).toBe(false);
      expect(mockLines('email').length).toBe(1);
    } finally { await client.close(); }
  });
});

describe('email.inbox (mock)', () => {
  it('turns dropped messages into Customers/ notes, reply jobs, and suppressions', async () => {
    mkdirSync(path.join(dir, '.cubicle/mock/inbox'), { recursive: true });
    writeFileSync(path.join(dir, '.cubicle/mock/inbox/1.json'), JSON.stringify({ from: 'lead@shop.example', fromName: 'Lee', subject: 'Re: meal planner', text: 'Sounds useful, how much is it?' }));
    writeFileSync(path.join(dir, '.cubicle/mock/inbox/2.json'), JSON.stringify({ from: 'nope@shop.example', subject: 'unsubscribe', text: 'please remove me' }));
    const client = await createRoleToolClient(new ToolRegistry().registerAll(phase6Tools()).forRole(role('coo'), cfg), ctxFor('coo', 'job_i'));
    try {
      const r = await client.call('email.inbox', {});
      expect(r.ok).toBe(true);
      expect(r.text).toContain('2 new message');
      expect(vault.readText(customerPath('lead@shop.example'))).toContain('how much is it');
      const reply = listJobs(vault).find((j) => j.type === 'growth.outreach' && /Reply to Lee/.test(j.title));
      expect(reply).toBeTruthy();
      expect(reply!.id).toBe('job_reply_mock_1');
      expect(suppressed(vault, 'nope@shop.example')).toBe(true);
      expect(vault.events.count('email.received')).toBe(2);
      const again = await client.call('email.inbox', {});
      expect(again.text).toContain('no new mail'); // consumed once
      expect(listJobs(vault).filter((j) => /Reply to Lee/.test(j.title)).length).toBe(1);
    } finally { await client.close(); }
  });
  it('unsubscribe detection ignores quoted text and our own footer', () => {
    expect(isUnsubscribeRequest('Re: meal planner', 'Sounds great, how much?\n\nOn Tue, X wrote:\n> Reply "unsubscribe" and you will never hear from us again.')).toBe(false);
    expect(isUnsubscribeRequest('Re: meal planner', '> please unsubscribe me\n\nActually I am interested')).toBe(false);
    expect(isUnsubscribeRequest('unsubscribe', '')).toBe(true);
    expect(isUnsubscribeRequest('Re: hi', 'Please remove me from this list.')).toBe(true);
    expect(isUnsubscribeRequest('Re: hi', 'Thanks!\n--\nunsubscribe footer of THEIR client')).toBe(false);
  });
  it('extracts plain text from a multipart MIME source', () => {
    const src = 'From: x\r\nContent-Type: multipart/alternative; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/html\r\n\r\n<p>html <b>part</b></p>\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nplain =3D part\r\n--b1--\r\n';
    expect(extractPlainText(src)).toBe('plain = part');
  });
});

describe('deploy.site / stripe / analytics (mock)', () => {
  it('deploy needs dist, records deploy.done, proposes the URL into Brand/name.md', async () => {
    const client = await createRoleToolClient(new ToolRegistry().registerAll(phase6Tools()).forRole(role('backend_engineer'), cfg), ctxFor('backend_engineer', 'job_d'));
    try {
      const nodist = await client.call('deploy.site', {}, { idempotencyKey: 'job_d:1:1' });
      expect(nodist.ok).toBe(false);
      mkdirSync(path.join(dir, 'Site/dist'), { recursive: true });
      writeFileSync(path.join(dir, 'Site/dist/index.html'), '<h1>hi</h1>');
      // Progressive delivery: preview → canary → live. Only the live deploy proposes the production URL.
      const r = await client.call('deploy.site', {}, { idempotencyKey: 'job_d:1:2' });
      expect(r.ok).toBe(true);
      expect((await client.call('deploy.site', { stage: 'canary', metrics: ['error rate'] }, { idempotencyKey: 'job_d:1:2b' })).ok).toBe(true);
      clear('job_d:1:2c');   // a live deploy leaves the company; preview and canary do not
      expect((await client.call('deploy.site', { stage: 'live', metrics: ['error rate'] }, { idempotencyKey: 'job_d:1:2c' })).ok).toBe(true);
      expect(vault.events.count('deploy.done')).toBe(3);
      expect(mockLines('deploy').length).toBe(3);
      const prop = listInbox(vault).find((n) => n.data.kind === 'brand_change' && /Record site URL/.test(n.body));
      expect(prop).toBeTruthy();
      expect(prop!.data.call?.args.content).toContain('url: https://');
      clear('job_d:1:3');
      const link = await client.call('stripe.payment_link', { name: 'Meal planner PDF', amount_cents: 900 }, { idempotencyKey: 'job_d:1:3' });
      expect(link.ok).toBe(true);
      expect(vault.readText('Metrics/payment_links.md')).toContain('Meal planner PDF');
      expect(mockLines('stripe')[0].amount_cents).toBe(900);
    } finally { await client.close(); }
  });
  it('analytics.pull upserts today\'s row in Metrics/daily.md', async () => {
    const client = await createRoleToolClient(new ToolRegistry().registerAll(phase6Tools()).forRole(role('coo'), cfg), ctxFor('coo', 'job_a'));
    try {
      const r = await client.call('analytics.pull', {});
      expect(r.ok).toBe(true);
      const today = new Date().toISOString().slice(0, 10);
      const rows = vault.readText('Metrics/daily.md').split('\n').filter((l) => l.startsWith(`| ${today} |`));
      expect(rows.length).toBe(1);
      await client.call('analytics.pull', {});
      expect(vault.readText('Metrics/daily.md').split('\n').filter((l) => l.startsWith(`| ${today} |`)).length).toBe(1);
      expect(rows[0]).toMatch(/\| 1 \| 2 \|/); // emails_sent=1 replies=2 from earlier tests
    } finally { await client.close(); }
  });
  it('social.post records the draft and points at the browser', async () => {
    const client = await createRoleToolClient(new ToolRegistry().registerAll(phase6Tools()).forRole(role('cmo'), cfg), ctxFor('cmo', 'job_s'));
    try {
      clear('job_s:1:1');
      const r = await client.call('social.post', { channel: 'hn', url: 'https://news.ycombinator.com/submit', title: 'Show HN: meal planner', body: 'text' }, { idempotencyKey: 'job_s:1:1' });
      expect(r.ok).toBe(true);
      expect(vault.list('Experiments/posts', { ext: '.md' }).length).toBe(1);
      expect(r.text).toContain('browser.submit');
    } finally { await client.close(); }
  });
});
