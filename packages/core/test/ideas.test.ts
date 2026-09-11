import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IdeaFrontmatter, writeIdeaCard, readIdea, listIdeas, keptIdeas, updateIdea, nextIdeaForBoard, keptIdeaLines, missingScoreInputs, IDEA_SECTIONS } from '../src/ideas.js';
import { scaffoldVault } from '../src/template.js';
import { parseNote } from '../src/frontmatter.js';

describe('the idea card (minimal; sub-project 3 extends it)', () => {
  it('needs an id, a title and where it came from; everything else has a default', () => {
    const parsed = IdeaFrontmatter.parse({ id: 'competitor-dropped-free-tier', title: 'Competitor dropped its free tier', source: 'intelligence:competitive' });
    expect(parsed).toMatchObject({ status: 'new', evidence: [] });
    expect(typeof parsed.created).toBe('string');
    expect(IdeaFrontmatter.safeParse({ title: 'no id', source: 'x' }).success).toBe(false);
    expect(IdeaFrontmatter.safeParse({ id: 'a', title: 'b', source: 'c', status: 'shipped' }).success).toBe(false);
    for (const s of ['new', 'triaged', 'accepted', 'rejected']) {
      expect(IdeaFrontmatter.safeParse({ id: 'a', title: 'b', source: 'c', status: s }).success, s).toBe(true);
    }
  });

  it('the vault template ships a card that parses', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-ideas-'));
    const { vault } = await scaffoldVault(dir);
    try {
      const note = parseNote(vault.readText('Ideas/_template.md'));
      expect(IdeaFrontmatter.safeParse(note.data).success).toBe(true);
      expect(note.body).toMatch(/## What changed/);
      expect(note.body).toMatch(/## Why it might matter/);
      expect(note.body).toMatch(/## Evidence/);
    } finally { vault.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the card on disk (spec §2.3, §2.5)', () => {
  let dir: string;
  let vault: Awaited<ReturnType<typeof scaffoldVault>>['vault'];
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cubicle-idea-card-'));
    vault = (await scaffoldVault(dir)).vault;
  });
  afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

  it('writes the eight dossier sections and parses back', () => {
    const slug = writeIdeaCard(vault, { title: 'Meal kits for nurseries', source: 'discovery', evidence: ['Discovery/inbox/notes.md'], what_changed: 'The owner already sells to two nurseries.' }, 'research_manager');
    expect(slug).toBe('meal-kits-for-nurseries');
    const card = readIdea(vault, slug)!;
    for (const h of IDEA_SECTIONS) expect(card.body).toContain(h);
    expect(card.data).toMatchObject({ id: slug, source: 'discovery', status: 'new', decision: 'undecided', score: null });
    expect(card.data.evidence).toEqual(['Discovery/inbox/notes.md']);
  });

  it('is idempotent for the same title and suffixes a genuinely different one', () => {
    const a = writeIdeaCard(vault, { title: 'Meal kits', source: 'discovery' }, 'x');
    expect(writeIdeaCard(vault, { title: 'meal kits', source: 'discovery' }, 'x')).toBe(a);
    expect(writeIdeaCard(vault, { title: 'Meal kits', source: 'pantry', slug: 'meal-kits' }, 'x')).toBe(a);
    expect(writeIdeaCard(vault, { title: 'Meal Kits!', source: 'pantry', slug: 'meal-kits' }, 'x')).toBe('meal-kits-2');
  });

  it('derives the score from the inputs and never from the caller', () => {
    const slug = writeIdeaCard(vault, { title: 'Meal kits', source: 'discovery' }, 'x');
    const half = updateIdea(vault, slug, { score_inputs: { evidence: 4, fit: 3 }, research: 'Research/meal-kits/report.md', research_confidence: 'medium' }, 'research_manager', { heading: '## Research', content: 'Two nurseries already pay for this.' })!;
    expect(half.score).toBeNull();
    expect(missingScoreInputs(half.score_inputs)).toEqual(['value', 'effort']);
    const full = updateIdea(vault, slug, { score_inputs: { value: 4, effort: 4 }, estimate: 'Two weeks of one engineer.', score: 999 }, 'cfo', { heading: '## What it would cost', content: 'Two weeks of one engineer.' })!;
    expect(full.score).toBe(46);
    expect(readIdea(vault, slug)!.body).toContain('Two nurseries already pay for this.');
    expect(readIdea(vault, slug)!.body).toContain('Two weeks of one engineer.');
  });

  it('lists highest score first; keptIdeas is what a plan may draw on; _template.md is not an idea', () => {
    const low = writeIdeaCard(vault, { title: 'Low', source: 'owner' }, 'x');
    const high = writeIdeaCard(vault, { title: 'High', source: 'owner' }, 'x');
    updateIdea(vault, low, { score_inputs: { value: 2, evidence: 2, effort: 2, fit: 2 }, decision: 'scrap' }, 'x');
    updateIdea(vault, high, { score_inputs: { value: 5, evidence: 5, effort: 4, fit: 4 }, decision: 'keep' }, 'x');
    expect(listIdeas(vault).map((i) => i.id)).toEqual([high, low]);       // _template.md is skipped
    expect(keptIdeas(vault).map((i) => i.id)).toEqual([high]);
    expect(keptIdeaLines(keptIdeas(vault))[0]).toContain('[[Ideas/high]]');
  });

  it('sends the best unjudged card to the board, one per cycle', () => {
    const a = writeIdeaCard(vault, { title: 'Alpha', source: 'owner' }, 'x');
    const b = writeIdeaCard(vault, { title: 'Beta', source: 'owner' }, 'x');
    expect(nextIdeaForBoard(vault)).toBeNull();                           // neither is scored yet
    updateIdea(vault, a, { score_inputs: { value: 3, evidence: 3, effort: 3, fit: 3 } }, 'x');
    updateIdea(vault, b, { score_inputs: { value: 5, evidence: 4, effort: 4, fit: 4 } }, 'x');
    expect(nextIdeaForBoard(vault)!.id).toBe(b);
    updateIdea(vault, b, { board_verdict: 'pass' }, 'x');
    expect(nextIdeaForBoard(vault)!.id).toBe(a);
  });
});
