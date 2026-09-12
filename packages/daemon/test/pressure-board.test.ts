import { describe, it, expect } from 'vitest';
import { advisorPrompt, chairPrompt, chairReaskPrompt, mergeBoardVerdict, boardSubject, ideaVerdictBody, cardBoardFindings, cardBoardChair } from '../src/heartbeat.js';
import { PRESSURE_UNANSWERED, BANNED_HEDGE, PRESSURE_HANDBOOK_PATH, PRESSURE_NO_FLAWS, renderBoardSection, chairAnswerText, PRESSURE_CHAIR_CHARS } from '@cubicle/core';

const PLAN_TEXT = '# Plan\n\n## Objectives\n\n### dev\n- ship the first cut\n';
const IDEA = { kind: 'idea' as const, text: '# Meal kits\n\n## Score\n\n46 of 60', title: 'Meal kits for nurseries', slug: 'meal-kits' };

describe('the plan pre-mortem is untouched (spec §2)', () => {
  it('says the same words it always said', () => {
    const p = boardSubject(PLAN_TEXT);
    expect(advisorPrompt(p)).toContain('Imagine the cycle has already failed');
    expect(advisorPrompt(p)).toContain('at most three bullets');
    expect(advisorPrompt(p)).toContain(PLAN_TEXT);
    expect(chairPrompt(p, 't')).toContain('this plan');
    expect(chairPrompt(p, 't')).toContain('"VERDICT: pass" or "VERDICT: return"');
    expect(chairPrompt(p, 't')).toContain('would waste the cycle');
    expect(chairPrompt(p, 't')).not.toContain('STRONG');
  });

  it('and reads the same way: a missing line, or no model, passes', () => {
    expect(mergeBoardVerdict('VERDICT: return\n- no metric')).toMatchObject({ verdict: 'return', findings: ['no metric'], pressure: null, rubric: null, refused: null });
    expect(mergeBoardVerdict('')).toMatchObject({ verdict: 'pass', findings: [] });
    // The banned phrase is an idea rule; a plan chair that hedges still passes, exactly as before.
    expect(mergeBoardVerdict('It has potential, but watch the burn')).toMatchObject({ verdict: 'pass', refused: null });
  });
});

describe('the idea session takes the five-part shape and order (spec §2)', () => {
  it('the advisors are asked the owner\'s five questions, in the owner\'s order', () => {
    const p = advisorPrompt(IDEA);
    let at = -1;
    for (const part of ['Core Assumption', 'Three Fatal Flaws', 'Problem Validation', 'Founder-Market Fit', 'Brutal Verdict']) {
      const i = p.indexOf(part); expect(i, part).toBeGreaterThan(at); at = i;
    }
    expect(p).toContain('Paul Graham');
    expect(p).toContain('specific to this idea');
    expect(p).toContain(PRESSURE_HANDBOOK_PATH);
    expect(p).toContain('STRONG, WEAK, PIVOT REQUIRED');
    expect(p).toContain(IDEA.text);
  });

  it('the chair is asked for one word, a rubric, the five parts and a wedge', () => {
    const c = chairPrompt(IDEA, 'advisors said things');
    expect(c).toContain('this idea');
    expect(c).not.toContain('this plan');
    expect(c).toContain('VERDICT: STRONG or WEAK or PIVOT REQUIRED');
    expect(c).toContain('RUBRIC: core assumption <0-2>, fatal flaws <0-2>, pain <0-2>, founder fit <0-2>, why now <0-2>');
    expect(c).toContain('## Three Fatal Flaws');
    expect(c).toContain('WEDGE:');
    expect(c).toContain(BANNED_HEDGE);
    expect(c).toContain('the owner does');
  });

  it('STRONG passes; WEAK returns with the flaws; PIVOT returns with the wedge first', () => {
    // The flaws are read from the heading the chair is told to write, so each of these carries it (Decision 9).
    const flaws = (...bullets: string[]): string => `## Three Fatal Flaws\n${bullets.map((b) => `- ${b}`).join('\n')}`;
    expect(mergeBoardVerdict(`VERDICT: STRONG\n${flaws('watch the margin')}`, 'idea')).toMatchObject({ verdict: 'pass', pressure: 'STRONG', findings: ['watch the margin'] });
    expect(mergeBoardVerdict(`VERDICT: WEAK\n${flaws('nobody hacks a solution today')}`, 'idea')).toMatchObject({ verdict: 'return', pressure: 'WEAK', findings: ['nobody hacks a solution today'] });
    const pivot = mergeBoardVerdict(`VERDICT: PIVOT REQUIRED\n${flaws('the payer is not the user')}\nWEDGE: the 40-site chain`, 'idea');
    expect(pivot.verdict).toBe('return');
    expect(pivot.findings[0]).toContain('the 40-site chain');
  });

  it('a verdict with no flaws section says so, rather than reading as a clean bill of health', () => {
    // Decision 9 reads flaws only from `## Three Fatal Flaws`, so a chair that wrote none leaves the list empty
    // and `pressureFindings` fills it with `PRESSURE_NO_FLAWS`. The card must then say *that* — "the chair named
    // no flaws" — and never the placeholder a board with nothing to say gets, which would be a different claim.
    const m = mergeBoardVerdict('VERDICT: STRONG\nRUBRIC: core assumption 2, fatal flaws 2, pain 2, founder fit 2, why now 2', 'idea');
    expect(m.verdict).toBe('pass');
    expect(m.findings).toEqual([PRESSURE_NO_FLAWS]);
    const section = renderBoardSection({ verdict: m.verdict, advisors: 3, date: '2026-09-12', decision: '', findings: m.findings, pressure: m.pressure, rubric: m.rubric });
    expect(section).toContain(`- ${PRESSURE_NO_FLAWS}`);
    expect(section).not.toContain('Nothing they thought would sink it.');
  });

  it('a hedge, a fourth outcome and a silent verdict are refusals, not verdicts', () => {
    for (const bad of ['VERDICT: STRONG\nIt has potential but the margins worry me', 'VERDICT: MAYBE', '- just some bullets']) {
      const m = mergeBoardVerdict(bad, 'idea');
      expect(m.refused, bad).toBeTruthy();
      expect(m.verdict, bad).toBe('return');
      expect(m.pressure, bad).toBeNull();
    }
  });

  it('the re-ask names what was wrong, so the chair is not asked to guess', () => {
    expect(chairReaskPrompt(IDEA, 't', 'the verdict was "MAYBE"')).toContain('MAYBE');
    expect(chairReaskPrompt(IDEA, 't', 'x')).toContain('STRONG, WEAK, PIVOT REQUIRED');
  });

  it('the re-ask carries the whole format, because the chair is asked in a chat of its own', () => {
    // `askAs` sends system + this one message and nothing else, so everything the answer is parsed against has
    // to be in here: the rubric's five labels, the heading the flaws are read from, and the wedge line.
    const r = chairReaskPrompt(IDEA, 'advisors said things', 'the verdict was "MAYBE"');
    expect(r).toContain(IDEA.title);
    expect(r).toContain('RUBRIC: core assumption <0-2>, fatal flaws <0-2>, pain <0-2>, founder fit <0-2>, why now <0-2>');
    expect(r).toContain('## Three Fatal Flaws');
    expect(r).toContain('WEDGE:');
    expect(r).toContain(BANNED_HEDGE);
    expect(r).toContain('advisors said things');
    // And an answer that does what the re-ask asked for keeps its rubric and its flaws, which is the whole
    // point of spending the extra call: a re-ask that lost either would buy a verdict with nothing behind it.
    const compliant = 'VERDICT: WEAK\nRUBRIC: core assumption 1, fatal flaws 0, pain 1, founder fit 2, why now 1\n\n## Core Assumption\nThey pay weekly.\n\n## Three Fatal Flaws\n- the payer is not the user\n- no van before 7am\n\n## Brutal Verdict\nWEAK.';
    const m = mergeBoardVerdict(compliant, 'idea');
    expect(m.refused).toBeNull();
    expect(m.pressure).toBe('WEAK');
    expect(m.rubric).toEqual({ core_assumption: 1, fatal_flaws: 0, pain: 1, founder_fit: 2, why_now: 1 });
    expect(m.findings).toEqual(['the payer is not the user', 'no van before 7am']);
  });

  it('the owner\'s note names the pressure test and its rubric, and is silent about a board that ran neither', () => {
    const facts = {
      slug: 'meal-kits', title: 'Meal kits for nurseries', score: 46, band: 'keep' as const,
      reason: '46/60 → keep.', board: 'pass' as const, findings: ['watch the margin'],
      research: '', estimate: '', decidesAfterHours: 0,
    };
    expect(ideaVerdictBody({ ...facts, pressure: 'STRONG', rubric: { core_assumption: 2, fatal_flaws: 1, pain: 2, founder_fit: 1, why_now: 1 } }))
      .toContain('- Pressure test: STRONG · rubric 7/10 — core assumption 2');
    // A verdict word with no rubric says the word alone rather than an empty "rubric".
    expect(ideaVerdictBody({ ...facts, pressure: 'WEAK', rubric: null })).toContain('- Pressure test: WEAK\n');
    // A card the board judged before SP5b carries neither field, and its note reads exactly as it always did.
    expect(ideaVerdictBody(facts)).not.toContain('Pressure test');
  });

  it('the chair\'s five parts are kept whole, on the card and in the owner\'s note (ruling H3)', () => {
    // The owner's prompt ends "Output: Core Assumption → Three Fatal Flaws → Problem Validation →
    // Founder-Market Fit → Brutal Verdict". Three of those five used to be computed, paid for out of the
    // chair's one call, and dropped: only the verdict word, the rubric and the flaw bullets survived.
    const chair = [
      'VERDICT: STRONG',
      'RUBRIC: core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1',
      '',
      '## Core Assumption',
      'Nurseries will pay 40 a week to stop planning meals.',
      '',
      '## Three Fatal Flaws',
      '- the caterer holds the contract',
      '',
      '## Problem Validation',
      'A painkiller: they already pay a caterer every term.',
      '',
      '## Founder-Market Fit',
      'The owner ran a nursery kitchen for six years.',
    ].join('\n');
    const section = renderBoardSection({
      verdict: 'pass', advisors: 3, date: '2026-09-12', decision: '', findings: ['the caterer holds the contract'],
      pressure: 'STRONG', rubric: null, chair,
    });
    for (const part of ['Core Assumption', 'Problem Validation', 'Founder-Market Fit']) expect(section, part).toContain(part);
    // Demoted, because the card's eight `## ` sections are fixed (spec §7) and this lives inside one of them.
    expect(section).toContain('#### Core Assumption');
    expect(section).not.toMatch(/^## Core Assumption$/m);

    // The findings the verdict note is rebuilt from are still the rendered bullets, not every bullet the chair
    // wrote underneath: the sub-heading is where `cardBoardFindings` stops.
    const card = `## The board\n\n${section}\n\n## Score\n\n- not a finding\n`;
    expect(cardBoardFindings(card)).toEqual(['the caterer holds the contract']);
    expect(cardBoardChair(card)).toContain('A painkiller: they already pay a caterer every term.');
    expect(cardBoardChair(card)).not.toContain('## Score');
    expect(cardBoardChair('## The board\n\n**Passed** — 3 advisors, 2026-09-12.\n\n- nothing\n')).toBe('');

    // And what the card carries is what the owner is asked to rule on.
    const body = ideaVerdictBody({
      slug: 'meal-kits', title: 'Meal kits for nurseries', score: 46, band: 'keep', reason: '46/60 → keep.',
      board: 'pass', findings: ['the caterer holds the contract'], research: '', estimate: '', decidesAfterHours: 0,
      pressure: 'STRONG', rubric: null, chair: cardBoardChair(card),
    });
    expect(body).toContain('#### Founder-Market Fit');
    expect(body).toContain('The owner ran a nursery kitchen for six years.');
    expect(body).toContain('Set `approved: true`');
  });

  it('a runaway chair is cut rather than dropped, and a silent one adds nothing', () => {
    expect(chairAnswerText('')).toBe('');
    expect(chairAnswerText('   \n  ')).toBe('');
    const long = chairAnswerText('## Core Assumption\n' + 'x'.repeat(PRESSURE_CHAIR_CHARS * 2));
    expect(long.length).toBeLessThanOrEqual(PRESSURE_CHAIR_CHARS + 1);
    expect(long.endsWith('…')).toBe(true);
    // A board that raised nothing reads exactly as it did before the chair's text was kept.
    expect(renderBoardSection({ verdict: 'pass', advisors: 3, date: '2026-09-12', decision: '', findings: [], pressure: 'STRONG' }))
      .toBe('**Passed** — 3 advisors, 2026-09-12.\n\n**Pressure test:** STRONG.\n\n- Nothing they thought would sink it.');
  });

  it('two refusals return the idea, in the words the board records', () => {
    // The wording matters because it is what the owner reads on the card and in the verdict note; the daemon
    // path that reaches it — a chair refused twice running — is exercised in `idea-board.test.ts`.
    expect(PRESSURE_UNANSWERED).toMatch(/twice running/);
    expect(PRESSURE_UNANSWERED).toMatch(/returned unjudged/);
    expect(mergeBoardVerdict('VERDICT: MAYBE', 'idea').verdict).toBe('return');
  });
});
