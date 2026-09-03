import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { listInbox, createProposal } from '../src/proposals.js';

let dir: string;
let vault: Vault;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-inbox-'));
  vault = (await scaffoldVault(dir)).vault;
});
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('listInbox — owner-written notes', () => {
  it('accepts the minimal note from CHECKPOINT-A.md (id/kind/from/to/answered, no created)', () => {
    writeFileSync(path.join(dir, '00 Inbox', 'idea.md'), '---\nid: msg_my_idea\nkind: message\nfrom: owner\nto: ceo\nanswered: null\n---\nA one-page site.\n');
    const n = listInbox(vault).find((x) => x.path === '00 Inbox/idea.md');
    expect(n).toBeTruthy();
    expect(n!.data.id).toBe('msg_my_idea');
    expect(n!.data.from).toBe('owner');
    expect(n!.data.to).toBe('ceo');
    expect(n!.data.answered).toBeNull();
    expect(typeof n!.data.created).toBe('string');
    expect(Number.isNaN(Date.parse(n!.data.created))).toBe(false);
  });

  it('accepts the README form (only kind: message): derives a stable id, from=owner, to=ceo', () => {
    writeFileSync(path.join(dir, '00 Inbox', 'hello.md'), '---\nkind: message\n---\nHello CEO.\n');
    const a = listInbox(vault).find((x) => x.path === '00 Inbox/hello.md');
    expect(a).toBeTruthy();
    expect(a!.data.from).toBe('owner');
    expect(a!.data.to).toBe('ceo');
    expect(a!.data.id).toMatch(/^msg_/);
    const b = listInbox(vault).find((x) => x.path === '00 Inbox/hello.md');
    expect(b!.data.id).toBe(a!.data.id);
  });

  it('warns once (daemon.warning) and skips a note it cannot parse', () => {
    writeFileSync(path.join(dir, '00 Inbox', 'broken.md'), '---\nkind: nonsense\n---\n?\n');
    const before = vault.events.query({ types: ['daemon.warning'] }).length;
    expect(listInbox(vault).some((x) => x.path === '00 Inbox/broken.md')).toBe(false);
    listInbox(vault);
    const warns = vault.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.path === '00 Inbox/broken.md');
    expect(warns.length).toBe(1);
    expect(vault.events.query({ types: ['daemon.warning'] }).length).toBe(before + 1);
  });

  it('agent proposals still round-trip unchanged', () => {
    const { id, path: rel } = createProposal(vault, { kind: 'message', from: 'cto', to: 'owner', title: 'Q', body: 'Which colour?' }, 'cto');
    const n = listInbox(vault).find((x) => x.path === rel);
    expect(n!.data.id).toBe(id);
    expect(n!.data.from).toBe('cto');
    expect(n!.data.to).toBe('owner');
  });
});
