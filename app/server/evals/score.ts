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

export type Judged = { scores: Record<string, number>; critique: string };
// One question put to a judge: the case it is about, and the words to send. The case rides along so a stand-in judge
// can answer from the case alone, without a model and without reading a prompt it did not write.
// The answer, the brief it was written to and the passages of the notes behind it ride along too: a judge made of
// `autoevals` scorers writes its own prompts out of them and never reads `messages` at all.
export type Ask = { kase: Case; messages: ModelMessage[]; output?: string; brief?: string; chunks?: string[] };
export type Judge = (ask: Ask) => Promise<string>;

const clamp = (value: unknown, fallback?: number): number | undefined => {
  const held = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(held)) return fallback;
  return Math.round(Math.min(1, Math.max(0, held)) * 100) / 100;
};

// What the judge is told to do. It is scoring against the founder's notes and nothing else: a judge that scores
// against what it remembers about startups would quietly replace the founder's method with the internet's.
export function judgeMessages(asked: { kase: Case; output: string; brief: string; chunks: string[]; now?: number }): ModelMessage[] {
  const now = asked.now ?? Date.now();
  const system = [
    'You are the judge of one answer, and nothing else. You do not improve the answer, you do not answer the question yourself, and you do not argue with the founder\'s method.',
    'Score the answer only against the founder\'s notes quoted below, the criteria given, and the brief the person was working to. '
      + 'What you remember about this subject from anywhere else is not the standard here: a good answer is one that works through these notes, in their words, and skips none of their steps.',
    `${JSON_RULE}\n{ "faithful": 1, "rubric": 0.8, "expected": 1, "critique": "one sentence" }`,
    'faithful: 1 when the answer works through the notes\' own steps and vocabulary and leaves none of them out, 0.5 when it uses some of them, '
      + '0 when it answers from somewhere else entirely. Always give this one.',
    'rubric: 0 to 1, how fully the answer meets the criteria quoted under "The criteria". Leave the field out when no criteria are given.',
    'expected: 0 to 1, how close the answer is to the answer the notes themselves state. The words may differ; the verdict and the substance may not. '
      + 'Leave the field out when no expected answer is given.',
    'critique: one sentence, in plain words the founder can act on, naming the one thing that would most raise the lowest of those scores. Never more than one sentence.',
    todayBlock(now),
  ].join('\n\n');
  const user = [
    `The brief the person was working to:\n${asked.brief.trim() || '(none)'}`,
    asked.chunks.length ? `From the founder's notes:\n${asked.chunks.join('\n\n')}` : '',
    `What was asked:\n${asked.kase.input}`,
    asked.kase.expected ? `The answer the notes state:\n${asked.kase.expected}` : '',
    asked.kase.rubric ? `The criteria, in the notes' own words:\n${asked.kase.rubric}` : '',
    `The answer given:\n${asked.output.trim() || '(nothing was said)'}`,
  ].filter(Boolean).join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// A judge that needs no model: fixed scores worked out from the case's own id, so the browser journey and the unit
// tests run offline, in seconds, and twice in a row say the same thing. Never used when a real key is configured.
export const fakeJudge: Judge = async ({ kase }) => {
  const seed = parseInt(createHash('sha1').update(kase.id || 'case').digest('hex').slice(0, 6), 16);
  return JSON.stringify({
    faithful: seed % 2 ? 1 : 0.5,
    ...(kase.rubric ? { rubric: Math.round((0.6 + ((seed >> 3) % 5) * 0.1) * 100) / 100 } : {}),
    ...(kase.expected ? { expected: Math.round((0.5 + ((seed >> 7) % 6) * 0.1) * 100) / 100 } : {}),
    critique: `Nothing was really judged: this is the stand-in judge answering for ${kase.id}.`,
  });
};

// One case, scored. `format` is local and costs nothing: an empty answer or one that ran away with itself fails it
// whatever a judge thinks. Everything else comes from the one judge call, and a judge that will not answer in the
// shape asked for leaves the case with the scores that did not need it rather than failing the whole run.
export async function scoreCase(
  asked: { kase: Case; output: string; brief: string; chunks: string[]; now?: number },
  judge: Judge,
): Promise<Judged> {
  const output = asked.output ?? '';
  const scores: Record<string, number> = { format: formatScore(output, asked.brief) };
  let critique = '';
  try {
    const held = firstJson(await judge({
      kase: asked.kase, messages: judgeMessages({ ...asked, output }),
      output, brief: asked.brief, chunks: asked.chunks,
    })) as Record<string, unknown>;
    const faithful = clamp(held.faithful, 0);
    if (faithful !== undefined) scores.faithful = faithful;
    if (asked.kase.rubric) { const rubric = clamp(held.rubric); if (rubric !== undefined) scores.rubric = rubric; }
    if (asked.kase.expected) { const expected = clamp(held.expected); if (expected !== undefined) scores.expected = expected; }
    critique = typeof held.critique === 'string' ? held.critique.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  } catch (error) {
    critique = `The judge did not answer in the shape asked for: ${(error as Error).message}`;
  }
  return { scores, critique };
}

// The mean of what was scored. Nothing scored is nought, never a hole in the arithmetic.
export const meanOf = (numbers: number[]) => (numbers.length ? Math.round((numbers.reduce((sum, one) => sum + one, 0) / numbers.length) * 1000) / 1000 : 0);
// One case's score is the mean of the scorers that applied to it: a case with no expected answer is not punished for
// having none.
export const caseScore = (judged: Judged) => meanOf(Object.values(judged.scores));
