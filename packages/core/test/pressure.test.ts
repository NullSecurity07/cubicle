import { describe, it, expect } from 'vitest';
import {
  PRESSURE_VERDICTS, BANNED_HEDGE, RUBRIC_DIMENSIONS, RUBRIC_MAX, BoardRubric,
  readPressureVerdict, parseRubric, rubricTotal, rubricBand, renderRubric,
  pressureToBoard, pressureFindings, PRESSURE_NO_WEDGE, PRESSURE_REFUSAL_HEDGE, PRESSURE_REFUSAL_MISSING,
  PRESSURE_HANDBOOK_PATH,
} from '../src/pressure.js';

const STRONG = [
  'VERDICT: STRONG',
  'RUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1',
  '',
  '## Core Assumption',
  'Nurseries will pay 40 a week to stop planning meals.',
  '',
  '## Three Fatal Flaws',
  '- The county caterer already holds the contract and renews every August',
  '- Allergen liability sits with the nursery, so the manager will not delegate the menu',
  '- Delivery before 7am needs a van you do not have',
  '',
  '## Problem Validation',
  '- They run the menu off a shared spreadsheet today, which is an ugly workaround',
  '',
  '## Founder-Market Fit',
  'The owner ran a nursery kitchen for six years.',
  '',
  '## Brutal Verdict',
  'Build the cheap test this week.',
].join('\n');

describe('the three verdicts, and nothing else (spec §3)', () => {
  it('reads each of the three, and maps them to the board', () => {
    expect(readPressureVerdict(STRONG)).toMatchObject({ ok: true, verdict: 'STRONG' });
    expect(readPressureVerdict('VERDICT: WEAK\n- nobody is hacking a solution today')).toMatchObject({ ok: true, verdict: 'WEAK' });
    expect(readPressureVerdict('VERDICT: PIVOT REQUIRED')).toMatchObject({ ok: true, verdict: 'PIVOT REQUIRED' });
    expect(pressureToBoard('STRONG')).toBe('pass');
    expect(pressureToBoard('WEAK')).toBe('return');
    expect(pressureToBoard('PIVOT REQUIRED')).toBe('return');
  });

  it('accepts the shapes a chair actually writes, and the notes\' own one-word template', () => {
    // The owner's one-page template ends `VERDICT (one word first): STRONG / WEAK / PIVOT` (Decision 5).
    expect(readPressureVerdict('VERDICT: PIVOT')).toMatchObject({ ok: true, verdict: 'PIVOT REQUIRED' });
    expect(readPressureVerdict('**VERDICT:** strong')).toMatchObject({ ok: true, verdict: 'STRONG' });
    expect(readPressureVerdict('VERDICT: STRONG — the pain is real and they already pay someone')).toMatchObject({ ok: true, verdict: 'STRONG' });
    expect(readPressureVerdict('VERDICT: weak, do not build this')).toMatchObject({ ok: true, verdict: 'WEAK' });
    expect(readPressureVerdict('preamble nobody asked for\n\nVERDICT: WEAK')).toMatchObject({ ok: true, verdict: 'WEAK' });
  });

  it('refuses the banned phrase, a fourth outcome, and an answer with no verdict at all', () => {
    const hedge = readPressureVerdict('VERDICT: STRONG\n\nIt has potential, but the margins worry me.');
    expect(hedge).toMatchObject({ ok: false });
    expect(hedge.ok === false && hedge.reason).toBe(PRESSURE_REFUSAL_HEDGE);
    expect(PRESSURE_REFUSAL_HEDGE).toContain(BANNED_HEDGE);
    const fourth = readPressureVerdict('VERDICT: MAYBE\n- unclear');
    expect(fourth.ok).toBe(false);
    expect(fourth.ok === false && fourth.reason).toContain('MAYBE');
    expect(fourth.ok === false && fourth.reason).toContain(PRESSURE_VERDICTS[0]);
    const silent = readPressureVerdict('- the county caterer already holds the contract');
    expect(silent.ok === false && silent.reason).toBe(PRESSURE_REFUSAL_MISSING);
    expect(readPressureVerdict('').ok).toBe(false);
  });

  it('catches the hedge however the chair punctuates it (G10)', () => {
    // The notes and both handbooks write it with a comma; the chair writes it either way.
    const hedged = [
      'VERDICT: STRONG\n\nIt has potential, but the margins worry me.',
      'VERDICT: STRONG\n\nIt has potential but the margins worry me.',
      'VERDICT: WEAK\n\nit  has   potential ,  but nobody is paying.',
      'VERDICT: PIVOT REQUIRED\n\nIT HAS POTENTIAL, BUT the buyer is wrong.',
      'VERDICT: STRONG\n\nit has potential,\nbut the margins worry me.',
    ];
    for (const t of hedged) {
      const r = readPressureVerdict(t);
      expect(r.ok, t).toBe(false);
      expect(r.ok === false && r.reason).toBe(PRESSURE_REFUSAL_HEDGE);
    }
    // …and does not refuse a chair who never used the phrase.
    expect(readPressureVerdict('VERDICT: STRONG\n\nThe potential buyers are already paying someone.').ok).toBe(true);
    expect(readPressureVerdict('VERDICT: STRONG\n\nIt has potential buttons nobody presses.').ok).toBe(true);
  });

  it('names the handbook once, so the prompts and the card cannot drift', () => {
    expect(PRESSURE_HANDBOOK_PATH).toBe('Docs/pressure-test-handbook.md');
  });
});

describe('the flaws are the flaws, not every bullet on the page (Decision 9)', () => {
  it('takes them from the fatal-flaws section when the chair wrote the five parts', () => {
    const r = readPressureVerdict(STRONG);
    expect(r.ok && r.flaws).toEqual([
      'The county caterer already holds the contract and renews every August',
      'Allergen liability sits with the nursery, so the manager will not delegate the menu',
      'Delivery before 7am needs a van you do not have',
    ]);
    expect(r.ok && r.flaws.join(' ')).not.toContain('shared spreadsheet');
  });

  it('falls back to every bullet when there are no headings, and caps at four', () => {
    const flat = ['VERDICT: WEAK', ...Array.from({ length: 7 }, (_, i) => `- flaw number ${i}`)].join('\n');
    const r = readPressureVerdict(flat);
    expect(r.ok && r.flaws).toHaveLength(4);
    expect(r.ok && r.flaws[0]).toBe('flaw number 0');
  });

  it('never files the machine lines as flaws', () => {
    const r = readPressureVerdict('VERDICT: PIVOT REQUIRED\n- RUBRIC: core assumption 1\n- WEDGE: one nursery chain\n- the real flaw here');
    expect(r.ok && r.flaws).toEqual(['the real flaw here']);
  });
});

describe('a pivot leads with the wedge (spec §3)', () => {
  it('puts the wedge first, and says so when there is none', () => {
    const r = readPressureVerdict('VERDICT: PIVOT REQUIRED\n- the buyer is not the user\nWEDGE: one nursery chain, the 40 sites that already order together');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    const f = pressureFindings(r);
    expect(f[0]).toBe('Pivot required. The wedge to attack instead: one nursery chain, the 40 sites that already order together');
    expect(f[1]).toBe('the buyer is not the user');
    const bare = readPressureVerdict('VERDICT: PIVOT REQUIRED\n- the buyer is not the user');
    expect(bare.ok && pressureFindings(bare)[0]).toBe(PRESSURE_NO_WEDGE);
  });

  it('a strong or weak verdict carries only its flaws', () => {
    const r = readPressureVerdict('VERDICT: WEAK\n- nobody is hacking a solution today\nWEDGE: ignored on a weak verdict');
    expect(r.ok && pressureFindings(r)).toEqual(['nobody is hacking a solution today']);
  });
});

describe('the 0-2 x 5 rubric (spec §6)', () => {
  it('parses all five or none, and sums to ten at most', () => {
    const r = parseRubric('RUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1');
    expect(r).toEqual({ core_assumption: 2, fatal_flaws: 1, pain: 2, founder_fit: 1, why_now: 1 });
    expect(rubricTotal(r!)).toBe(7);
    expect(RUBRIC_DIMENSIONS).toHaveLength(5);
    expect(rubricTotal({ core_assumption: 2, fatal_flaws: 2, pain: 2, founder_fit: 2, why_now: 2 })).toBe(RUBRIC_MAX);
    // Four scores and a guess is not a rubric (Decision 10).
    expect(parseRubric('RUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 1')).toBeNull();
    expect(parseRubric('nothing here')).toBeNull();
    expect(parseRubric('RUBRIC: core assumption 3, fatal flaws 1, pain 2, founder fit 1, why now 1')).toBeNull();
  });

  it('reads the labels a chair varies, and the bands the notes set', () => {
    expect(parseRubric('- **RUBRIC**: core assumption: 1; flaws: 2; pain level: 0; founder-market fit: 2; why now: 1')).toEqual({ core_assumption: 1, fatal_flaws: 2, pain: 0, founder_fit: 2, why_now: 1 });
    expect(rubricBand(9)).toBe('strong');
    expect(rubricBand(8)).toBe('strong');
    expect(rubricBand(7)).toBe('pivot');
    expect(rubricBand(5)).toBe('pivot');
    expect(rubricBand(4)).toBe('weak');
    expect(rubricBand(0)).toBe('weak');
  });

  it('renders as one line a reader can check against the numbers', () => {
    expect(renderRubric({ core_assumption: 2, fatal_flaws: 1, pain: 2, founder_fit: 1, why_now: 1 }))
      .toBe('7/10 — core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1');
  });

  it('validates as a zod object, so a card carrying one round-trips', () => {
    expect(BoardRubric.safeParse({ core_assumption: 0, fatal_flaws: 0, pain: 0, founder_fit: 0, why_now: 0 }).success).toBe(true);
    expect(BoardRubric.safeParse({ core_assumption: 1 }).success).toBe(false);
    expect(BoardRubric.safeParse({ core_assumption: 1.5, fatal_flaws: 1, pain: 1, founder_fit: 1, why_now: 1 }).success).toBe(false);
  });

  it('rides along with a verdict when the chair wrote one', () => {
    expect(readPressureVerdict(STRONG)).toMatchObject({ rubric: { core_assumption: 2, why_now: 1 } });
    expect(readPressureVerdict('VERDICT: WEAK')).toMatchObject({ rubric: null });
  });
});
