import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { listInbox, createProposal, filenameTail, noteTitle } from '../src/proposals.js';
import { idFromKey } from '../src/fs.js';

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

describe('listInbox — owner-typed approval values', () => {
  it('accepts a quoted "true"/"false" (Obsidian writes text properties that way) and a quoted chosen number', () => {
    writeFileSync(path.join(dir, '00 Inbox', 'quoted-true.md'), '---\nid: prop_q1\nkind: brand_change\nfrom: ceo\nto: owner\ncreated: 2026-09-03T04:46:31.177Z\napproved: "true"\ntarget: Brand/name.md\nchosen: "2"\n---\n# Name\n');
    writeFileSync(path.join(dir, '00 Inbox', 'quoted-false.md'), '---\nid: prop_q2\nkind: brand_change\nfrom: ceo\nto: owner\ncreated: 2026-09-03T04:46:31.177Z\napproved: "No"\ntarget: Brand/name.md\nanswered: "yes"\n---\n# Name\n');
    const a = listInbox(vault).find((x) => x.data.id === 'prop_q1')!;
    expect(a.data.approved).toBe(true);
    expect(a.data.chosen).toBe(2);
    const b = listInbox(vault).find((x) => x.data.id === 'prop_q2')!;
    expect(b.data.approved).toBe(false);
    expect(b.data.answered).toBe(true);
  });
  it('still ignores a value that is not a decision, with one warning naming the field', () => {
    writeFileSync(path.join(dir, '00 Inbox', 'maybe.md'), '---\nid: prop_q3\nkind: brand_change\nfrom: ceo\nto: owner\ncreated: 2026-09-03T04:46:31.177Z\napproved: maybe\ntarget: Brand/name.md\n---\n# Name\n');
    expect(listInbox(vault).find((x) => x.data.id === 'prop_q3')).toBeUndefined();
    const w = vault.events.query({ types: ['daemon.warning'] }).find((e) => e.payload.path === '00 Inbox/maybe.md');
    expect(String(w?.payload.reason)).toMatch(/approved/);
  });
});

// T13-7: the filename used to be the last eight characters of the id's last underscore-segment, which cuts a
// word in half on a deterministic id — `prop_idea_verdict_meal_kits_for_nurseries` filed as `…-urseries.md` —
// and, worse, two ideas whose slugs end alike produce the same name inside the same minute, so the second
// write lands on the first note.
describe('what a proposal is called on disk', () => {
  it('carries the whole slug, not the tail of a word', () => {
    const id = idFromKey('prop', 'idea-verdict:meal-kits-for-nurseries');
    expect(filenameTail(id, 'idea_verdict')).toBe('meal_kits_for_nurseries');
    // Two ideas that used to collide now do not.
    expect(filenameTail(idFromKey('prop', 'idea-verdict:lunch-for-nurseries'), 'idea_verdict')).toBe('lunch_for_nurseries');
    // A random id keeps the short tail it always had (the date is already in the stamp).
    expect(filenameTail('prop_20260911_a1b2c3', 'file_change')).toBe('a1b2c3');
    // An id that is nothing but its kind still gets a name.
    expect(filenameTail(idFromKey('prop', 'founder_brief'), 'founder_brief')).toHaveLength(8);
  });

  it('files two verdicts on alike-ending slugs as two different notes', async () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), 'cubicle-prop-names-'));
    const { vault: v } = await scaffoldVault(dir2);
    try {
      const a = createProposal(v, { id: idFromKey('prop', 'idea-verdict:meal-kits-for-nurseries'), kind: 'idea_verdict', from: 'ceo', target: 'Ideas/meal-kits-for-nurseries.md', title: 'Keep, park or scrap: meal kits', body: 'x' }, 'ceo');
      const b = createProposal(v, { id: idFromKey('prop', 'idea-verdict:lunch-for-nurseries'), kind: 'idea_verdict', from: 'ceo', target: 'Ideas/lunch-for-nurseries.md', title: 'Keep, park or scrap: lunch', body: 'y' }, 'ceo');
      expect(a.path).not.toBe(b.path);
      expect(a.path).toContain('meal_kits_for_nurseries');
      expect(v.readText(a.path)).toContain('meal kits');
      expect(v.readText(b.path)).toContain('lunch');
      expect(listInbox(v).filter((n) => n.data.kind === 'idea_verdict')).toHaveLength(2);
    } finally { v.close(); rmSync(dir2, { recursive: true, force: true }); }
  });
});

/**
 * Ruling W6-15. A proposal carries a whole document inside a `## Proposed content` fence, and that document has
 * headings of its own. `/^#\s+(.+)$/m` over the body found one of them the moment the note lost its own heading,
 * and the company's founding document reached the owner called "Proposed content".
 */
describe('noteTitle', () => {
  const FOUR = '`'.repeat(4);
  it('takes the note\u2019s own heading, never one from inside a fence', () => {
    const body = `Read it closely.\n\n## Proposed content\n\n${FOUR}\n# Proposed content\n\n## What the company is\n\nx\n${FOUR}\n`;
    expect(noteTitle(`# Founder Brief: PageSpeedAudit\n\n${body}`, 'founder_brief')).toBe('Founder Brief: PageSpeedAudit');
    expect(noteTitle(body, 'founder_brief')).toBe('Founder brief');
  });
  it('closes a fence only on one as long as the one that opened it', () => {
    // a ```` fence holding a ``` one: the inner fence is content, and so is every heading beside it
    expect(noteTitle(`${FOUR}\n\`\`\`\n# Inner\n\`\`\`\n# Still inside\n${FOUR}\n# Mine\n`, 'plan_verdict')).toBe('Mine');
  });
  it('says what the note is when it has no heading at all', () => {
    expect(noteTitle('', 'idea_verdict')).toBe('Idea verdict');
    expect(noteTitle('just prose\n', 'hire')).toBe('Hire');
    expect(noteTitle('## Only a subheading\n', 'spend')).toBe('Spend');
  });
  it('is what createProposal writes, for every note it writes', () => {
    const { path: rel } = createProposal(vault, { kind: 'hire', from: 'owner', title: 'Hire Performance Auditor', body: 'a charter' }, 'owner');
    const n = listInbox(vault).find((x) => x.path === rel)!;
    expect(noteTitle(n.body, n.data.kind)).toBe('Hire Performance Auditor');
  });
});
