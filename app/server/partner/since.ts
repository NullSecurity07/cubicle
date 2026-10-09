import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Lead, ThreadEvent } from '../../shared/leads.ts';
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
  // Journey 15's day-2 note said "Nothing changed since yesterday" the morning after a lead was written to, five docs,
  // a deck and a film were made and a kill signal was set. What happened counts as well as what slipped: every lead's
  // thread, and the documents with the moment each was last written.
  leads?: Pick<Lead, 'person' | 'thread'>[];
  docs?: { title: string; at: number }[];
};

// What a thread event says, by its kind.
const THREAD: Record<ThreadEvent['kind'], (name: string, event: ThreadEvent) => string> = {
  drafted: (name, event) => `an email to ${name} was drafted${event.subject ? ` ("${event.subject.slice(0, 60)}")` : ''}`,
  sent: (name) => `the email to ${name} went out`,
  opened: (name) => `the email to ${name} was opened in Gmail`,
  replied: (name, event) => `${name} replied${event.text ? `: "${event.text.replace(/\s+/g, ' ').trim().slice(0, 80)}${event.text.length > 80 ? '…' : ''}"` : ''}`,
  meeting: (name, event) => `a meeting with ${name} was set${event.day ? ` for ${event.day}` : ''}`,
  notes: (name) => `notes from the meeting with ${name} were written`,
  closed: (name) => `an ask about ${name} was closed`,
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
  // Since the start of yesterday: what was done, said or logged, newest first.
  const from = noon(yesterday) - DAY / 2;
  const fresh = (when: number) => when >= from && when <= input.now;
  // Journey 18: day 3's note left out Tom's reply and the meeting set with him for that very day, and its move was to
  // email him because his email was opened. A lead's own reply and a meeting set come before what was drafted or
  // opened, and a meeting on today's date is said whenever it was set.
  const FIRST: Partial<Record<ThreadEvent['kind'], number>> = { replied: 0, meeting: 1, notes: 2 };
  const leads = (input.leads ?? []).flatMap((lead) => (lead.thread ?? []).filter((event) => fresh(event.at)).map((event) => ({ at: event.at, first: FIRST[event.kind] ?? 9, line: `Lead: ${THREAD[event.kind]?.(lead.person.name, event) ?? `${lead.person.name}: ${event.kind}`}.` })))
    .sort((one, other) => one.first - other.first || other.at - one.at).map((one) => one.line);
  const meetings = (input.leads ?? []).flatMap((lead) => {
    const set = (lead.thread ?? []).filter((event) => event.kind === 'meeting' && event.day).at(-1);
    const met = set && (lead.thread ?? []).some((event) => event.kind === 'notes' && event.at > set.at);
    return set?.day === today && !met ? [`Meeting today: with ${lead.person.name}${set.time ? ` at ${set.time}` : ''}.`] : [];
  });
  const logged: string[] = [];
  for (const metric of input.metrics) {
    const points = [...metric.points].sort((one, other) => one.at.localeCompare(other.at));
    const last = points.at(-1);
    if (!last || last.at < yesterday) continue;
    const before = points.slice(0, -1).reverse().find((one) => one.at < last.at);
    if (before && before.value !== last.value) continue;
    logged.push(`Logged: ${metric.label} ${formatValue(last.value, metric.unit)} on ${last.at}${before ? ', the same as before' : ''}.`);
  }
  // A promise already said as slipped is not said again as made.
  const promised = input.promises.filter((one) => (fresh(one.at) || (one.closed && one.closed >= yesterday)) && !(one.status === 'open' && !one.check && one.due < today)).sort((one, other) => other.at - one.at).map((one) => {
    if (one.status !== 'open') return one.check ? `Kill-signal check ${one.status === 'done' ? 'closed' : 'replaced'}: ${one.what}.` : `Promise ${one.status === 'done' ? 'kept' : 'dropped'}: ${one.what}.`;
    return one.check ? `Kill-signal check set: ${one.what} (on ${one.due}).` : `Promised: you said you would ${one.what} by ${one.due}.`;
  });
  const docs = (input.docs ?? []).filter((one) => fresh(one.at)).sort((one, other) => other.at - one.at);
  const written = docs.length ? [`Written: ${docs.slice(0, 4).map((one) => `"${one.title}"`).join(', ')}${docs.length > 4 ? ` and ${docs.length - 4} more` : ''}.`] : [];
  return [...meetings.slice(0, EACH), ...slips.slice(0, EACH), ...tasks.slice(0, EACH), ...moved.slice(0, EACH), ...checks.slice(0, EACH),
    ...leads.slice(0, EACH), ...logged.slice(0, EACH), ...promised.slice(0, EACH), ...written];
}

// Everything the lines are read from, out of the stores, never failing the note: a store that cannot be read says
// nothing rather than stopping the morning.
export async function gatherSince(from: {
  stage: Stage; now: number;
  promises?: () => Promise<FounderPromise[]>;
  boards: (boardId: string) => Promise<Task[]>;
  metrics?: (cardId: string) => Promise<SinceInput['metrics']>;
  leads?: (cardId: string) => Promise<Lead[]>;
  workspace?: string;
}): Promise<string[]> {
  const cards = from.stage.cards ?? [];
  const tasks: Task[] = [];
  for (const card of cards.filter((one) => one.kind === 'board')) tasks.push(...await from.boards(card.id).catch(() => [] as Task[]));
  const metrics: SinceInput['metrics'] = [];
  if (from.metrics) for (const card of cards.filter((one) => one.kind === 'metrics')) metrics.push(...await from.metrics(card.id).catch(() => []));
  const promises = from.promises ? await from.promises().catch(() => [] as FounderPromise[]) : [];
  const leads: Lead[] = [];
  if (from.leads) for (const card of cards.filter((one) => one.kind === 'leads')) leads.push(...await from.leads(card.id).catch(() => [] as Lead[]));
  const docs = from.workspace ? await docsWritten(from.workspace, from.stage) : [];
  return sinceYesterday({ now: from.now, promises, tasks, metrics, leads, docs });
}

// Each document on the stage with the moment its file was last written.
export async function docsWritten(workspace: string, stage: Stage): Promise<{ title: string; at: number }[]> {
  // A pinned company document is kept current by the partner on every turn: its own lines say what moved in it.
  const found = await Promise.all(stage.docs.filter((doc) => !doc.pinned && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(doc.id))
    .map(async (doc) => ({ title: doc.title, at: await stat(join(workspace, 'docs', `${doc.id}.md`)).then((info) => info.mtimeMs, () => 0) })));
  return found.filter((one) => one.at > 0);
}

// How the head of the note reads, in the app and on the phone alike: the first line is the same in both.
export const sinceText = (since: string[]) => (since.length ? ['**Since yesterday**', ...since.map((line) => `- ${line}`)].join('\n') : NOTHING_CHANGED);
// The one line a notice or a Needs you row leads with.
export { sinceHeadline } from '../../shared/partner.ts';

// A Metrics card's numbers as its sidecar file has them, read fresh: the card's own store keeps its copy in memory.
export async function metricsOnDisk(workspace: string, cardId: string): Promise<SinceInput['metrics']> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(cardId)) return [];
  const read = JSON.parse(await readFile(join(workspace, 'metrics', `${cardId}.json`), 'utf8').catch(() => '{}')) as { metrics?: unknown };
  return Array.isArray(read.metrics) ? (read.metrics as Metric[]).filter((one) => one && typeof one.label === 'string' && Array.isArray(one.points)) : [];
}
