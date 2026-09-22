import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Run } from '../../shared/evals.ts';
import { FRAMEWORK_ID } from '../../shared/frameworks.ts';

// Every experiment ever run on a framework, kept beside it: `<workspace>/frameworks/<id>/runs/<when>.json`. They are
// files the founder may open, and they are never edited except to write the one word that says the founder promoted
// a run by hand — so the history of what a team scored is as readable in a year as it is this afternoon.

export type RunStore = ReturnType<typeof createRunStore>;

const safe = (id: string) => { if (!FRAMEWORK_ID.test(id)) throw new Error(`bad id: ${id}`); return id; };
// A file name that sorts the way time does and is legal on every disk: the moment, with the colons taken out.
export const stampOf = (at: number) => new Date(at).toISOString().replace(/[:.]/g, '-');

export function createRunStore(folder: string) {
  const runsIn = (id: string) => join(folder, safe(id), 'runs');

  // Newest first, because the list is read from the top and the founder cares about this week.
  async function list(id: string): Promise<Run[]> {
    const found = await readdir(runsIn(id)).catch(() => [] as string[]);
    const held: Run[] = [];
    for (const file of found) {
      if (!file.endsWith('.json')) continue;
      // A run somebody broke by hand loses that one run, never the history: the panel still opens.
      const run = await readFile(join(runsIn(id), file), 'utf8').then((text) => JSON.parse(text) as Run).catch(() => null);
      if (run && typeof run.at === 'number' && Array.isArray(run.cases)) held.push(run);
    }
    return held.sort((one, other) => other.at - one.at);
  }

  return {
    list,
    // The run that is on the framework now: the newest one that was not refused. What a new run has to beat, case by
    // case, and the only thing in the history a promotion is ever measured against.
    lastPromoted: async (id: string): Promise<Run | null> => (await list(id)).find((run) => !run.rejected) ?? null,
    find: async (id: string, at: number): Promise<Run | null> => (await list(id)).find((run) => run.at === at) ?? null,
    async write(id: string, run: Run): Promise<Run> {
      const file = join(runsIn(id), `${stampOf(run.at)}.json`);
      await mkdir(runsIn(id), { recursive: true });
      await writeFile(`${file}.tmp`, `${JSON.stringify(run, null, 2)}\n`);
      await rename(`${file}.tmp`, file);
      return run;
    },
  };
}
