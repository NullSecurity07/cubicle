import { createHash } from 'node:crypto';
import type { Case } from '../../shared/frameworks.ts';
import { firstJson, JSON_RULE } from '../json.ts';
import { todayBlock, type ModelMessage } from '../prompt.ts';
import { formatScore } from './scorers.ts';

// What one answer is worth. A score here is never a number somebody made up about a person: it is what the founder's
// own notes say about that answer, asked of a model that has the passages in front of it, plus the one check that
// needs no model at all. The insides are meant to be replaced — the evals round swaps this for `autoevals`' own
// scorers — so everything outside this file only ever sees `scoreCase` and the shape it gives back.

// An answer longer than this is not an answer any more: the founder asked one person one question, and a person who
// cannot say it inside a doc's worth of words has not done the work. The same cap a tool result is held to. It lives
// beside the check that uses it and is said again here, because it is part of what this file promises.
export { MOST_OUTPUT_CHARS } from './scorers.ts';
// How much of the founder's notes the judge is shown. Three passages, the ones that answer this case.
export const JUDGE_CHUNKS = 3;

// `judged: false` is a case no judge could read: it carries no scores at all, because the one check that needs no
// model (`format`) passes almost any answer, and a case scored on that alone would read as a perfect 1.00.
export type Judged = { scores: Record<string, number>; critique: string; judged?: false };
export type Ask = { kase: Case; messages: ModelMessage[]; output?: string; brief?: string; chunks?: string[] };
export type Judge = (ask: Ask) => Promise<string>;

const clamp = (value: unknown, fallback?: number): number | undefined => {
  const held = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(held)) return fallback;
  return Math.round(Math.min(1, Math.max(0, held)) * 100) / 100;
};

// How a criterion is read, said once for every judge that reads one. The criteria in a founder's dataset are often
// about what a person does rather than what they produce — "asks for the story first", "refuses to write" — and a
// judge that expects a finished piece of work scores exactly the right answer nought.
export const RUBRIC_READING = 'Read the criteria as a list of things the person must do. When a criterion says the person asks for something first, '
  + 'refuses, or waits, an answer that does exactly that meets it: asking for the missing facts instead of writing is the right answer, '
  + 'and parts of the criteria about a draft that was rightly not written yet are not held against it.';

// What the judge is told to do. It is scoring against the founder's notes and nothing else: a judge that scores
// against what it remembers about startups would quietly replace the founder's method with the internet's.
export function judgeMessages(asked: { kase: Case; output: string; brief: string; chunks: string[]; now?: number }): ModelMessage[] {
  const now = asked.now ?? Date.now();
  const system = [
    'You are the judge of one answer, and nothing else. You do not improve the answer, you do not answer the question yourself, and you do not argue with the founder\'s method.',
    'Score the answer only against the criteria given, the founder\'s notes quoted below, and the brief the person was working to. '
      + 'What you remember about this subject from anywhere else is not the standard here.',
    `${JSON_RULE}\n{ "faithful": 1, "rubric": 0.8, "expected": 1, "critique": "one sentence" }`,
    'rubric: 0 to 1, how fully the answer meets the criteria quoted under "The criteria". Leave the field out when no criteria are given. '
      + RUBRIC_READING,
    'expected: 0 to 1, how close the answer is to the answer the notes themselves state. The words may differ; the verdict and the substance may not. '
      + 'Leave the field out when no expected answer is given.',
    'faithful: 1 when the answer follows the notes\' steps and the brief\'s rules, 0.5 when it follows some of them, 0 when it answers from somewhere else. '
      + 'Write null when no passage of the notes is quoted or the passages say nothing about what was asked.',
    'critique: one sentence, in plain words the founder can act on, naming the one thing that would most raise the lowest of those scores. Never more than one sentence.',
    todayBlock(now),
  ].join('\n\n');
  // The criteria come before the answer, so the judge reads the answer knowing what it is looking for.
  const user = [
    `The brief the person was working to:\n${asked.brief.trim() || '(none)'}`,
    asked.kase.rubric ? `The criteria, in the notes' own words:\n${asked.kase.rubric}` : '',
    asked.kase.expected ? `The answer the notes state:\n${asked.kase.expected}` : '',
    asked.chunks.length ? `From the founder's notes:\n${asked.chunks.join('\n\n')}` : '',
    `What was asked:\n${asked.kase.input}`,
    `The answer given:\n${asked.output.trim() || '(nothing was said)'}`,
  ].filter(Boolean).join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// A judge that needs no model: fixed scores worked out from the case's own id, so the browser journey and the unit
// tests run offline, in seconds, and twice in a row say the same thing. Never used when a real key is configured.
export const fakeJudge: Judge = async ({ kase, chunks }) => {
  const seed = parseInt(createHash('sha1').update(kase.id || 'case').digest('hex').slice(0, 6), 16);
  return JSON.stringify({
    faithful: chunks && !chunks.length ? null : seed % 2 ? 1 : 0.5,
    ...(kase.rubric ? { rubric: Math.round((0.6 + ((seed >> 3) % 5) * 0.1) * 100) / 100 } : {}),
    ...(kase.expected ? { expected: Math.round((0.5 + ((seed >> 7) % 6) * 0.1) * 100) / 100 } : {}),
    critique: `Nothing was really judged: this is the stand-in judge answering for ${kase.id}.`,
  });
};

// One case, scored. `format` is local and costs nothing: an empty answer or one that ran away with itself fails it
// whatever a judge thinks. Everything else comes from the judge, and the case is only scored when the judge scored
// what the case asks for: its criteria and its expected answer when it has them, and faithfulness when it has neither.
// A judge that would not answer, or answered without those, leaves the case `judged: false` with no score at all —
// never the lone `format` check, which is a 1 for almost anything and would promote a run nobody read.
//
// Faithfulness is only scored against passages of the notes that are there: none found for this question, or a
// judge that says the passages found do not cover it (`null`), leaves it out rather than scoring the answer nought
// for not following notes that say nothing about what was asked.
export async function scoreCase(
  asked: { kase: Case; output: string; brief: string; chunks: string[]; now?: number },
  judge: Judge,
): Promise<Judged> {
  const output = asked.output ?? '';
  const { kase, chunks } = asked;
  const scores: Record<string, number> = { format: formatScore(output, asked.brief) };
  const needed = [...(kase.rubric ? ['rubric'] : []), ...(kase.expected ? ['expected'] : [])];
  if (!needed.length && !chunks.length) {
    return { scores: {}, critique: 'Nothing to judge it against: the case has no criteria and no expected answer, and no passage of the notes was found.', judged: false };
  }
  let held: Record<string, unknown>;
  try {
    held = firstJson(await judge({ kase, messages: judgeMessages({ ...asked, output }), output, brief: asked.brief, chunks })) as Record<string, unknown>;
  } catch (error) {
    return { scores: {}, critique: `Not judged: ${(error as Error).message}`.slice(0, 300), judged: false };
  }
  const got = (name: string) => (held[name] === null || held[name] === undefined ? undefined : clamp(held[name]));
  if (chunks.length) { const faithful = got('faithful'); if (faithful !== undefined) scores.faithful = faithful; }
  for (const name of needed) { const one = got(name); if (one !== undefined) scores[name] = one; }
  const critique = typeof held.critique === 'string' ? held.critique.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  // What the case must have been scored on to count: its own criteria, or faithfulness when it has nothing else.
  const missing = (needed.length ? needed : ['faithful']).filter((name) => scores[name] === undefined);
  if (missing.length) {
    const why = !needed.length && held.faithful === null ? 'the passages found say nothing about this question' : `no ${missing.join(' or ')} score came back`;
    return { scores: {}, critique: `Not judged: ${why}.${critique ? ` ${critique}` : ''}`.slice(0, 300), judged: false };
  }
  return { scores, critique };
}

// The mean of what was scored. Nothing scored is nought, never a hole in the arithmetic.
export const meanOf = (numbers: number[]) => (numbers.length ? Math.round((numbers.reduce((sum, one) => sum + one, 0) / numbers.length) * 1000) / 1000 : 0);
// One case's score is the mean of the scorers that applied to it: a case with no expected answer is not punished for
// having none.
export const caseScore = (judged: Judged) => meanOf(Object.values(judged.scores));
// How one case reads on a progress line: its score, or why it has none.
export const scoreWord = (judged: Judged & { failed?: string }) => (judged.failed ? 'failed' : judged.judged === false ? 'not judged' : caseScore(judged).toFixed(2));
