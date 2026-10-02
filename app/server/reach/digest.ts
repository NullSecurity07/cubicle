import type { Attention, Skill, Stage, Task } from '../../shared/model.ts';
import type { Boards } from '../boards.ts';
import { clockTime, dayKey, timeOrDay, weekDay } from '../clock.ts';
import type { Skills } from '../skills.ts';
import { createTrace } from '../trace.ts';

// One screen, once a day. The founder should be able to read this on a pavement and know whether the company needs
// them. Everything in it is already written down somewhere; none of it is worked out by asking a model.
// `five` is Today's five, the same ranked list the dashboard opens on, and it comes first when there is one.
export type Digest = { done: string[]; waiting: string[]; today: string[]; learned: string[]; cost?: string; five?: string[] };
// Any list longer than this is a wall, and a wall is not read at all.
const FEW = 5;
const DAY = 86_400_000;

const sameDay = (one: number, other: number) => dayKey(one) === dayKey(other);
const thousands = (many: number) => (many >= 1000 ? `${Math.round(many / 100) / 10}k` : String(many));

// "and four more" rather than four more lines: the founder can ask for any of it, and the point of this is the shape
// of the day, not the whole of it.
const some = (lines: string[]) => (lines.length <= FEW ? lines : [...lines.slice(0, FEW), `…and ${lines.length - FEW} more`]);

// The words themselves. Nothing to say still says something: a founder who hears nothing cannot tell quiet from broken.
export function digestText(at: number, parts: Digest): string {
  const blocks: string[] = [`**Today** · ${weekDay(at)}`];
  const part = (title: string, lines: string[]) => { if (lines.length) blocks.push([`**${title}**`, ...some(lines).map((line) => `• ${line}`)].join('\n')); };
  part('Five for today', parts.five ?? []);
  part('Done', parts.done);
  part('Waiting for you', parts.waiting);
  part('Coming up today', parts.today);
  part('Learned', parts.learned);
  if (blocks.length === 1) blocks.push('Nothing finished, nothing is waiting for you and nothing is scheduled. Everything is quiet, and I am here.');
  if (parts.cost) blocks.push(`_${parts.cost}_`);
  return blocks.join('\n\n');
}

// Everything the note is made of, gathered from where it already lives.
export function createDigest(deps: { boards: Boards; stage: () => Promise<Stage>; skills: Skills; attention: () => Promise<Attention[]>; workspace: string; now?: () => number; five?: () => Promise<string[]> }) {
  const now = deps.now ?? Date.now;
  const trace = createTrace(deps.workspace, now);

  return async function make(since: number): Promise<string> {
    const at = now();
    const stage = await deps.stage();
    const nameOf = (roomId?: string) => stage.rooms.find((room) => room.id === roomId)?.name ?? 'Someone';
    const done: string[] = [];
    const today: string[] = [];
    for (const card of stage.cards ?? []) {
      if (card.kind !== 'board') continue;
      for (const task of await deps.boards.list(card.id) as Task[]) {
        // A note the founder reads after two days away covers two days: each finished thing says which one it was.
        if (task.run?.state === 'done' && (task.run.finishedAt ?? 0) >= since) done.push(`${nameOf(task.assignee)} finished ${task.title} ${timeOrDay(task.run.finishedAt!, at)}`);
        if (task.nextRun && sameDay(task.nextRun, at) && task.nextRun >= at) today.push(`${clockTime(task.nextRun)} ${task.title} — ${nameOf(task.assignee)}`);
      }
    }
    const waiting = (await deps.attention().catch(() => [] as Attention[]))
      .filter((one) => !one.lapsed)
      .map((one) => (one.kind === 'approval' || one.kind === 'run-approval' ? `${one.who ?? 'Someone'} needs your OK: ${one.title}` : `${one.title}${one.who ? ` — ${one.who}` : ''}`));
    const learned = (await deps.skills.list().catch(() => [] as Skill[]))
      .filter((skill) => skill.createdAt >= since || (skill.history.at(-1)?.at ?? 0) >= since)
      .map((skill) => `${skill.by.name}: ${skill.name}${skill.createdAt >= since ? '' : ' (better now)'}`);
    // What the day came to, read off the same line-a-turn the insights screen reads. Nothing is asked of a provider.
    const summary = await trace.summary(Math.max(1, Math.ceil((at - since) / DAY))).catch(() => null);
    const spent = summary && summary.turns
      ? `${summary.turns} turn${summary.turns === 1 ? '' : 's'}, ${thousands(Object.values(summary.people).reduce((sum, one) => sum + one.input, 0))} in and ${thousands(Object.values(summary.people).reduce((sum, one) => sum + one.output, 0))} out. All of it on free allowances.`
      : undefined;
    const five = await deps.five?.().catch(() => [] as string[]) ?? [];
    return digestText(at, { done, waiting, today: today.sort(), learned, ...(spent ? { cost: spent } : {}), ...(five.length ? { five } : {}) });
  };
}

// The moment the daily note is next due, from the time of day the founder chose, in their own clock.
export function dueAt(at: string, now: number): number {
  const [hour, minute] = /^(\d{1,2}):(\d{2})$/.exec(at.trim())?.slice(1).map(Number) ?? [9, 0];
  const when = new Date(now);
  when.setHours(Math.min(hour, 23), Math.min(minute, 59), 0, 0);
  return when.getTime();
}

// What goes out on this tick. The partner's morning note rides in the digest's own message at the founder's time: one
// message a morning, never two. A note the partner has not written yet is waited for up to ten minutes past that
// time, never past the end of the day (a 23:55 digest still goes that day); then the digest goes alone, and the caller
// marks the note as sent for the day. A digest due before the partner writes at all (`noteFrom`, an hour) waits for
// nothing, since nothing can come, and is still the day's one message: the note stays in the app. Only on a day the
// digest is off does the note go on its own. Yesterday's note never goes.
export const NOTE_WAIT = 10 * 60_000;
// The last tick that is surely still today: a tick comes every half minute.
const LAST_TICK = 60_000;
export const digestSettlesNote = (due: number, noteFrom = 0) => new Date(due).getHours() >= noteFrom;
export function dailyDue(input: { at: number; due: number; digestOn: boolean; lastDigest: number; today: string; noteDay?: string; noteSent?: string; noteExpected?: boolean; noteFrom?: number }): { digest: boolean; note: boolean } {
  const time = input.at >= input.due;
  const note = time && !!input.noteDay && input.noteDay === input.today && input.noteSent !== input.today;
  const until = Math.min(input.due + NOTE_WAIT, new Date(input.due).setHours(24, 0, 0, 0) - LAST_TICK);
  const waiting = !note && !!input.noteExpected && input.noteSent !== input.today && digestSettlesNote(input.due, input.noteFrom) && input.at < until;
  return { digest: input.digestOn && time && input.lastDigest < input.due && !waiting, note };
}
