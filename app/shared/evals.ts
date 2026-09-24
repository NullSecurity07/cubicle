import type { Case, Framework, Scorecard } from './frameworks.ts';
import type { Note } from './library.ts';

// Evals as both sides see them. A framework is only a building block the founder can trust if somebody keeps score,
// and this is the record of that: every time the team is run against the founder's own cases, what each answer was
// worth, and whether the run was good enough to become the framework's new word on itself.

// One case, answered and scored. The same shape the forge writes, so a run written by a build and a run written by
// "Rerun evals" are the same file and read by the same code.
// `judged: false` is a case no judge could read (every provider refused, or answered in the wrong shape); `failed` is a
// case whose answer never came, with the sentence that said why. Neither scores anything: they are left out of every
// mean, and a run holding one is never promoted on its own. Both are absent on a case that was simply scored.
export type RunCase = {
  id: string; key: string; briefHash: string; output: string; scores: Record<string, number>; critique: string;
  judged?: false; failed?: string;
};

// Whether a case counts towards a score. The one rule every mean, every regression and every promotion goes through.
export const counted = (one: { judged?: false; failed?: string }) => one.judged !== false && !one.failed;
// A case that was not scored, as the panel lists it: which one, and why in one word.
export type Unscored = { id: string; key: string; why: 'not judged' | 'failed' };

// One experiment, kept beside the framework it was an experiment on. `previous` is the mean this run was measured
// against, so a rejection can be read months later without the run it lost to still being there; `rejected` and
// `forced` are absent rather than false, because a run that was simply promoted should say nothing extra.
export type Run = {
  at: number; version: number; models: string[]; cases: RunCase[]; mean: number;
  mode?: string; calls?: number; previous?: number; rejected?: true; forced?: true;
};

// One case that went backwards, and by how much. This is what the panel shows instead of a number nobody can act on.
export type Regression = { id: string; key: string; was: number; now: number };

// A run as the panel lists it: everything except the answers themselves, which are long and are not what a list is
// for. `regressed` is filled in for a rejected run, so the founder reads why without opening anything.
export type RunLine = {
  at: number; mean: number; version: number; models: string[]; calls: number;
  rejected?: true; forced?: true; previous?: number; regressed?: Regression[]; unscored?: Unscored[];
};

// What one framework's evals look like right now: what has been run, and what is running.
export type EvalsState = 'testing' | 'done' | 'failed';
export type EvalsJob = { id: string; state: EvalsState; lines: string[]; calls: number; error?: string };
export type EvalsView = { runs: RunLine[]; job?: EvalsJob };

// A progress line as it goes out on the window's one live feed, the same way the forge's does.
export type EvalsLine = { kind: 'evals'; id: string; line: string; state: EvalsState };
export const EVALS_CHANNEL = 'evals';

// How far a case may fall before the run that let it fall is refused. Not zero, because a judge is a model and two
// readings of the same answer differ a little; small enough that a person who really got worse cannot slip through.
export const SLACK = 0.1;

// How a scorecard reads on a framework: "0.86 · 13 tests". Short, because it sits beside the name.
export const scoreLine = (scorecard: Scorecard) =>
  `${scorecard.mean.toFixed(2)} · ${scorecard.cases === 1 ? '1 test' : `${scorecard.cases} tests`}`;

// How one person's share of it reads on their own side panel: which of the founder's notes they were written from,
// what they scored, and on how many of the founder's own cases.
export function builtFrom(asked: { noteTitle?: string; frameworkName: string; score: number; cases: number }): string {
  const from = asked.noteTitle ? `Built from “${asked.noteTitle}”` : `Built from ${asked.frameworkName}`;
  return `${from} · ${asked.score.toFixed(2)} on ${asked.cases === 1 ? '1 test' : `${asked.cases} tests`}`;
}

// How many of the founder's cases are this person's. The side panel says "on 3 tests" meaning their three, not the
// framework's thirteen.
export const casesFor = (dataset: Case[], key: string) => dataset.filter((kase) => kase.keys.includes(key)).length;

// Why a scorecard has gone amber, in one sentence, or nothing at all when it is still true. Two things make a score
// out of date and neither of them is time: the founder edited a note the team was written from, so the briefs may
// no longer match what they learned; or the model that did the scoring is not set up here any more, so nobody can
// say the numbers would come out the same. Notes that are missing from the library altogether are somebody else's
// message — the panel already asks for those back — so they are not counted here.
export function staleWhy(framework: Pick<Framework, 'notes' | 'scorecard'>, notes: Note[], models: string[]): string {
  if (!framework.scorecard) return '';
  const moved = framework.notes.filter((note) => {
    const held = notes.find((one) => one.id === note.id);
    return held && note.hash && held.hash !== note.hash;
  });
  const gone = framework.scorecard.models.filter((name) => !models.includes(name));
  const said = [
    moved.length ? `${moved.length === 1 ? 'The note' : 'The notes'} this team was written from ${moved.length === 1 ? 'has' : 'have'} changed since it was scored.` : '',
    gone.length ? `${gone.join(', ')} scored it and ${gone.length === 1 ? 'is' : 'are'} no longer set up here.` : '',
  ].filter(Boolean);
  return said.join(' ');
}
