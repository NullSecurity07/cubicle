import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  IdeaFrontmatter, writeIdeaCard, readIdea, listIdeas, keptIdeas, updateIdea, nextIdeaForBoard, keptIdeaLines,
  missingScoreInputs, missingScoreNote, sameIdeaTitle, IDEA_SECTIONS,
  ownerHasSeenIdea, ideaOpenToBoard, sweepIdeas, sweepIdeaRows, renderSweepIdeasSection, SWEEP_IDEAS_SECTION,
} from '../src/ideas.js';
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
    // Punctuation is not a second idea: these all slugify to `meal-kits`, and comparing the raw strings gave
    // one idea two dossiers, each scored, judged and decided on its own (whole-branch review, minor 8).
    expect(writeIdeaCard(vault, { title: 'Meal Kits!', source: 'pantry', slug: 'meal-kits' }, 'x')).toBe(a);
    expect(writeIdeaCard(vault, { title: 'Meal kits.', source: 'pantry' }, 'x')).toBe(a);
    expect(sameIdeaTitle('Meal kits for nurseries', 'meal  kits — for nurseries.')).toBe(true);
    expect(sameIdeaTitle('Meal kits', 'Meal kits for schools')).toBe(false);
    // Different words on a slug that is already taken is still a genuinely different idea, and gets its own card.
    expect(writeIdeaCard(vault, { title: 'Nursery meal kits', source: 'pantry', slug: 'meal-kits' }, 'x')).toBe('meal-kits-2');
  });

  it('says what an unscored card is waiting for, and whose desk it is on', () => {
    const slug = writeIdeaCard(vault, { title: 'Nursery lunches', source: 'discovery' }, 'x');
    expect(readIdea(vault, slug)!.body).toContain('value and effort from the finance office, evidence and fit from the research office');
    expect(missingScoreNote(['evidence'])).toBe('evidence from the research office');
    expect(missingScoreNote([])).toBe('');
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

/**
 * Ruling W3-5. The third live run spent a sixteen-call board session, a decision note and a question to the
 * owner about engineering hours on *Persistent Agent Memory Integration* — a card an intelligence sweep had
 * filed and nobody had ever mentioned to the owner. A card the owner has not seen is a note, not a candidate.
 */
describe('the board sits only on ideas the owner has seen (ruling W3-5)', () => {
  let dir: string;
  let vault: Awaited<ReturnType<typeof scaffoldVault>>['vault'];
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cubicle-owner-seen-'));
    vault = (await scaffoldVault(dir)).vault;
  });
  afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

  const scored = (slug: string, inputs: { value: number; evidence: number; effort: number; fit: number }) =>
    updateIdea(vault, slug, { score_inputs: inputs }, 'daemon');

  it('never hands the board a scored sweep card, and hands it over the moment the owner marks it keep', () => {
    const sweep = writeIdeaCard(vault, { title: 'Persistent agent memory', source: 'intelligence:competitive', why_it_matters: 'Two rivals shipped it this month.' }, 'daemon');
    scored(sweep, { value: 5, evidence: 5, effort: 5, fit: 5 });           // 60: the best-scoring card there is
    expect(readIdea(vault, sweep)!.data.score).toBe(60);
    expect(nextIdeaForBoard(vault)).toBeNull();                            // …and still nobody asked for it

    const own = writeIdeaCard(vault, { title: 'Meal kits for nurseries', source: 'discovery' }, 'daemon');
    scored(own, { value: 3, evidence: 3, effort: 3, fit: 3 });             // 33: the owner's own material wins
    expect(nextIdeaForBoard(vault)!.id).toBe(own);

    // The promote: `decision: keep` on a sweep card reads "have the board look at this".
    updateIdea(vault, sweep, { decision: 'keep' }, 'owner');
    expect(nextIdeaForBoard(vault)!.id).toBe(sweep);
    // And only until the board has actually sat on it.
    updateIdea(vault, sweep, { board_verdict: 'pass' }, 'daemon');
    expect(nextIdeaForBoard(vault)!.id).toBe(own);
  });

  it('reads the owner\'s own sources, and a parked or scrapped sweep card is finished business', () => {
    for (const source of ['discovery', 'owner', 'pantry', 'board']) {
      expect(ownerHasSeenIdea({ source, decision: 'undecided' }), source).toBe(true);
      expect(ideaOpenToBoard({ source, decision: 'undecided' }), source).toBe(true);
      // A kept card of the owner's own is not a board candidate: that decision has already been taken, and
      // `ideas_board` runs before `company_plan`, so their own card is judged while it is still undecided.
      expect(ideaOpenToBoard({ source, decision: 'keep' }), source).toBe(false);
    }
    expect(ownerHasSeenIdea({ source: 'intelligence:competitive', decision: 'undecided' })).toBe(false);
    expect(ownerHasSeenIdea({ source: 'intelligence:competitive', decision: 'keep' })).toBe(true);
    for (const decision of ['park', 'scrap']) {
      expect(ideaOpenToBoard({ source: 'intelligence:competitive', decision })).toBe(false);
      expect(ownerHasSeenIdea({ source: 'intelligence:competitive', decision })).toBe(false);
    }
  });

  it('lists the sweep\'s unpromoted cards for the brief: title, one line of why, and how to promote one', () => {
    const sweep = writeIdeaCard(vault, { title: 'Persistent agent memory', source: 'intelligence:competitive', why_it_matters: 'Two rivals shipped it this month.\nA third is hiring for it.' }, 'daemon');
    const quiet = writeIdeaCard(vault, { title: 'A newsletter about spoons', source: 'intelligence:market' }, 'daemon');
    writeIdeaCard(vault, { title: 'Meal kits for nurseries', source: 'discovery', why_it_matters: 'The owner already sells to two nurseries.' }, 'daemon');

    expect(sweepIdeas(vault).map((i) => i.id).sort()).toEqual([quiet, sweep].sort());
    const rows = sweepIdeaRows(vault);
    expect(rows.find((r) => r.id === sweep)!.why).toBe('Two rivals shipped it this month.');
    expect(rows.find((r) => r.id === quiet)!.why).toBe('');                // `_Not stated._` is not a reason
    const section = renderSweepIdeasSection(rows);
    expect(section).toContain('**Persistent agent memory** — Two rivals shipped it this month.');
    expect(section).toContain(`[[Ideas/${sweep}]]`);
    expect(section).toContain(`set \`decision: keep\` on Ideas/${sweep}.md or say so to the CEO`);
    expect(section).toContain('the card gives no reason yet');
    expect(section).not.toContain('Meal kits');                            // the owner's own card is not "the sweep's"

    // Promoted or ruled on, it leaves the list: it is the board's business now, or nobody's.
    updateIdea(vault, sweep, { decision: 'keep' }, 'owner');
    updateIdea(vault, quiet, { decision: 'scrap' }, 'owner');
    expect(sweepIdeas(vault)).toEqual([]);
    expect(SWEEP_IDEAS_SECTION).toBe('## Ideas the sweep found');
  });
});
