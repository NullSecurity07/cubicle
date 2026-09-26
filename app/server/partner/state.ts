import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MorningNote, PlanProposal } from '../../shared/partner.ts';
import { writeAtomic } from '../fsx.ts';

// What the partner slice keeps between starts, in `workspace/partner.json`: which decisions are already in the Company
// document, the last morning note and how today's tries went, and the plans waiting to become tasks.
export type PartnerState = {
  decided: string[];
  morning?: MorningNote;
  // The founder said they had read today's note: it leaves Needs you and Today's five.
  morningDone?: string;
  tries?: { day: string; count: number; last: number };
  plans: PlanProposal[];
};

export function partnerState(workspace: string) {
  const path = join(workspace, 'partner.json');
  let held: PartnerState | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  async function read(): Promise<PartnerState> {
    if (held) return held;
    try {
      const saved = JSON.parse(await readFile(path, 'utf8')) as Partial<PartnerState>;
      held = { ...saved, decided: Array.isArray(saved.decided) ? saved.decided : [], plans: Array.isArray(saved.plans) ? saved.plans : [] };
    } catch { held = { decided: [], plans: [] }; }
    return held;
  }
  // One change at a time, each on the state as the one before it left it.
  function change<T>(edit: (state: PartnerState) => T | Promise<T>): Promise<T> {
    const job = queue.then(async () => {
      const state = await read();
      const out = await edit(state);
      await writeAtomic(path, JSON.stringify(state, null, 2), { mkdir: true });
      return out;
    });
    queue = job.catch(() => {});
    return job;
  }
  return { read, change, settled: () => queue };
}
export type PartnerStateBook = ReturnType<typeof partnerState>;
