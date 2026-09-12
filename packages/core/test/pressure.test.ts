import { describe, it, expect } from 'vitest';
import {
  PRESSURE_VERDICTS, BANNED_HEDGE, RUBRIC_DIMENSIONS, RUBRIC_MAX, BoardRubric,
  readPressureVerdict, parseRubric, rubricTotal, renderRubric,
  pressureToBoard, pressureFindings, PRESSURE_NO_WEDGE, PRESSURE_REFUSAL_HEDGE, PRESSURE_REFUSAL_MISSING,
  PRESSURE_HANDBOOK_PATH, PRESSURE_NO_FLAWS,
} from '../src/pressure.js';

/** The two machine lines the chair's prompt shows it, verbatim. A chair that reprints them has not voted. */
const ECHO = [
  'VERDICT: STRONG | WEAK | PIVOT REQUIRED',
  'RUBRIC: core assumption <0-2>, fatal flaws <0-2>, pain <0-2>, founder fit <0-2>, why now <0-2>',
].join('\n');

/** A flaws section, for the cases that are about something else. */
const FLAWS = (...f: string[]) => ['## Three Fatal Flaws', ...f.map((x) => `- ${x}`)].join('\n');

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

  it('caps the section at four', () => {
    const many = ['VERDICT: WEAK', FLAWS(...Array.from({ length: 7 }, (_, i) => `flaw number ${i}`))].join('\n');
    const r = readPressureVerdict(many);
    expect(r.ok && r.flaws).toHaveLength(4);
    expect(r.ok && r.flaws[0]).toBe('flaw number 0');
  });

  it('never files the machine lines as flaws', () => {
    const r = readPressureVerdict('VERDICT: PIVOT REQUIRED\n## Three Fatal Flaws\n- RUBRIC: core assumption 1\n- WEDGE: one nursery chain\n- the real flaw here');
    expect(r.ok && r.flaws).toEqual(['the real flaw here']);
  });

  it('never reaches outside the section, even when there is no section to read', () => {
    // The fallback to every bullet in the answer is the thing Decision 9 forbids: this is what it filed.
    const prose = [
      'VERDICT: WEAK',
      '## Three Fatal Flaws',
      'One, the caterer. Two, liability. Three, the van.',
      '## Problem Validation',
      '- they use a spreadsheet today',
    ].join('\n');
    const r = readPressureVerdict(prose);
    expect(r.ok && r.flaws).toEqual(['One, the caterer. Two, liability. Three, the van.']);

    // A next heading with no space after the hashes still closes the section.
    const tight = ['VERDICT: WEAK', '## Three Fatal Flaws', '- the caterer holds the contract', '##Problem Validation', '- they use a spreadsheet today'].join('\n');
    expect(readPressureVerdict(tight).ok && (readPressureVerdict(tight) as { flaws: string[] }).flaws).toEqual(['the caterer holds the contract']);

    // No section at all is no flaws — and the finding says so rather than arriving empty.
    const none = readPressureVerdict('VERDICT: WEAK\n- they use a spreadsheet today');
    expect(none.ok && none.flaws).toEqual([]);
    expect(none.ok && pressureFindings(none)).toEqual([PRESSURE_NO_FLAWS]);
  });
});

describe('an echoed format line is not a vote (review T12 finding 1)', () => {
  it('ignores the line that names all three, and takes the chair\'s real verdict', () => {
    const r = readPressureVerdict([ECHO, '', 'The board talked it over.', '', 'VERDICT: WEAK'].join('\n'));
    expect(r).toMatchObject({ ok: true, verdict: 'WEAK' });
    // The `<0-2>` placeholders are not five scores of zero.
    expect(r.ok && r.rubric).toBeNull();
  });

  it('a chair that only echoed the template has not voted at all', () => {
    const r = readPressureVerdict(ECHO);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe(PRESSURE_REFUSAL_MISSING);
    // All three separators the template uses, and nothing but whitespace or punctuation between the words.
    for (const echo of ['VERDICT: STRONG | WEAK | PIVOT REQUIRED', 'VERDICT: STRONG/WEAK/PIVOT', 'VERDICT: STRONG or WEAK or PIVOT REQUIRED']) {
      expect(readPressureVerdict(echo), echo).toMatchObject({ ok: false, reason: PRESSURE_REFUSAL_MISSING });
    }
  });

  it('takes the last of two real verdict lines, so a chair that thinks again is heard', () => {
    expect(readPressureVerdict('VERDICT: STRONG\n\nOn reflection:\n\nVERDICT: WEAK')).toMatchObject({ ok: true, verdict: 'WEAK' });
    expect(readPressureVerdict('VERDICT: WEAK\n\nVERDICT: STRONG')).toMatchObject({ ok: true, verdict: 'STRONG' });
  });

  it('a chair that dismisses the other outcomes has still decided (re-review T2-1)', () => {
    // Naming one outcome and arguing against another is argument, not enumeration: the line votes for the
    // first word on it, however the chair punctuates the rest. Counting verdict words threw all of these away.
    const votes: Array<[string, string]> = [
      ['VERDICT: WEAK (not STRONG)', 'WEAK'],
      ['VERDICT: STRONG (no pivot)', 'STRONG'],
      ['VERDICT: WEAK - not STRONG enough', 'WEAK'],
      ['VERDICT: WEAK — the wedge is not strong enough', 'WEAK'],
      ['VERDICT: STRONG, and no pivot is required', 'STRONG'],
      ['VERDICT: PIVOT REQUIRED (not STRONG or WEAK)', 'PIVOT REQUIRED'],
    ];
    for (const [text, verdict] of votes) {
      expect(readPressureVerdict(text), text).toMatchObject({ ok: true, verdict });
    }
  });

  it('reads an em dash after the keyword, so punctuation does not burn the re-ask', () => {
    expect(readPressureVerdict('VERDICT — STRONG')).toMatchObject({ ok: true, verdict: 'STRONG' });
    const r = readPressureVerdict('VERDICT — PIVOT\nWEDGE — one nursery chain\nRUBRIC — core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1');
    expect(r).toMatchObject({ ok: true, verdict: 'PIVOT REQUIRED' });
    expect(r.ok && r.rubric).toEqual({ core_assumption: 2, fatal_flaws: 1, pain: 2, founder_fit: 1, why_now: 1 });
    expect(r.ok && pressureFindings(r)[0]).toContain('one nursery chain');
  });
});

describe('a pivot leads with the wedge (spec §3)', () => {
  it('puts the wedge first, and says so when there is none', () => {
    const r = readPressureVerdict(`VERDICT: PIVOT REQUIRED\n${FLAWS('the buyer is not the user')}\nWEDGE: one nursery chain, the 40 sites that already order together`);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    const f = pressureFindings(r);
    expect(f[0]).toBe('Pivot required. The wedge to attack instead: one nursery chain, the 40 sites that already order together');
    expect(f[1]).toBe('the buyer is not the user');
    const bare = readPressureVerdict(`VERDICT: PIVOT REQUIRED\n${FLAWS('the buyer is not the user')}`);
    expect(bare.ok && pressureFindings(bare)[0]).toBe(PRESSURE_NO_WEDGE);
  });

  it('a strong or weak verdict carries only its flaws', () => {
    const r = readPressureVerdict(`VERDICT: WEAK\n${FLAWS('nobody is hacking a solution today')}\nWEDGE: ignored on a weak verdict`);
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

  it('a dimension scores only on exactly one digit (review T12 finding 2)', () => {
    // The prompt's own placeholder is not five zeros.
    expect(parseRubric('RUBRIC: core assumption <0-2>, fatal flaws <0-2>, pain <0-2>, founder fit <0-2>, why now <0-2>')).toBeNull();
    // One placeholder among four real scores is still not a rubric.
    expect(parseRubric('RUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now <0-2>')).toBeNull();
    // A range is not a score, and neither is prose.
    expect(parseRubric('RUBRIC: core assumption 1-2, fatal flaws 1, pain 2, founder fit 1, why now 1')).toBeNull();
    expect(parseRubric('RUBRIC: core assumption high, fatal flaws 1, pain 2, founder fit 1, why now 1')).toBeNull();
    // A dimension written twice keeps the first score, the way a reader would.
    expect(parseRubric('RUBRIC: core assumption 2, core assumption 0, fatal flaws 1, pain 2, founder fit 1, why now 1'))
      .toEqual({ core_assumption: 2, fatal_flaws: 1, pain: 2, founder_fit: 1, why_now: 1 });
  });

  it('reads the labels a chair varies', () => {
    expect(parseRubric('- **RUBRIC**: core assumption: 1; flaws: 2; pain level: 0; founder-market fit: 2; why now: 1')).toEqual({ core_assumption: 1, fatal_flaws: 2, pain: 0, founder_fit: 2, why_now: 1 });
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
