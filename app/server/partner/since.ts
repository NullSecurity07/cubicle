import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatValue, type Metric } from '../../shared/metrics.ts';
import type { Stage, Task } from '../../shared/model.ts';
import { localDay } from '../clock.ts';
import type { FounderPromise } from './promises.ts';

// What changed since yesterday, worked out in code from the stores, for the head of the morning note: a promise the
// founder let slip, a task left late on a board, a number that moved, a kill-signal check coming up. The model is
// handed these as facts and chooses the day's moves after them; it never decides whether something slipped.

const DAY = 86_400_000;
// A kill-signal check this many days off or nearer is said in the morning, so the founder has the days to act.
export const CHECK_SOON = 3;
// Each kind is said at most this many times: the head of a note is a glance, not a list.
const EACH = 3;

export const NOTHING_CHANGED = 'Nothing changed since yesterday: no promise slipped, no task is late, no number moved and no check is near.';

const noon = (day: string) => new Date(`${day}T12:00`).getTime();
const daysFrom = (from: string, to: string) => Math.round((noon(to) - noon(from)) / DAY);
const late = (days: number) => (days === 1 ? '1 day late' : `${days} days late`);
const inDays = (days: number) => (days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`);

export type SinceInput = {
  now: number;
  promises: FounderPromise[];
  tasks: Task[];
  // Every metric on every Metrics card, with the card's points.
  metrics: Pick<Metric, 'label' | 'unit' | 'better' | 'points'>[];
};

// The lines, most pressing first; empty when nothing changed.
export function sinceYesterday(input: SinceInput): string[] {
  const today = localDay(input.now);
  const yesterday = localDay(input.now - DAY);
  const open = input.promises.filter((one) => one.status === 'open');
  const slips = open.filter((one) => !one.check && one.due < today).sort((one, other) => one.due.localeCompare(other.due))
    .map((one) => `Slipped: you said you would ${one.what} (due ${one.due}), now ${late(daysFrom(one.due, today))}.`);
  const tasks = input.tasks.filter((task) => task.due && task.due < today && task.column !== 'done').sort((one, other) => one.due!.localeCompare(other.due!))
    .map((task) => `Late on the board: ${task.title} (due ${task.due}, ${late(daysFrom(task.due!, today))}).`);
  const moved: string[] = [];
  for (const metric of input.metrics) {
    const points = [...metric.points].sort((one, other) => one.at.localeCompare(other.at));
    const last = points.at(-1);
    if (!last || last.at < yesterday) continue;
    const before = points.slice(0, -1).reverse().find((one) => one.at < last.at);
    if (!before || before.value === last.value) continue;
    const better = (last.value > before.value) === (metric.better === 'up');
    moved.push(`Moved: ${metric.label} went from ${formatValue(before.value, metric.unit)} to ${formatValue(last.value, metric.unit)} (${better ? 'better' : 'worse'}).`);
  }
  const checks = open.filter((one) => one.check && daysFrom(today, one.due) <= CHECK_SOON).sort((one, other) => one.due.localeCompare(other.due))
    .map((one) => {
      const ahead = daysFrom(today, one.due);
      return ahead < 0 ? `Kill-signal check overdue: ${one.what} (was due ${one.due}).` : `Kill-signal check ${inDays(ahead)}: ${one.what} (on ${one.due}).`;
    });
  return [...slips.slice(0, EACH), ...tasks.slice(0, EACH), ...moved.slice(0, EACH), ...checks.slice(0, EACH)];
}

// Everything the lines are read from, out of the stores, never failing the note: a store that cannot be read says
// nothing rather than stopping the morning.
export async function gatherSince(from: {
  stage: Stage; now: number;
  promises?: () => Promise<FounderPromise[]>;
  boards: (boardId: string) => Promise<Task[]>;
  metrics?: (cardId: string) => Promise<SinceInput['metrics']>;
}): Promise<string[]> {
  const cards = from.stage.cards ?? [];
  const tasks: Task[] = [];
  for (const card of cards.filter((one) => one.kind === 'board')) tasks.push(...await from.boards(card.id).catch(() => [] as Task[]));
  const metrics: SinceInput['metrics'] = [];
  if (from.metrics) for (const card of cards.filter((one) => one.kind === 'metrics')) metrics.push(...await from.metrics(card.id).catch(() => []));
  const promises = from.promises ? await from.promises().catch(() => [] as FounderPromise[]) : [];
  return sinceYesterday({ now: from.now, promises, tasks, metrics });
}

// How the head of the note reads, in the app and on the phone alike: the first line is the same in both.
export const sinceText = (since: string[]) => (since.length ? ['**Since yesterday**', ...since.map((line) => `- ${line}`)].join('\n') : NOTHING_CHANGED);
// The one line a notice or a Needs you row leads with.
export const sinceHeadline = (since: string[] | undefined) => (since?.length ? since[0] : undefined);

// A Metrics card's numbers as its sidecar file has them, read fresh: the card's own store keeps its copy in memory.
export async function metricsOnDisk(workspace: string, cardId: string): Promise<SinceInput['metrics']> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(cardId)) return [];
  const read = JSON.parse(await readFile(join(workspace, 'metrics', `${cardId}.json`), 'utf8').catch(() => '{}')) as { metrics?: unknown };
  return Array.isArray(read.metrics) ? (read.metrics as Metric[]).filter((one) => one && typeof one.label === 'string' && Array.isArray(one.points)) : [];
}
