import { describe, expect, it } from 'vitest';
import type { Run, RunCase } from '../../shared/evals.ts';
import { byPersonOf, decide, lineOf, meanOfCases, regressionsOf, scorecardOf, settle } from './promote.ts';

// A case that scored what it says it scored. `format` alone, so the arithmetic in the test is the arithmetic a
// reader can do in their head.
const kase = (id: string, key: string, score: number): RunCase => ({ id, key, briefHash: 'h', output: 'said', scores: { format: score }, critique: '' });
const run = (cases: RunCase[], over: Partial<Run> = {}): Run => ({ at: 1000, version: 1, models: ['groq'], cases, mean: meanOfCases(cases), ...over });

describe('what one run was worth', () => {
  it('is each person\'s mean, and then the mean of the people', () => {
    // One person answered two cases badly and well; the other answered one, perfectly. Counting cases would say
    // 0.67; counting people says 0.75, and it is people a framework is made of.
    const cases = [kase('a', 'one', 0.5), kase('b', 'one', 0.5), kase('c', 'other', 1)];
    expect(byPersonOf(cases)).toEqual({ one: 0.5, other: 1 });
    expect(meanOfCases(cases)).toBe(0.75);
  });

  it('is nought when nothing was run, rather than a hole in the arithmetic', () => {
    expect(meanOfCases([])).toBe(0);
    expect(byPersonOf([])).toEqual({});
  });

  it('becomes the scorecard the framework wears', () => {
    const held = run([kase('a', 'one', 1), kase('b', 'other', 0.5)], { at: 77, models: ['groq', 'gemini'] });
    expect(scorecardOf(held)).toEqual({ mean: 0.75, byPerson: { one: 1, other: 0.5 }, cases: 2, at: 77, models: ['groq', 'gemini'] });
  });
});

describe('which cases went backwards', () => {
  const was = run([kase('a', 'one', 1), kase('b', 'one', 0.8)]);

  it('names a case that fell further than a judge\'s own wobble', () => {
    const now = run([kase('a', 'one', 0.85), kase('b', 'one', 0.8)]);
    expect(regressionsOf(now, was)).toEqual([{ id: 'a', key: 'one', was: 1, now: 0.85 }]);
  });

  it('lets a case fall exactly the slack and no more', () => {
    expect(regressionsOf(run([kase('a', 'one', 0.9), kase('b', 'one', 0.8)]), was)).toEqual([]);
    expect(regressionsOf(run([kase('a', 'one', 0.89), kase('b', 'one', 0.8)]), was)).toHaveLength(1);
  });

  it('holds nothing against a case that was never run before', () => {
    const now = run([kase('a', 'one', 1), kase('b', 'one', 0.8), kase('c', 'one', 0)]);
    expect(regressionsOf(now, was)).toEqual([]);
  });

  it('has nothing to compare against on the first run of all', () => {
    expect(regressionsOf(was, null)).toEqual([]);
  });
});

describe('whether a run may be promoted', () => {
  const was = run([kase('a', 'one', 1), kase('b', 'one', 0.6)]);

  it('promotes the first run there has ever been', () => {
    expect(decide(was, null, undefined)).toEqual({ promote: true, regressed: [] });
  });

  it('promotes a run that is better everywhere', () => {
    const now = run([kase('a', 'one', 1), kase('b', 'one', 0.9)]);
    expect(decide(now, was, was.mean)).toEqual({ promote: true, regressed: [] });
  });

  it('promotes a tie: the same mean and nothing fallen is not a step back', () => {
    const now = run([kase('a', 'one', 1), kase('b', 'one', 0.6)]);
    expect(decide(now, was, was.mean)).toEqual({ promote: true, regressed: [] });
  });

  it('refuses a run whose mean fell, even by a little', () => {
    const now = run([kase('a', 'one', 0.95), kase('b', 'one', 0.6)]);
    expect(decide(now, was, was.mean).promote).toBe(false);
  });

  it('refuses a run that rose on average while one person\'s case fell off a cliff', () => {
    // The whole reason the rule has two halves: on the mean alone this run is better, and one of the two people has
    // quietly stopped doing their job.
    const before = run([kase('a', 'one', 0.6), kase('b', 'other', 0.6)]);
    const now = run([kase('a', 'one', 0.4), kase('b', 'other', 1)]);
    expect(now.mean).toBeGreaterThan(before.mean);
    const held = decide(now, before, before.mean);
    expect(held.promote).toBe(false);
    expect(held.regressed).toEqual([{ id: 'a', key: 'one', was: 0.6, now: 0.4 }]);
  });

  it('measures the mean against the promoted scorecard, not against whatever ran last', () => {
    // The run before was itself rejected and scored badly. A new run still has to beat what is on the framework.
    const rejected = run([kase('a', 'one', 0.1), kase('b', 'one', 0.1)], { rejected: true });
    const now = run([kase('a', 'one', 0.5), kase('b', 'one', 0.5)]);
    expect(decide(now, rejected, 0.8).promote).toBe(false);
  });
});

describe('a run written down', () => {
  it('keeps a rejected run whole, with what it lost to and what fell', () => {
    const was = run([kase('a', 'one', 1)]);
    const now = run([kase('a', 'one', 0.5)], { at: 2000 });
    const written = settle(now, was, 1);
    expect(written.run.rejected).toBe(true);
    expect(written.run.previous).toBe(1);
    expect(written.promote).toBe(false);
    expect(written.regressed).toHaveLength(1);
    // And nothing pretends it was promoted: `forced` is only ever written by the founder pressing the button.
    expect(written.run.forced).toBeUndefined();
  });

  it('says nothing extra about a run that was simply promoted', () => {
    const written = settle(run([kase('a', 'one', 1)]), null, undefined);
    expect(written.run.rejected).toBeUndefined();
    expect(written.run.previous).toBeUndefined();
    expect(written.promote).toBe(true);
  });
});

describe('a run in a list', () => {
  it('carries the numbers and not the answers', () => {
    const line = lineOf(run([kase('a', 'one', 0.5)], { calls: 4, rejected: true, previous: 1 }), [{ id: 'a', key: 'one', was: 1, now: 0.5 }]);
    expect(line).toEqual({ at: 1000, mean: 0.5, version: 1, models: ['groq'], calls: 4, rejected: true, previous: 1, regressed: [{ id: 'a', key: 'one', was: 1, now: 0.5 }] });
    expect(JSON.stringify(line)).not.toContain('said');
  });
});
