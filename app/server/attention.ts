import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Attention, AttentionKind } from '../shared/model.ts';
import type { Boards } from './boards.ts';
import type { Store } from './store.ts';

export type AttentionBook = ReturnType<typeof createAttention>;
type Source = () => Promise<Attention[]>;
// What the founder may wave away. A proposal or an approval is answered where it lives, never dismissed here.
const DISMISSABLE = new Set<AttentionKind>(['run-failed', 'missed', 'review-due']);

// Everything that waits for the founder, as one list. Most of it is read fresh from where it lives (boards, decisions)
// through `source`, so the list cannot drift from the truth. Only two things are kept here: approvals in flight, so
// that one cut off by the app closing is still shown (as lapsed), and what the founder dismissed.
export function createAttention(dir: string) {
  const path = join(dir, 'attention.json');
  const sources: Source[] = [];
  const watchers = new Set<(list: Attention[]) => void>();
  let queue: Promise<unknown> = Promise.resolve();
  let state: { open: Attention[]; dismissed: string[] } | null = null;

  // Read once, however many ask at the same moment: two first readers each making their own copy meant whatever was
  // raised into the first copy was gone when the second one replaced it.
  let reading: Promise<{ open: Attention[]; dismissed: string[] }> | null = null;
  const load = () => (reading ??= read());
  async function read() {
    let saved: { open?: Attention[]; dismissed?: string[] } = {};
    try { saved = JSON.parse(await readFile(path, 'utf8')); } catch { /* nothing waited */ }
    // Whatever was waiting when the app last closed belonged to a turn that no longer exists.
    // (A task run that was waiting is reported by its board as cut off; keeping it here too would show it twice.)
    state = { open: (saved.open ?? []).filter((entry) => entry.kind !== 'run-approval').map(({ event: _event, ...entry }) => ({ ...entry, lapsed: true })), dismissed: saved.dismissed ?? [] };
    return state;
  }
  async function list(): Promise<Attention[]> {
    const { open, dismissed } = await load();
    const reported = (await Promise.all(sources.map((source) => source().catch(() => [])))).flat();
    return [...reported.filter((entry) => !dismissed.includes(entry.id)), ...open].sort((a, b) => b.at - a.at);
  }
  async function changed() {
    const { open, dismissed } = await load();
    const text = JSON.stringify({ open, dismissed: dismissed.slice(-500) }, null, 2);
    queue = queue.then(async () => { await mkdir(dir, { recursive: true }); await writeFile(`${path}.tmp`, text); await rename(`${path}.tmp`, path); }).catch(() => {});
    const now = await list();
    for (const tell of watchers) tell(now);
  }

  return {
    list,
    settled: () => queue,
    source(source: Source) { sources.push(source); },
    // Something a source reports has changed (a board, a decision): tell whoever watches.
    async refresh() { const now = await list(); for (const tell of watchers) tell(now); },
    async raise(entry: Attention) { const { open } = await load(); state!.open = [...open.filter((one) => one.id !== entry.id), entry]; await changed(); },
    async clear(id: string) { const { open } = await load(); if (!open.some((one) => one.id === id)) return; state!.open = open.filter((one) => one.id !== id); await changed(); },
    async dismiss(id: string) {
      const { open, dismissed } = await load();
      const held = open.find((one) => one.id === id);
      if (held) { if (!held.lapsed) throw new Error('this is still waiting for an answer'); state!.open = open.filter((one) => one.id !== id); return changed(); }
      const reported = (await list()).find((one) => one.id === id);
      if (!reported || !DISMISSABLE.has(reported.kind)) throw new Error('this cannot be dismissed; answer it where it lives');
      state!.dismissed = [...dismissed, id];
      await changed();
    },
    watch(tell: (list: Attention[]) => void) { watchers.add(tell); return () => { watchers.delete(tell); }; },
  };
}

const CUT_OFF = 'stopped: the app was closed';

// What the boards hold for the founder: proposals to accept or decline, runs that failed or were cut off, repeats that were missed.
export const boardAttention = (store: Store, boards: Boards) => async (): Promise<Attention[]> => {
  const stage = await store.loadStage();
  const nameOf = (roomId?: string) => stage.rooms.find((room) => room.id === roomId)?.name;
  const found: Attention[] = [];
  for (const card of stage.cards ?? []) {
    if (card.kind !== 'board') continue;
    for (const task of await boards.list(card.id)) {
      const where = { cardId: card.id, taskId: task.id, title: task.title };
      if (task.column === 'proposed') found.push({ ...where, id: `proposed:${card.id}:${task.id}`, kind: 'proposed-task', at: task.createdAt, who: task.proposedBy, detail: task.detail.slice(0, 240) || undefined });
      const last = task.run?.log.at(-1) ?? '';
      // A task that could not even start (no such person, a skill switched off, a script that does not parse) waits for
      // the founder as surely as one that failed halfway; a repeat that stays blocked unseen is work that quietly stopped.
      if (task.run?.state === 'blocked') found.push({ ...where, id: `run-failed:${task.id}:${task.run.startedAt}`, kind: 'run-failed', at: task.run.startedAt, who: nameOf(task.assignee), detail: (task.run.result ?? last).replace(/^did not start: /, '') });
      if (task.run?.state === 'failed') found.push({ ...where, id: `run-failed:${task.id}:${task.run.startedAt}`, kind: 'run-failed', at: task.run.finishedAt ?? task.run.startedAt, who: nameOf(task.assignee), detail: last.replace(/^failed: /, '') });
      else if (task.run?.state === 'stopped' && last === CUT_OFF) found.push({ ...where, id: `run-failed:${task.id}:${task.run.startedAt}`, kind: 'run-failed', at: task.run.finishedAt ?? task.run.startedAt, who: nameOf(task.assignee), detail: 'The app closed while this was running. Run it again when you want it.' });
      if (task.missed) found.push({ ...where, id: `missed:${task.id}:${task.nextRun ?? 0}`, kind: 'missed', at: task.createdAt, who: nameOf(task.assignee), detail: 'A repeat fell due while the app was closed. It was not run late.' });
    }
  }
  return found;
};
