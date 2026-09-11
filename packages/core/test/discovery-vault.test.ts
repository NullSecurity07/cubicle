import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, templateDir } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { migrateOrg } from '../src/org.js';
import { parseNote } from '../src/frontmatter.js';
import { KNOWN_JOB_TYPES, ProposalKind } from '../src/schemas.js';
import { HEARTBEAT_WAKE_AREAS } from '../src/watcher.js';
import { loadGates, gatesFor, criteriaFor, gateAssignee } from '../src/gates.js';
import { IdeaFrontmatter, IDEA_SECTIONS } from '../src/ideas.js';
import { DISCOVERY_INBOX } from '../src/discovery.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-sp3-vault-')); });

describe('the three new job types and two new proposal kinds are additive (spec §7.4)', () => {
  it('adds without renaming anything', () => {
    for (const t of ['discovery', 'board.session', 'finance.estimate']) expect(KNOWN_JOB_TYPES).toContain(t);
    for (const t of ['engineer.ship', 'research', 'board.premortem', 'division.plan']) expect(KNOWN_JOB_TYPES).toContain(t);
    for (const k of ['founder_brief', 'idea_verdict']) expect(ProposalKind.safeParse(k).success).toBe(true);
    for (const k of ['plan_verdict', 'threat_model', 'message']) expect(ProposalKind.safeParse(k).success).toBe(true);
    expect(ProposalKind.safeParse('idea').success).toBe(false);
  });

  it('gives discovery a gate back to whoever asked, and leaves the cheap ones ungated', () => {
    const t = loadGates();
    expect(gatesFor(t, 'discovery')).toEqual(['requester.review']);
    expect(gatesFor(t, 'board.session')).toEqual([]);
    expect(gatesFor(t, 'finance.estimate')).toEqual([]);
    expect(criteriaFor(t, 'discovery')).toMatch(/founder brief/i);
    expect(criteriaFor(t, 'finance.estimate')).toMatch(/order of magnitude/i);
    // requester.review goes back to the job's `for`, which the discovery job sets to the chief executive.
    expect(gateAssignee('requester.review', { for: 'ceo' })).toBe('ceo');
  });

  it('wakes the company when the owner drops a file in or flips a card (spec §5.6)', () => {
    expect(HEARTBEAT_WAKE_AREAS).toContain('Discovery');
    expect(HEARTBEAT_WAKE_AREAS).toContain('Ideas');
    for (const a of ['Jobs', '00 Inbox', 'Brand', 'Roles', 'Teams']) expect(HEARTBEAT_WAKE_AREAS).toContain(a);
  });
});

describe('what a new vault ships with (spec §1.2, §2.3)', () => {
  it('has a Discovery/inbox the owner can drop files into', async () => {
    const { vault } = await scaffoldVault(dir);
    try {
      expect(vault.exists(`${DISCOVERY_INBOX}/README.md`)).toBe(true);
      expect(vault.readText(`${DISCOVERY_INBOX}/README.md`)).toMatch(/drop/i);
    } finally { vault.close(); }
  });

  it('ships an idea template that parses as a full dossier', async () => {
    const { vault } = await scaffoldVault(dir);
    try {
      const note = parseNote(vault.readText('Ideas/_template.md'));
      const parsed = IdeaFrontmatter.safeParse(note.data);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.decision).toBe('undecided');
      for (const h of IDEA_SECTIONS) expect(note.body).toContain(h);
    } finally { vault.close(); }
  });

  it('migrates an existing vault: Discovery/ appears, owner files are untouched', async () => {
    const { vault } = await scaffoldVault(dir);
    vault.close();
    // A vault from before SP3: the Discovery tree is gone and an owner file sits where migration writes.
    rmSync(path.join(dir, 'Discovery'), { recursive: true, force: true });
    mkdirSync(path.join(dir, 'Ideas'), { recursive: true });
    writeFileSync(path.join(dir, 'Ideas', 'mine.md'), '---\nid: mine\ntitle: Mine\nsource: owner\n---\n# Mine\n');
    const v2 = Vault.open(dir);
    try {
      const { changed } = migrateOrg(v2, templateDir());
      expect(changed).toContain(`${DISCOVERY_INBOX}/README.md`);
      expect(v2.readText('Ideas/mine.md')).toContain('# Mine');   // never clobbered
      expect(migrateOrg(v2, templateDir()).changed).not.toContain(`${DISCOVERY_INBOX}/README.md`);   // idempotent
    } finally { v2.close(); }
  });
});
