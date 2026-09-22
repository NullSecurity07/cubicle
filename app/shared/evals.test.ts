import { describe, expect, it } from 'vitest';
import { builtFrom, casesFor, scoreLine, staleWhy } from './evals.ts';
import type { Case, Framework } from './frameworks.ts';
import type { Note } from './library.ts';

const note = (over: Partial<Note> = {}): Note => ({ id: 'evaluation-notes', title: 'Evaluating a Startup Idea', tags: [], source: 'file', addedAt: 1, bytes: 100, hash: 'abc123', ...over });
const framework = (over: Partial<Framework> = {}) => ({
  notes: [{ id: 'evaluation-notes', hash: 'abc123' }],
  scorecard: { mean: 0.86, byPerson: { verdict: 0.9 }, cases: 13, at: 1, models: ['groq'] },
  ...over,
}) as Pick<Framework, 'notes' | 'scorecard'>;

describe('a scorecard said in a few words', () => {
  it('reads as a number and how much it is a number about', () => {
    expect(scoreLine({ mean: 0.857, byPerson: {}, cases: 13, at: 1, models: [] })).toBe('0.86 · 13 tests');
    expect(scoreLine({ mean: 1, byPerson: {}, cases: 1, at: 1, models: [] })).toBe('1.00 · 1 test');
  });

  it('says what a person was written from, and what they scored on their own cases', () => {
    expect(builtFrom({ noteTitle: 'Evaluating a Startup Idea', frameworkName: 'Startup evaluation', score: 0.9, cases: 3 }))
      .toBe('Built from “Evaluating a Startup Idea” · 0.90 on 3 tests');
    // A team saved from the canvas was built from no note at all, and says so by its own name instead.
    expect(builtFrom({ frameworkName: 'Startup evaluation', score: 1, cases: 1 })).toBe('Built from Startup evaluation · 1.00 on 1 test');
  });

  it('counts a person\'s own cases, not the whole framework\'s', () => {
    const dataset: Case[] = [
      { id: 'a', keys: ['verdict'], input: '', addedBy: 'founder' },
      { id: 'b', keys: ['verdict', 'pain'], input: '', addedBy: 'founder' },
      { id: 'c', keys: ['pain'], input: '', addedBy: 'founder' },
    ];
    expect(casesFor(dataset, 'verdict')).toBe(2);
    expect(casesFor(dataset, 'nobody')).toBe(0);
  });
});

describe('when a score has stopped being true', () => {
  it('says nothing while the notes and the models are as they were', () => {
    expect(staleWhy(framework(), [note()], ['groq', 'gemini'])).toBe('');
  });

  it('says nothing at all about a framework nobody has scored yet', () => {
    expect(staleWhy(framework({ scorecard: undefined }), [note({ hash: 'moved' })], [])).toBe('');
  });

  it('says so when the founder has edited a note the team was written from', () => {
    expect(staleWhy(framework(), [note({ hash: 'edited-since' })], ['groq'])).toContain('has changed since it was scored');
  });

  it('says so when the model that did the scoring is no longer set up', () => {
    const why = staleWhy(framework(), [note()], ['cerebras']);
    expect(why).toContain('groq');
    expect(why).toContain('no longer set up here');
  });

  it('leaves a note that is missing altogether to whoever already asks for it back', () => {
    expect(staleWhy(framework(), [], ['groq'])).toBe('');
  });

  it('says both when both are true', () => {
    const why = staleWhy(framework(), [note({ hash: 'edited-since' })], []);
    expect(why).toContain('changed');
    expect(why).toContain('groq');
  });
});
