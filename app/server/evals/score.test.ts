import { describe, expect, it, vi } from 'vitest';
import type { Case } from '../../shared/frameworks.ts';
import { todayBlock } from '../prompt.ts';
import { caseScore, fakeJudge, judgeMessages, MOST_OUTPUT_CHARS, scoreCase, type Judge } from './score.ts';

// The guard the whole fake path rests on. `autoevals` brings a scoring library and its own copy of the OpenAI client
// with it, and neither has any business being loaded by a test run or a browser journey that will never call a
// model. Anything in this file's import graph that reached for it statically would blow up here, by name.
vi.mock('autoevals', () => { throw new Error('the scoring library was loaded on the path that has no key'); });

const kase: Case = { id: 'airbnb-assumption', keys: ['assumption'], input: 'Name the core assumption.', expected: 'Strangers will sleep in strangers\' homes.', rubric: 'Falsifiable, not a hope.', addedBy: 'forge' };
const bare: Case = { id: 'bare', keys: ['assumption'], input: 'Name the core assumption.', addedBy: 'forge' };
const said = (judged: unknown): Judge => async () => JSON.stringify(judged);
const asked = (over: Partial<Parameters<typeof scoreCase>[0]> = {}) => ({ kase, output: 'Strangers will sleep in strangers\' homes for money.', brief: 'You are step one.', chunks: ['a passage of the notes'], ...over });

describe('scoring one answer', () => {
  it('takes the judge\'s numbers, and adds the one check that needs no model', async () => {
    const judged = await scoreCase(asked(), said({ faithful: 1, rubric: 0.8, expected: 0.9, critique: 'Name the payer as well.' }));
    expect(judged.scores).toEqual({ format: 1, faithful: 1, rubric: 0.8, expected: 0.9 });
    expect(judged.critique).toBe('Name the payer as well.');
    expect(caseScore(judged)).toBe(0.925);
  });

  it('only scores what the case really asks for', async () => {
    const judged = await scoreCase(asked({ kase: bare }), said({ faithful: 0.5, rubric: 1, expected: 1, critique: '' }));
    expect(judged.scores).toEqual({ format: 1, faithful: 0.5 });
  });

  it('fails the format check on an empty answer and on one that ran away with itself', async () => {
    expect((await scoreCase(asked({ output: '   ' }), said({ faithful: 1 }))).scores.format).toBe(0);
    expect((await scoreCase(asked({ output: 'x'.repeat(MOST_OUTPUT_CHARS) }), said({ faithful: 1 }))).scores.format).toBe(0);
  });

  it('holds every score between nought and one', async () => {
    const judged = await scoreCase(asked(), said({ faithful: 7, rubric: -3, expected: '0.5', critique: 42 }));
    expect(judged.scores).toEqual({ format: 1, faithful: 1, rubric: 0, expected: 0.5 });
    expect(judged.critique).toBe('');
  });

  it('keeps the case when the judge will not answer in the shape asked for', async () => {
    const judged = await scoreCase(asked(), async () => 'I would rather talk about the idea itself.');
    expect(judged.scores).toEqual({ format: 1 });
    expect(judged.critique).toContain('did not answer in the shape');
  });
});

describe('the judge with no model behind it', () => {
  it('says the same thing about the same case, every time', async () => {
    const [one, other] = [await fakeJudge({ kase, messages: [] }), await fakeJudge({ kase, messages: [] })];
    expect(one).toBe(other);
    const scores = (await scoreCase(asked(), fakeJudge)).scores;
    expect(scores).toEqual((await scoreCase(asked(), fakeJudge)).scores);
    expect(Object.keys(scores).sort()).toEqual(['expected', 'faithful', 'format', 'rubric']);
    for (const score of Object.values(scores)) expect(score).toBeGreaterThanOrEqual(0);
  });

  it('says different things about different cases, and scores only what the case has', async () => {
    const mine = await scoreCase(asked(), fakeJudge);
    const other = await scoreCase(asked({ kase: { ...kase, id: 'quibi-verdict' } }), fakeJudge);
    expect(mine.scores).not.toEqual(other.scores);
    expect(Object.keys((await scoreCase(asked({ kase: bare }), fakeJudge)).scores).sort()).toEqual(['faithful', 'format']);
  });
});

describe('what the judge is told', () => {
  it('ends with today, and holds it to the founder\'s notes', () => {
    const now = Date.UTC(2026, 8, 22, 9);
    const [system, user] = judgeMessages({ ...asked(), now });
    expect(system.content.endsWith(todayBlock(now))).toBe(true);
    expect(system.content).toContain('is not the standard here');
    expect(user.content).toContain('a passage of the notes');
    expect(user.content).toContain('The criteria, in the notes\' own words');
    expect(user.content).toContain('The answer the notes state');
  });

  it('says nothing about criteria the case does not have', () => {
    const [, user] = judgeMessages({ ...asked({ kase: bare }), now: Date.now() });
    expect(user.content).not.toContain('The criteria');
    expect(user.content).not.toContain('The answer the notes state');
  });
});
