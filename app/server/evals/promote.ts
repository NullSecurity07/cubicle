import type { Regression, Run, RunCase, RunLine } from '../../shared/evals.ts';
import { SLACK } from '../../shared/evals.ts';
import type { Scorecard } from '../../shared/frameworks.ts';
import { caseScore, meanOf } from './score.ts';

// Whether a run may replace what the framework says about itself. Every rule here is arithmetic on numbers that were
// already written down, and none of it reads a file or asks a model, so the one decision the founder has to trust —
// "is this team better than it was?" — can be read, argued with and checked without running anything.

// Rounding a mean to three places leaves the odd number that is a hair under the one it should equal. A comparison
// that fails on the fifteenth decimal place would refuse a run that is really a tie, so everything here is compared
// with the width of that rounding left over.
const HAIR = 1e-9;

// One person's share of a run: the mean of the cases that named them.
export function byPersonOf(cases: RunCase[]): Record<string, number> {
  const by = new Map<string, number[]>();
  for (const one of cases) by.set(one.key, [...(by.get(one.key) ?? []), caseScore(one)]);
  return Object.fromEntries([...by].map(([key, scores]) => [key, meanOf(scores)]));
}

// And the run's own: the mean over the people, not over the cases. A person given six cases would otherwise weigh
// six times as much as the one given one, and a framework is a team, not a pile of questions.
export const meanOfCases = (cases: RunCase[]) => meanOf(Object.values(byPersonOf(cases)));

// The run as the framework will wear it, when it is promoted.
export const scorecardOf = (run: Run): Scorecard => ({
  mean: run.mean, byPerson: byPersonOf(run.cases), cases: run.cases.length, at: run.at, models: run.models,
});

// Which cases are worse than they were, by case id. A case that is new has nothing to be worse than, and a run with
// nothing before it is the first word on the subject rather than a step backwards.
export function regressionsOf(run: Run, previous: Run | null, slack = SLACK): Regression[] {
  if (!previous) return [];
  const was = new Map(previous.cases.map((one) => [one.id, caseScore(one)]));
  return run.cases.flatMap((one) => {
    const before = was.get(one.id);
    if (before === undefined) return [];
    const now = caseScore(one);
    return before - now > slack + HAIR ? [{ id: one.id, key: one.key, was: before, now }] : [];
  });
}

// The rule from the design, said once: a run is promoted only when it is at least as good on the whole as the run
// that is on the framework now, and when no single case fell further than a judge's own wobble. Either half alone
// lets the team rot — a rising mean can hide one person who has stopped doing their job, and a tie with nothing
// fallen is a run that changed nothing and has no reason to be refused.
export function decide(run: Run, previous: Run | null, previousMean: number | undefined): { promote: boolean; regressed: Regression[] } {
  const regressed = regressionsOf(run, previous);
  if (previousMean === undefined) return { promote: !regressed.length, regressed };
  return { promote: run.mean >= previousMean - HAIR && !regressed.length, regressed };
}

// The run as it goes on disk, with the verdict written into it. A rejected run is kept whole — the founder may still
// read what was said and promote it by hand — and it carries the mean it lost to, so a rejection can be understood
// long after the run it lost to has scrolled away.
export function settle(run: Run, previous: Run | null, previousMean: number | undefined): { run: Run; promote: boolean; regressed: Regression[] } {
  const { promote, regressed } = decide(run, previous, previousMean);
  return {
    run: { ...run, ...(promote ? {} : { rejected: true as const }), ...(previousMean === undefined ? {} : { previous: previousMean }) },
    promote, regressed,
  };
}

// A run in the panel's list: the numbers, never the answers. The answers are pages long and are read one run at a
// time, not thirty at once.
export function lineOf(run: Run, regressed: Regression[]): RunLine {
  return {
    at: run.at, mean: run.mean, version: run.version, models: run.models, calls: run.calls ?? 0,
    ...(run.rejected ? { rejected: true as const } : {}), ...(run.forced ? { forced: true as const } : {}),
    ...(run.previous === undefined ? {} : { previous: run.previous }),
    ...(regressed.length ? { regressed } : {}),
  };
}
