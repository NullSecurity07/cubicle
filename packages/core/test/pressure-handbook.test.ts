import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import { parseNote } from '../src/frontmatter.js';

const HANDBOOK = 'Docs/pressure-test-handbook.md';
let dir: string; let vault: Vault; let md: string;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-pg-hb-'));
  vault = (await scaffoldVault(dir)).vault;
  md = vault.readText(HANDBOOK);
});
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('Docs/pressure-test-handbook.md (spec §1)', () => {
  it('carries the headings a memory search goes looking for', () => {
    for (const h of [
      '## The core assumption',
      '## The failure catalogue',
      '## Is the pain real?',
      '## Founder-market fit',
      '## The three verdicts',
      '## The rubric',
      '## Tarpit ideas',
      '## The wedge',
    ]) expect(md, h).toMatch(new RegExp(`^${h.replace('?', '\\?')}\\s*$`, 'm'));
  });

  it('carries all six buckets of the failure catalogue, so "does this one apply to my idea?" has six answers', () => {
    for (const b of ['Demand', 'Customer structure', 'Distribution', 'Competition', 'Economics', 'Execution']) {
      expect(md, b).toMatch(new RegExp(`\\*\\*[A-F]\\. ${b}`));
    }
  });

  it('carries the five pain tests and the Mom Test\'s rule, which is what "is the pain real" actually means', () => {
    for (const t of ['Existing-solution', 'Money', 'Disappearance', 'Frequency', 'Urgency']) expect(md, t).toContain(t);
    expect(md).toMatch(/would you use this/i);
    expect(md).toMatch(/compliments are noise/i);
    expect(md).toMatch(/vitamin/i);
    expect(md).toMatch(/hair on fire/i);
  });

  it('states the three verdicts, the banned phrase and the meta-question, in the owner\'s own words', () => {
    for (const v of ['STRONG', 'WEAK', 'PIVOT REQUIRED']) expect(md, v).toContain(v);
    expect(md).toContain('it has potential, but');
    expect(md).toMatch(/would Paul Graham fund this in its current form/i);
    // The rubric the board actually writes: five dimensions, 0-2, out of 10.
    for (const d of ['core assumption', 'fatal flaws', 'pain', 'founder fit', 'why now']) expect(md, d).toContain(d);
    expect(md).toContain('/10');
  });

  // FR-5: the handbook said "answer in one word first" three lines above a verdict that is two words, and in
  // the owner's first live run the CEO returned a correct brief for exactly that contradiction.
  it('asks for the verdict first rather than for one word, and says two words are still one verdict', () => {
    expect(md).not.toMatch(/one word/i);
    expect(md).toMatch(/the verdict first/i);
    expect(md).toMatch(/PIVOT REQUIRED` is two words/);
  });

  it('keeps the notes\' one signal about how many founders there are (minor 5)', () => {
    // `startup-evaluation-notes.md` §founder-market fit: "Solo founders are a yellow flag (not red). Two
    // founders who've worked together before is the strongest signal." It is actionable, it is about
    // founder-market fit, and it is not a diagram, a worked example or a reading-list entry, so §7 does not
    // excuse it.
    expect(md).toMatch(/solo founder is a yellow flag/i);
    expect(md).toMatch(/worked together before/i);
  });

  it('names only paths and tools that exist', () => {
    for (const p of ['Ideas/<slug>.md', 'Memory/founder-brief.md', 'Docs/ideas-handbook.md']) expect(md, p).toContain(p);
    expect(md).not.toMatch(/pressure\.test|idea\.pressure|board\.evaluate/);   // tools that do not exist
    expect(md).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);         // no emoji
  });

  it('is short enough that an agent will read it', () => {
    const lines = md.split('\n').length;
    expect(lines).toBeGreaterThan(100);
    expect(lines).toBeLessThan(190);
  });
});

describe('the three advisors take the evaluator\'s three stances (spec §1)', () => {
  const body = (role: string): string => parseNote(vault.readText(`Roles/${role}.md`)).body;
  const data = (role: string): Record<string, unknown> => parseNote(vault.readText(`Roles/${role}.md`)).data as Record<string, unknown>;

  it('the skeptic hunts fatal flaws in the catalogue', () => {
    const b = body('advisor_skeptic');
    expect(b).toContain(HANDBOOK);
    expect(b).toMatch(/three most likely/i);
    expect(b).toMatch(/specific to this idea/i);
    expect(b).toMatch(/failure catalogue/i);
  });

  it('the investor asks whether it would be funded, and why now', () => {
    const b = body('advisor_investor');
    expect(b).toContain(HANDBOOK);
    expect(b).toMatch(/would Paul Graham fund this/i);
    expect(b).toMatch(/why now/i);
  });

  it('the customer runs the pain tests and the Mom Test', () => {
    const b = body('advisor_customer');
    expect(b).toContain(HANDBOOK);
    expect(b).toMatch(/workaround/i);
    expect(b).toMatch(/vitamin|painkiller|hair on fire/i);
    expect(b).toMatch(/Mom Test/i);
  });

  it('and nothing about the roster moved: same tiers, tools, desks, teams and permissions', () => {
    expect(data('advisor_skeptic').model_tier).toBe('strong');
    expect(data('advisor_investor').model_tier).toBe('medium');
    expect(data('advisor_customer').model_tier).toBe('medium');
    for (const r of ['advisor_skeptic', 'advisor_investor', 'advisor_customer']) {
      expect(data(r).team, r).toBe('board');
      expect((data(r).permissions as string[]).slice().sort(), r).toEqual(['review', 'veto']);
      expect(data(r).desk, r).toBe(r);
    }
    // The title said "tools" and never checked them (minor 6). SP5b changed `# Standing rules` and nothing
    // else on these three notes, so the lists are pinned here rather than asserted to be merely non-empty.
    const base = ['vault.read', 'vault.search', 'vault.list', 'vault.write', 'http.fetch', 'colleague.message', 'skills.load', 'skills.search', 'finish'];
    expect(data('advisor_skeptic').tools).toEqual(base);
    expect(data('advisor_customer').tools).toEqual(base);
    expect(data('advisor_investor').tools).toEqual(['vault.read', 'vault.search', 'vault.list', 'vault.write', 'http.fetch', 'analytics.pull', 'colleague.message', 'skills.load', 'skills.search', 'finish']);
  });
});

describe('the ideas handbook points at it', () => {
  it('names the handbook and the three verdicts, and is still short', () => {
    const ideas = vault.readText('Docs/ideas-handbook.md');
    expect(ideas).toContain(HANDBOOK);
    expect(ideas).toContain('PIVOT REQUIRED');
    expect(ideas.split('\n').length).toBeLessThan(120);
  });
});
