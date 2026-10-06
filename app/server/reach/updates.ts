import type { Stage, Task } from '../../shared/model.ts';
import type { Boards } from '../boards.ts';
import { timeOrDay, now as clockNow } from '../clock.ts';
import type { Book } from './state.ts';

// Something worth telling the founder about, and whether it is worth a sound. Finished work is silent — it is good
// news, and good news can wait for them to look. Work that fell over is not.
export type Note = { key: string; text: string; loud: boolean };
const RESULT = 400;
const WHY = 300;
// A repeat that fails twice is a repeat that is broken, not a repeat that had a bad morning.
const ENOUGH = 2;

const shorten = (text: string, cap: number) => text.replace(/\s+/g, ' ').trim().slice(0, cap);

// Everything one task has to say since it was last looked at. Pure, so the shape of every sentence the founder reads
// can be checked without a board, a clock or a phone anywhere near it. Each line says when: a backlog that arrives
// after a day away otherwise reads as if all of it had happened in the last minute.
export function notesFor(task: Task, who: string, quiet: boolean, now: number): Note[] {
  const notes: Note[] = [];
  const run = task.run;
  const when = (at: number) => timeOrDay(at, now);
  // The moment it was due is gone by the time this reads the card — the board moves the task on the instant it marks
  // it missed — so what is said is the thing that is still true: when it comes round again.
  if (task.missed) notes.push({ key: `missed:${task.id}:${task.nextRun ?? 0}`, text: `${task.title} was due while the app was closed, so it did not run. It is set for next time${task.nextRun ? `, ${when(task.nextRun)}` : ''}.`, loud: false });
  if (!run?.finishedAt && run?.state !== 'blocked') return notes;
  const key = `${run!.state === 'blocked' ? 'blocked' : 'run'}:${task.id}:${run!.startedAt}`;
  const why = shorten(run!.result || run!.log.at(-1) || '', WHY);
  if (run!.state === 'blocked') {
    notes.push({ key, text: `${task.title} could not start ${when(run!.startedAt)}.\n${why.replace(/^did not start: /, '') || 'Something it needs is missing.'}`, loud: true });
  } else if (run!.state === 'done') {
    // A repeat that had been failing and is working again is the one piece of good news worth interrupting nothing for.
    notes.push({ key, text: quiet ? `${who} finished ${task.title} ${when(run!.finishedAt!)} — it is working again.` : `${who} finished ${when(run!.finishedAt!)}: ${task.title}\n\n${shorten(run!.result ?? '', RESULT) || 'Nothing to report.'}`, loud: false });
  } else if (run!.state === 'failed') {
    const fails = task.fails ?? 1;
    if (quiet) return notes;
    const again = task.repeat && fails >= ENOUGH ? `\nThat is ${fails} times in a row. I will leave this one alone until it works again.` : '';
    notes.push({ key, text: `${who} could not finish ${when(run!.finishedAt!)}: ${task.title}\n${why.replace(/^failed: /, '') || 'It stopped without saying why.'}${again}`, loud: true });
  } else if (run!.state === 'stopped') {
    notes.push({ key, text: `${task.title} was stopped ${when(run!.finishedAt!)}, before it finished.`, loud: false });
  }
  return notes;
}

// The founder hears about work finishing or falling over without asking. The board is the truth of it, and the board
// says when it has changed, so this listens for that rather than asking it over and over.
export function createUpdates(deps: { boards: Boards; stage: () => Promise<Stage>; book: Book; tell: (note: Note) => Promise<void>; on: () => Promise<{ finished: boolean; stuck: boolean }>; now?: () => number }) {
  const now = deps.now ?? clockNow;
  // Whatever was already over the first time this looks is history: the founder saw it happen, or was not there to.
  let caught = false;
  let running: Promise<void> | null = null;

  async function look() {
    const allowed = await deps.on();
    const stage = await deps.stage();
    for (const card of stage.cards ?? []) {
      if (card.kind !== 'board') continue;
      for (const task of await deps.boards.list(card.id)) {
        if (task.run?.state === 'running' || task.run?.state === 'waiting') continue;
        const who = stage.rooms.find((room) => room.id === task.assignee)?.name ?? 'Someone';
        const hushed = `hushed:${task.id}`;
        const quiet = await deps.book.told(hushed);
        for (const note of notesFor(task, who, quiet, now())) {
          const stuck = note.key.startsWith('blocked:') || note.key.startsWith('missed:');
          // Marked as told whether or not it goes out, so a switch turned on later does not unpack the whole week.
          if (!(await deps.book.fresh(note.key)) || !caught) continue;
          if (stuck ? !allowed.stuck : !allowed.finished) continue;
          await deps.tell(note).catch(() => {});
        }
        // Said once, then once more when it works: the hush goes on while it keeps failing and lifts when it does not.
        if (task.run?.state === 'failed' && task.repeat && (task.fails ?? 1) >= ENOUGH) await deps.book.mark(hushed);
        else if (quiet && task.run?.state === 'done') await deps.book.forget(hushed);
      }
    }
    caught = true;
  }

  // Several changes land in the same breath when a run ends; one look after them all is enough.
  const coalesced = () => { running ??= Promise.resolve().then(look).catch(() => {}).finally(() => { running = null; }); return running; };
  return { look: coalesced, watch: () => deps.boards.onChange(() => { void coalesced(); }) };
}
