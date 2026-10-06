import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Attention, Stage, Task } from '../../shared/model.ts';
import { TODAY_SIZE, type TodayItem } from '../../shared/today.ts';
import type { Boards } from '../boards.ts';
import { clockTime, localDay, now as clockNow } from '../clock.ts';

// Today's five, worked out without a model: every signal is something the app already keeps (Needs you, the boards'
// repeats), each kind has a fixed weight, and waiting adds a little. The same five go to the dashboard and the phone.

// One thing that might deserve the founder's day: a Needs you entry as it is, or a board task falling due.
// `question` marks a person asking the founder something (ask_founder), which is not a step waiting for an OK.
export type Signal = Pick<Attention, 'id' | 'title' | 'at' | 'who' | 'detail' | 'roomId' | 'cardId' | 'decisionId' | 'taskId' | 'lapsed'> & { kind: string; question?: boolean };

// What each kind weighs, and the words that say why it is here. A person stopped until the founder answers comes
// first, money second, a lead waiting third; suggestions, which wait politely, come last. Kinds added later without a
// line here weigh DEFAULT.
export const WEIGHTS: Record<string, { weight: number; label: string }> = {
  // The partner's morning note is the day's first read, above everything else.
  'morning-note': { weight: 200, label: 'From your partner' },
  approval: { weight: 100, label: 'Someone is stopped until you answer' },
  'run-approval': { weight: 95, label: 'A task is stopped until you answer' },
  'runway-low': { weight: 90, label: 'Cash is running short' },
  // The partner woke up on a signal and has something ready to run.
  'partner-proposal': { weight: 85, label: 'Your partner has a move ready' },
  'lead-stale': { weight: 75, label: 'A lead is waiting on you' },
  'metric-alert': { weight: 70, label: 'A number to look at' },
  'bet-check': { weight: 65, label: 'A bet is due for a check' },
  'proposed-decision': { weight: 60, label: 'A decision is yours to make' },
  // Only once its day has come: something the founder said they would do.
  promise: { weight: 60, label: 'Something you said you would do' },
  'review-due': { weight: 55, label: 'A decision is due for a second look' },
  'key-rejected': { weight: 65, label: 'A model key was refused' },
  'file-damaged': { weight: 80, label: 'A file could not be read' },
  'backup-failed': { weight: 60, label: 'The daily backup failed' },
  'run-failed': { weight: 50, label: 'Work stopped halfway' },
  missed: { weight: 45, label: 'A repeat was missed' },
  'task-due': { weight: 40, label: 'Due today' },
  'planned-today': { weight: 40, label: 'Planned for today' },
  'proposed-task': { weight: 35, label: 'A suggested task' },
  'proposed-target': { weight: 35, label: 'A suggested target' },
  'proposed-runway': { weight: 35, label: 'A suggested change to the runway' },
  'proposed-bet': { weight: 35, label: 'A suggested bet' },
  'proposed-plan': { weight: 35, label: 'A plan to put on the board' },
  'mail-draft': { weight: 70, label: 'An email is ready for you to send' },
  'page-changed': { weight: 25, label: 'A watched page changed' },
  'proposed-source': { weight: 20, label: 'A suggested website' },
};
export const DEFAULT = { weight: 20, label: 'Waiting for you' };
// An approval cut off by a restart can only be asked again: worth a look, not a place at the top.
export const LAPSED = { weight: 15, label: 'A question from before the app restarted' };
// Waiting adds this much a whole day, up to AGE_MOST, so an old item climbs but never past a heavier kind by much.
export const AGE_PER_DAY = 5;
export const AGE_MOST = 25;
export const MOST_PLANNED = 2;
const DAY = 86_400_000;

const waited = (days: number) => (days === 1 ? '1 day' : `${days} days`);
const waiting = (days: number) => (days < 1 ? 'new today' : `waiting ${waited(days)}`);
const place = (index: number) => ['First', 'Second', 'Third', 'Fourth', 'Fifth'][index] ?? `Number ${index + 1}`;

// The ranking itself: pure, so it can be checked with a hand-built list. Highest score first; a tie goes to what has
// waited longer, then to the id, so the same inputs always give the same five.
export function rank(signals: Signal[], now: number, dismissed: ReadonlySet<string> = new Set(), size = TODAY_SIZE): TodayItem[] {
  // A plan's steps are one item per board, and two boards at most: a long plan must not push out what waits on the founder.
  let planned = 0;
  const kept = signals.filter((one) => !dismissed.has(one.id) && (one.kind !== 'planned-today' || ++planned <= MOST_PLANNED));
  const scored = kept.map((one) => {
    const table = one.lapsed ? LAPSED : WEIGHTS[one.kind] ?? DEFAULT;
    // Something due at a set time, or dated by a plan, does not climb by waiting: its date already says when.
    const days = one.kind === 'task-due' || one.kind === 'planned-today' ? 0 : Math.max(0, Math.floor((now - one.at) / DAY));
    const bonus = Math.min(AGE_MOST, days * AGE_PER_DAY);
    return { one, table, days, bonus, score: table.weight + bonus };
  });
  scored.sort((a, b) => b.score - a.score || a.one.at - b.one.at || a.one.id.localeCompare(b.one.id));
  return scored.slice(0, size).map(({ one, table, days, bonus, score }, index) => {
    const approval = one.kind === 'approval' || one.kind === 'run-approval';
    const title = approval && !one.lapsed ? `${one.who ?? 'Someone'} ${one.question ? 'asks you' : 'needs your OK'}: ${one.title}` : one.title;
    const when = one.kind === 'task-due' ? `at ${clockTime(one.at)}` : waiting(days);
    const reason = [table.label, one.kind === 'task-due' || !approval ? one.who : undefined, when].filter(Boolean).join(' · ');
    const why = `${place(index)} of today's ${size}: "${table.label}" weighs ${table.weight}${bonus ? `, plus ${bonus} for waiting ${waited(days)}` : ''}. A fixed table ranks these; no model picks them.`;
    return {
      id: one.id, kind: one.kind, title, reason, why, score,
      ...(one.roomId ? { roomId: one.roomId } : {}), ...(one.cardId ? { cardId: one.cardId } : {}),
      ...(one.decisionId ? { decisionId: one.decisionId } : {}), ...(one.taskId ? { taskId: one.taskId } : {}),
    };
  });
}

// Everything that might go in: Needs you as it stands, and the repeats that fall due before the day is out. A repeat
// already in Needs you (missed, failed) is there once, as its Needs you entry.
// A plan's step that is due by `today`: dated today or left from an earlier day, and not done. A repeat has its own
// time and is counted by it instead. The dashboard's Due today counts by this too, so the two never disagree.
export const plannedBy = (task: Task, today: string) => !task.repeat && !!task.due && task.due <= today && task.column !== 'done';

export async function gather(deps: { attention: { list(): Promise<Attention[]> }; boards: Pick<Boards, 'list'>; stage: () => Promise<Stage> }, now: number): Promise<Signal[]> {
  const needs = await deps.attention.list().catch(() => [] as Attention[]);
  const stage = await deps.stage();
  const listed = new Set(needs.flatMap((one) => (one.taskId ? [one.taskId] : [])));
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const due: Signal[] = [];
  for (const card of stage.cards ?? []) {
    if (card.kind !== 'board') continue;
    const steps: Task[] = [];
    for (const task of await deps.boards.list(card.id).catch(() => [])) {
      // A plan's steps dated today (or left from an earlier day) and not done: gathered, then said once per board.
      if (plannedBy(task, localDay(now)) && !listed.has(task.id)) { steps.push(task); continue; }
      if (listed.has(task.id) || !task.repeat || !task.nextRun || task.nextRun > end.getTime()) continue;
      if (task.run?.state === 'running' || task.run?.state === 'waiting') continue;
      const who = stage.rooms.find((room) => room.id === task.assignee)?.name;
      due.push({ id: `task-due:${task.id}:${task.nextRun}`, kind: 'task-due', title: task.title, at: task.nextRun, cardId: card.id, taskId: task.id, ...(who ? { who } : {}) });
    }
    if (steps.length) {
      const first = steps.sort((a, b) => a.due!.localeCompare(b.due!))[0];
      due.push({ id: `planned-today:${card.id}:${localDay(now)}`, kind: 'planned-today', at: new Date(`${first.due}T00:00:00`).getTime(), cardId: card.id, taskId: first.id,
        title: steps.length === 1 ? first.title : `${first.title}, and ${steps.length - 1} more planned for today` });
    }
  }
  return [...needs.map((one) => ({ ...one, ...(one.event?.name === 'ask_founder' ? { question: true } : {}) })), ...due];
}

// What the founder waved away for today, kept in `workspace/today.json`. A new day starts with nothing waved away.
export type Waved = { day: string; dismissed: string[] };
const path = (workspace: string) => join(workspace, 'today.json');
export async function readWaved(workspace: string, now: number): Promise<Set<string>> {
  try {
    const saved = JSON.parse(await readFile(path(workspace), 'utf8')) as Waved;
    return new Set(saved.day === localDay(now) && Array.isArray(saved.dismissed) ? saved.dismissed : []);
  } catch { return new Set(); }
}
export async function wave(workspace: string, id: string, now: number): Promise<void> {
  const held = await readWaved(workspace, now);
  held.add(id);
  await mkdir(workspace, { recursive: true });
  await writeFile(`${path(workspace)}.tmp`, JSON.stringify({ day: localDay(now), dismissed: [...held] } satisfies Waved, null, 2));
  await rename(`${path(workspace)}.tmp`, path(workspace));
}

// The five, read fresh. The dashboard, the route and the phone's digest all ask this one function.
export async function todayFive(deps: { workspace: string; attention: { list(): Promise<Attention[]> }; boards: Pick<Boards, 'list'>; store: { loadStage(): Promise<Stage> } }, now = clockNow()): Promise<TodayItem[]> {
  const signals = await gather({ attention: deps.attention, boards: deps.boards, stage: () => deps.store.loadStage() }, now);
  return rank(signals, now, await readWaved(deps.workspace, now));
}
// One line of the five, the way the phone says it.
export const todayLine = (item: TodayItem) => `${item.title} — ${item.reason}`;
