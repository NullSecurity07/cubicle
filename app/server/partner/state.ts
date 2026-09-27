import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { MorningNote, PlanProposal } from '../../shared/partner.ts';
import { writeAtomic } from '../fsx.ts';
import { readBook } from '../rescue.ts';

// What the partner slice keeps between starts, in `workspace/partner.json`: which decisions are already in the Company
// document, the last morning note and how today's tries went, and the plans waiting to become tasks.
export type PartnerState = {
  decided: string[];
  morning?: MorningNote;
  // The founder said they had read today's note: it leaves Needs you and Today's five.
  morningDone?: string;
  tries?: { day: string; count: number; last: number };
  // The day a partner was first on the stage: no morning note that day.
  partnerSince?: string;
  plans: PlanProposal[];
  // Every step already offered from each plan doc, by its task title: an edit offers only the steps that are new.
  offered?: Record<string, string[]>;
  // When the app wrote each recent decision line, so one a window saved over can be put back while it is fresh.
  writtenAt?: Record<string, number>;
  // The company's one document once it is made or adopted, found by this id from then on. Gone from the stage, it
  // is not made again until the founder adds a partner again.
  companyId?: string;
  // The partners already wired to it once: a wire the founder takes away is not drawn again.
  wired?: string[];
  // The bets whose check was already posted in the partner's room: said once, across restarts too.
  betChecks?: string[];
};

export function partnerState(workspace: string) {
  const path = join(workspace, 'partner.json');
  let held: PartnerState | null = null;
  let onDisk = false;
  let queue: Promise<unknown> = Promise.resolve();
  async function read(): Promise<PartnerState> {
    // A file that was there and has been taken away (a check cleaning up, the founder starting over) takes what was
    // held with it. A workspace that never had one keeps what is held: it is being written for the first time.
    if (held && onDisk && await access(path).then(() => false, () => true)) { held = null; onDisk = false; }
    if (held) return held;
    const saved = await readBook<Partial<PartnerState>>(path, workspace, { empty: { decided: [], plans: [] }, what: { thing: 'The partner\'s notes file', again: 'the partner\'s notes started again', first: 'the partner\'s notes on decisions and plans start empty' } });
    held = { ...saved, decided: Array.isArray(saved?.decided) ? saved.decided : [], plans: Array.isArray(saved?.plans) ? saved.plans : [] };
    onDisk = saved !== null;
    return held;
  }
  // One change at a time, each on the state as the one before it left it.
  function change<T>(edit: (state: PartnerState) => T | Promise<T>): Promise<T> {
    const job = queue.then(async () => {
      const state = await read();
      const out = await edit(state);
      await writeAtomic(path, JSON.stringify(state, null, 2), { mkdir: true });
      onDisk = true;
      return out;
    });
    queue = job.catch(() => {});
    return job;
  }
  return { read, change, settled: () => queue };
}
export type PartnerStateBook = ReturnType<typeof partnerState>;
