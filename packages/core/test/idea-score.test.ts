import { describe, it, expect } from 'vitest';
import {
  IdeaFrontmatter, IdeaScoreInputs, IDEA_SCORE_WEIGHTS, IDEA_SCORE_MAX, KEEP_AT, PARK_AT,
  ideaScore, ideaBand, bandReason, missingScoreInputs, renderScoreSection,
  ideaSlug, ideaSourceKind, ideasNamedIn, unkeptIdeasNamedIn, ideaOutcome, CHOSEN_DECISIONS,
  renderBoardSection,
} from '../src/ideas.js';

const inputs = { value: 4, evidence: 4, effort: 4, fit: 3 };

describe('the idea score (spec §2.4)', () => {
  it('is 4·value + 3·evidence + 3·effort + 2·fit, from 12 to 60', () => {
    expect(IDEA_SCORE_WEIGHTS).toEqual({ value: 4, evidence: 3, effort: 3, fit: 2 });
    expect(ideaScore({ value: 1, evidence: 1, effort: 1, fit: 1 })).toBe(12);
    expect(ideaScore({ value: 5, evidence: 5, effort: 5, fit: 5 })).toBe(IDEA_SCORE_MAX);
    expect(ideaScore(inputs)).toBe(4 * 4 + 3 * 4 + 3 * 4 + 2 * 3);   // 46
  });

  it('names the inputs that are missing or out of range, in weight order', () => {
    expect(missingScoreInputs(inputs)).toEqual([]);
    expect(missingScoreInputs({})).toEqual(['value', 'evidence', 'effort', 'fit']);
    expect(missingScoreInputs({ ...inputs, effort: 9 })).toEqual(['effort']);
    expect(missingScoreInputs({ evidence: 3, fit: 3 })).toEqual(['value', 'effort']);
    expect(missingScoreInputs(undefined)).toEqual(['value', 'evidence', 'effort', 'fit']);
  });

  it('bands on the arithmetic: keep at 44, park at 26, scrap below', () => {
    expect(ideaBand(KEEP_AT, { value: 5 })).toBe('keep');
    expect(ideaBand(KEEP_AT - 1, { value: 5 })).toBe('park');
    expect(ideaBand(PARK_AT, { value: 5 })).toBe('park');
    expect(ideaBand(PARK_AT - 1, { value: 5 })).toBe('scrap');
    expect(ideaBand(ideaScore({ value: 3, evidence: 3, effort: 3, fit: 3 }), { value: 3 })).toBe('park');
    expect(ideaBand(ideaScore({ value: 2, evidence: 2, effort: 2, fit: 2 }), { value: 2 })).toBe('scrap');
  });

  it('parks, never keeps, an idea nobody would pay much for however cheap it is', () => {
    const cheapAndPointless = { value: 2, evidence: 5, effort: 5, fit: 5 };
    expect(ideaScore(cheapAndPointless)).toBe(48);
    expect(ideaBand(48, { value: 2 })).toBe('park');
    expect(bandReason(48, { value: 2 })).toContain('nobody would pay enough');
  });

  it('parks an idea the board returned, and leaves a scrap a scrap', () => {
    expect(ideaBand(50, { value: 5, board: 'pass' })).toBe('keep');
    expect(ideaBand(50, { value: 5, board: 'return' })).toBe('park');
    expect(ideaBand(20, { value: 5, board: 'return' })).toBe('scrap');   // the board never rescues a scrap
    expect(bandReason(50, { value: 5, board: 'return' })).toContain('the board returned it');
  });

  it('renders the arithmetic so a reader can check it', () => {
    const md = renderScoreSection(inputs);
    expect(md).toContain('4 × 4 value + 3 × 4 evidence + 3 × 4 effort + 2 × 3 fit = **46** of 60');
    expect(md).toContain('**Recommendation:** keep');
    expect(renderScoreSection(inputs, { board: 'return' })).toContain('**Recommendation:** park');
  });

  it('the owner adopts, overrules or parks (spec §3.5)', () => {
    expect(ideaOutcome({ approved: null, chosen: null, band: 'keep' })).toBe('pending');
    expect(ideaOutcome({ approved: true, chosen: null, band: 'keep' })).toBe('keep');
    expect(ideaOutcome({ approved: true, chosen: null, band: 'scrap' })).toBe('scrap');
    expect(ideaOutcome({ approved: true, chosen: 3, band: 'keep' })).toBe('scrap');
    expect(ideaOutcome({ approved: true, chosen: 1, band: 'scrap' })).toBe('keep');
    expect(ideaOutcome({ approved: true, chosen: 9, band: 'park' })).toBe('park');   // a nonsense chosen falls back
    expect(ideaOutcome({ approved: false, chosen: null, band: 'keep' })).toBe('park');
    expect(CHOSEN_DECISIONS).toEqual({ 1: 'keep', 2: 'park', 3: 'scrap' });
  });
});

describe('idea provenance and slugs (spec §2.2)', () => {
  it('reads the source kind, including the intelligence sweep it came from', () => {
    expect(ideaSourceKind('discovery')).toBe('discovery');
    expect(ideaSourceKind('intelligence:competitive')).toBe('intelligence');
    expect(ideaSourceKind('pantry')).toBe('pantry');
    expect(ideaSourceKind('owner')).toBe('owner');
    expect(ideaSourceKind('job_20260911_abc')).toBe('job');
    expect(ideaSourceKind('a hunch')).toBe('unknown');
  });

  it('slugs a title into something that is a filename and a wikilink target', () => {
    expect(ideaSlug('Sell the meal planner to nurseries')).toBe('sell-the-meal-planner-to-nurseries');
    expect(ideaSlug('  ¡Hola! — 2026 ')).toBe('hola-2026');
    expect(ideaSlug('!!!')).toBe('idea');
    expect(ideaSlug('x'.repeat(80)).length).toBeLessThanOrEqual(48);
  });
});

describe('a plan may draw only on kept ideas (spec §4)', () => {
  const ideas = [
    { id: 'meal-kits', decision: 'keep' as const },
    { id: 'nursery-pilot', decision: 'park' as const },
    { id: 'crypto-loyalty', decision: 'scrap' as const },
    { id: 'b2b-api', decision: 'undecided' as const },
  ];

  it('finds ideas by wikilink and by bare path, never by title', () => {
    expect(ideasNamedIn('- Ship [[Ideas/meal-kits]] this cycle')).toEqual(['meal-kits']);
    expect(ideasNamedIn('see Ideas/nursery-pilot.md')).toEqual(['nursery-pilot']);
    expect(ideasNamedIn('- Launch the crypto loyalty programme')).toEqual([]);
  });

  it('needs a boundary on the left: MyIdeas/foo is not Ideas/foo (Task 1 review)', () => {
    expect(ideasNamedIn('- see MyIdeas/crypto-loyalty.md')).toEqual([]);
    expect(ideasNamedIn('- BadIdeas/meal-kits is someone else\'s folder')).toEqual([]);
    expect(ideasNamedIn('- x_Ideas/meal-kits and 9Ideas/meal-kits')).toEqual([]);
    // Ideas live at the top of the vault; another folder's `Ideas/` is not this one.
    expect(ideasNamedIn('- Archive/Ideas/crypto-loyalty and Docs/Ideas/meal-kits.md')).toEqual([]);
    expect(unkeptIdeasNamedIn('- Ship MyIdeas/crypto-loyalty this cycle', ideas)).toEqual([]);
    expect(unkeptIdeasNamedIn('- Ship Archive/Ideas/crypto-loyalty this cycle', ideas)).toEqual([]);
    // …and still matches the real thing wherever a plan puts it.
    expect(ideasNamedIn('(Ideas/meal-kits.md)')).toEqual(['meal-kits']);
    expect(ideasNamedIn('Ideas/meal-kits at the start of the line')).toEqual(['meal-kits']);
  });

  it('returns the unkept ideas a plan names, and nothing for a clean plan', () => {
    expect(unkeptIdeasNamedIn('- Ship [[Ideas/meal-kits]]', ideas)).toEqual([]);
    expect(unkeptIdeasNamedIn('- Ship [[Ideas/crypto-loyalty]]', ideas).map((i) => i.id)).toEqual(['crypto-loyalty']);
    expect(unkeptIdeasNamedIn('- [[Ideas/nursery-pilot]] and [[Ideas/b2b-api]]', ideas).map((i) => i.decision).sort())
      .toEqual(['park', 'undecided']);
  });

  it('an SP7-era minimal card still parses, with every new field defaulted', () => {
    const parsed = IdeaFrontmatter.parse({ id: 'competitor-dropped-free-tier', title: 'x', source: 'intelligence:competitive' });
    expect(parsed).toMatchObject({ status: 'new', evidence: [], decision: 'undecided', score: null, score_inputs: {}, research: '', board_verdict: null });
    expect(IdeaScoreInputs.partial().safeParse({}).success).toBe(true);
  });
});

const RUBRIC = { core_assumption: 2, fatal_flaws: 1, pain: 2, founder_fit: 1, why_now: 1 };

describe('the board\'s rubric on a card is additive, and decides nothing (spec §6)', () => {
  it('a card written before the pressure test existed still parses, and gets the defaults', () => {
    const old = { id: 'meal-kits', title: 'Meal kits', source: 'discovery', created: '2026-09-01T00:00:00.000Z' };
    const p = IdeaFrontmatter.safeParse(old);
    expect(p.success).toBe(true);
    expect(p.success && p.data.board_rubric).toBeNull();
    expect(p.success && p.data.board_pressure).toBe('');
    // Nothing the card already carried moved.
    expect(p.success && p.data.score).toBeNull();
    expect(p.success && p.data.board_verdict).toBeNull();
    expect(p.success && p.data.decision).toBe('undecided');
  });

  it('a rubric round-trips, and a broken one is refused rather than half-stored', () => {
    const base = { id: 'x', title: 'x', source: 'owner', created: '2026-09-12T00:00:00.000Z' };
    expect(IdeaFrontmatter.parse({ ...base, board_rubric: RUBRIC }).board_rubric).toEqual(RUBRIC);
    expect(IdeaFrontmatter.safeParse({ ...base, board_rubric: { core_assumption: 2 } }).success).toBe(false);
    expect(IdeaFrontmatter.safeParse({ ...base, board_rubric: { ...RUBRIC, why_now: 5 } }).success).toBe(false);
  });

  it('a 10/10 pressure test does not keep an idea the arithmetic parks, and a 0/10 does not scrap one', () => {
    expect(ideaBand(46, { value: 4, board: 'pass' })).toBe('keep');
    expect(ideaBand(46, { value: 4, board: 'return' })).toBe('park');
    expect(ideaBand(20, { value: 4, board: 'pass' })).toBe('scrap');
    const score = renderScoreSection({ value: 4, evidence: 4, effort: 4, fit: 3 }, { board: 'pass' });
    expect(score).not.toMatch(/rubric|pressure/i);
  });
});

describe('renderBoardSection is the one sentence three surfaces share', () => {
  it('says the verdict, the pressure test, the rubric and the flaws', () => {
    const s = renderBoardSection({
      verdict: 'return', advisors: 3, date: '2026-09-12', decision: 'Decisions/board-meal-kits.md',
      findings: ['the payer is not the user'], pressure: 'PIVOT REQUIRED', rubric: RUBRIC,
    });
    expect(s).toContain('**Returned** — 3 advisors, 2026-09-12. See [[Decisions/board-meal-kits]].');
    expect(s).toContain('**Pressure test:** PIVOT REQUIRED. Rubric 7/10 — core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1.');
    expect(s).toContain('- the payer is not the user');
  });

  it('a board that answered without a rubric, and one from before the pressure test, both still render', () => {
    expect(renderBoardSection({ verdict: 'pass', advisors: 3, date: '2026-09-12', decision: '', findings: [], pressure: 'STRONG', rubric: null }))
      .toBe('**Passed** — 3 advisors, 2026-09-12.\n\n**Pressure test:** STRONG.\n\n- Nothing they thought would sink it.');
    // What the step wrote before SP5b, byte for byte.
    expect(renderBoardSection({ verdict: 'pass', advisors: 3, date: '2026-09-11', decision: 'Decisions/board-meal-kits.md', findings: ['nobody has priced delivery'] }))
      .toBe('**Passed** — 3 advisors, 2026-09-11. See [[Decisions/board-meal-kits]].\n\n- nobody has priced delivery');
  });
});
