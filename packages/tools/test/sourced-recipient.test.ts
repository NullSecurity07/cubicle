import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob } from '@cubicle/core';
import { parseToolsConfig, emailSend, emailInbox, customerPath, recipientSource, unsourcedRecipientText, type ToolContext } from '../src/index.js';

/**
 * Ruling S-3. In the second live run Sales invented Acme, Beta and Gamma with made-up addresses and the CSO
 * tried to mail them: the guardrail caught the tone, compliance caught the footer, and neither caught the
 * fiction. An address may leave the company only when a `Customers/` note says where it came from — a URL a
 * role actually read it on, or `inbox` for someone who wrote to us first.
 */
const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-sourced-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

function ctxFor(roleId: string): ToolContext {
  const role = RoleFrontmatter.parse(parseNote(vault.readText(`Roles/${roleId}.md`)).data);
  return {
    vault, events: vault.events, roleId, role, jobId: 'job_out', config: cfg, env: {},
    workspace: '.cubicle/workspace/job_out', now: () => new Date(),
    scheduler: { enqueue: (j) => createJob(vault, j, roleId) },
  };
}
const send = (to: string, key: string) => emailSend.handler({ to, subject: 'hello', body: 'we built a thing' } as never, { ...ctxFor('cso'), idempotencyKey: key } as ToolContext);
const mockSends = () => (existsSync(path.join(dir, '.cubicle/mock/email.jsonl')) ? readFileSync(path.join(dir, '.cubicle/mock/email.jsonl'), 'utf8').trim().split('\n').filter(Boolean) : []);
const blocked = () => vault.events.query({ types: ['guardrail.blocked'] });

describe('email.send refuses a recipient nobody sourced', () => {
  it('no Customers note at all: refused, one guardrail.blocked, nothing recorded', async () => {
    const r = await send('hello@acme-invented.example', 'job_out:1:1');
    expect(r.ok).toBe(false);
    expect(r.text).toBe(unsourcedRecipientText('hello@acme-invented.example'));
    expect(r.text).toMatch(/find real prospects first/i);
    expect(r.text).toMatch(/http\.fetch|browser/);
    expect(r.text).toContain('source:');
    const ev = blocked();
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ tool: 'email.send', reason: 'unsourced recipient', to: 'hello@acme-invented.example' });
    // Nothing recorded: no send, no email.sent event, and no Customers note conjured by the attempt.
    expect(mockSends()).toEqual([]);
    expect(vault.events.count('email.sent')).toBe(0);
    expect(vault.exists(customerPath('hello@acme-invented.example'))).toBe(false);
  });

  it('a Customers note with no source: is still a refusal', async () => {
    const to = 'ceo@beta-invented.example';
    vault.writeNote(customerPath(to), { email: to, name: 'Beta', status: 'contacted' }, '# Beta\n', 'cso');
    expect(recipientSource(vault, to)).toBeNull();
    const r = await send(to, 'job_out:1:2');
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/not a sourced prospect/);
    expect(blocked().map((e) => e.payload.reason)).toEqual(['unsourced recipient']);
    expect(mockSends()).toEqual([]);
    // A blank or non-string `source:` is no source either.
    vault.writeNote(customerPath(to), { email: to, source: '   ' }, '# Beta\n', 'cso');
    expect(recipientSource(vault, to)).toBeNull();
    expect((await send(to, 'job_out:1:3')).ok).toBe(false);
  });

  it('a note whose source: is the URL it was found on goes through', async () => {
    const to = 'jane@realshop.example';
    vault.writeNote(customerPath(to), { email: to, name: 'Jane', source: 'https://realshop.example/about' }, '# Jane\n\nFound on the about page.\n', 'cso');
    expect(recipientSource(vault, to)).toBe('https://realshop.example/about');
    const r = await send(to, 'job_out:2:1');
    expect(r.ok).toBe(true);
    expect(mockSends()).toHaveLength(1);
    expect(vault.events.count('email.sent')).toBe(1);
    expect(blocked()).toEqual([]);
    // The send logs its touch on the same note and does not throw the source away.
    const note = vault.readNoteOrNull(customerPath(to))!;
    expect(note.data.source).toBe('https://realshop.example/about');
    expect(note.body).toContain('email sent by cso');
  });
});

describe('an address that wrote to us first is sourced by the inbox', () => {
  it('email.inbox stamps source: inbox, and the reply send is not refused', async () => {
    mkdirSync(path.join(dir, '.cubicle/mock/inbox'), { recursive: true });
    writeFileSync(path.join(dir, '.cubicle/mock/inbox/1.json'), JSON.stringify({ from: 'lee@shop.example', fromName: 'Lee', subject: 'Re: your thing', text: 'How much is it?' }));
    const r = await emailInbox.handler({ max: 10 } as never, ctxFor('cso'));
    expect(r.ok).toBe(true);
    const rel = customerPath('lee@shop.example');
    expect(YAML.parse(readFileSync(path.join(dir, rel), 'utf8').split('---')[1]).source).toBe('inbox');
    expect(recipientSource(vault, 'lee@shop.example')).toBe('inbox');
    const reply = await send('lee@shop.example', 'job_out:3:1');
    expect(reply.ok).toBe(true);
    expect(blocked()).toEqual([]);
    expect(vault.events.count('email.sent')).toBe(1);
  });
});
