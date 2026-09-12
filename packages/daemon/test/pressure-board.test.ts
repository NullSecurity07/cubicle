import { describe, it, expect } from 'vitest';
import { advisorPrompt, chairPrompt, chairReaskPrompt, mergeBoardVerdict, boardSubject } from '../src/heartbeat.js';
import { PRESSURE_UNANSWERED, BANNED_HEDGE, PRESSURE_HANDBOOK_PATH, PRESSURE_NO_FLAWS, renderBoardSection } from '@cubicle/core';

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

  it('the unanswered-twice finding says what happened', () => {
    expect(PRESSURE_UNANSWERED).toMatch(/twice running/);
    expect(PRESSURE_UNANSWERED).toMatch(/returned unjudged/);
  });
});
