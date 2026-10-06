import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Lead } from '../../shared/leads.ts';
import { STAGE_NAMES } from '../../shared/leads.ts';
import { formatValue, isDay, type Metric, type MetricPoint, type Metrics } from '../../shared/metrics.ts';
import type { Attention, Stage } from '../../shared/model.ts';
import { bare, type Bet } from '../../shared/partner.ts';
import { localDay } from '../clock.ts';
import { writeAtomic } from '../fsx.ts';
import type { ModelMessage } from '../prompt.ts';
import { plusDays } from './call.ts';
import type { FounderPromise } from './promises.ts';

// The partner watch (gap audit 2026-10-06, A. Initiative). The partner wrote one morning note a day and nothing else
// woke them: a number sliding toward the kill line, a lead who replied, a competitor's page that changed and a promise
// gone stale were rows the founder had to read and act on alone. Now each of the four wakes the partner for one turn
// of their own, and the turn ends in something ready to run — an email draft, a dated task, a decision, or "drop it?"
// — waiting in Needs you with Run and Don't. Unasked turns are few (a daily budget), one open row per trigger, and
// never on the partner-only model: those turns are kept for what the founder asks.

const DAY = 86_400_000;

// ---------------------------------------------------------------- the daily budget for unasked turns

// What the budget answers: whether this turn may be taken, and in words why not.
export type Taken = { ok: boolean; why?: string; left?: number };
// BUDGET SEAM: the shared unasked budget in usage.ts (`unasked.take(reason) → { ok, left, why }`) replaces this counter
// when it lands on main. Anything with `take` fits.
export type Budget = { take(reason: string): Taken | Promise<Taken> };
export const UNASKED_A_DAY = 3;
export const budgetUsed = (used: number, cap: number) => `budget used today: ${used} of ${cap} unasked turns`;

// Three unasked turns a day, counted in `workspace/partner-watch-budget.json` so a restart does not hand out three more.
export function dailyBudget(workspace: string, now: () => number = Date.now, cap = UNASKED_A_DAY): Budget & { used(): Promise<number> } {
  const path = join(workspace, 'partner-watch-budget.json');
  let queue: Promise<unknown> = Promise.resolve();
  const read = async () => {
    try {
      const saved = JSON.parse(await readFile(path, 'utf8')) as { day?: string; used?: number };
      return saved.day === localDay(now()) && typeof saved.used === 'number' ? saved.used : 0;
    } catch { return 0; }
  };
  return {
    used: read,
    take(reason: string) {
      const job = queue.then(async (): Promise<Taken> => {
        const used = await read();
        if (used >= cap) return { ok: false, left: 0, why: budgetUsed(used, cap) };
        await writeAtomic(path, JSON.stringify({ day: localDay(now()), used: used + 1, last: reason.slice(0, 200) }, null, 2), { mkdir: true });
        return { ok: true, left: cap - used - 1 };
      });
      queue = job.catch(() => {});
      return job;
    },
  };
}

// ---------------------------------------------------------------- trending to the kill line

// How far the latest reading has gone from where it stood toward a line: 0 where it started, 1 on the line, more past
// it. Half-way is when the partner speaks up: soon enough to act, late enough not to cry wolf on a wobble.
export type Toward = { start: number; latest: number; line: number; share: number; crossed: boolean };
export const HALF = 0.5;
export function towardLine(start: number, latest: number, line: number): Toward | null {
  const gap = line - start;
  if (!Number.isFinite(gap) || gap === 0) return null;
  const share = Math.round(((latest - start) / gap) * 1000) / 1000;
  return { start, latest, line, share, crossed: share >= 1 };
}
export const trending = (toward: Toward | null | undefined): toward is Toward => !!toward && toward.share >= HALF;

// The reading a line is measured from (the last one on or before the day it was set, else the first one after) and the
// latest one. Null while no newer reading has come in since: nothing has moved yet.
export function readingsSince(points: MetricPoint[], since: string): { start: MetricPoint; latest: MetricPoint } | null {
  const sorted = [...points].sort((a, b) => a.at.localeCompare(b.at));
  if (sorted.length < 2) return null;
  const before = sorted.filter((point) => point.at <= since);
  const start = before.at(-1) ?? sorted[0];
  const latest = sorted.at(-1)!;
  return sorted.indexOf(latest) > sorted.indexOf(start) ? { start, latest } : null;
}

const STOP = new Set(['the', 'and', 'per', 'our', 'your', 'from', 'with', 'than', 'week', 'weekly', 'month', 'monthly', 'day', 'daily', 'total', 'number', 'count']);
const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !/^\d+$/.test(word) && !STOP.has(word)).map((word) => word.replace(/s$/, ''));
const NUMBER = /[$€£]?\s*(-?\d[\d,]*(?:\.\d+)?)\s*(k\b|%)?/gi;
const COMPARED = /\b(?:below|under|beneath|less than|fewer than|lower than|above|over|more than|higher than|exceeds?|at least|at most|to|reaches?|hits?)\s*[<>=]*\s*$|[<>]=?\s*$/i;
const valueOf = (raw: string, suffix?: string) => { const value = Number(raw.replace(/,/g, '')); return suffix?.toLowerCase() === 'k' ? value * 1000 : value; };

// The Metrics row a kill signal names and the number that is its line: "weekly signups below 5" is the Signups row,
// line 5. The row is the one whose every word the signal says (the most words wins); the line, the number said after
// "below", "under", "above"… or else the first number in it. Null when no row or no number fits.
export function killLineOf(what: string, metrics: Metric[]): { metric: Metric; line: number } | null {
  const said = new Set(words(what));
  const fits = metrics.map((metric) => ({ metric, own: [...new Set([...words(metric.label), ...words(metric.key.replace(/[-_]/g, ' '))])] }))
    .filter((one) => one.own.length && words(one.metric.label).every((word) => said.has(word)))
    .sort((a, b) => words(b.metric.label).length - words(a.metric.label).length);
  const metric = fits[0]?.metric;
  if (!metric) return null;
  const numbers = [...what.matchAll(NUMBER)].map((match) => ({ value: valueOf(match[1], match[2]), compared: COMPARED.test(what.slice(0, match.index)) }));
  const line = (numbers.find((one) => one.compared) ?? numbers[0])?.value;
  return line === undefined || !Number.isFinite(line) ? null : { metric, line };
}

// ---------------------------------------------------------------- what wakes the partner

// What the turn must end in. The address is code's, never the model's: a lead's own address, on record.
export type Output = { kind: 'email'; to: string; name: string } | { kind: 'task' } | { kind: 'task-or-decision' } | { kind: 'task-or-drop'; promiseId: string; what: string };
// One trigger. `key` is the event, never raised twice; `trigger` is what it is about, which has one open row at most
// (a lead that replies again while the last reply's row waits is not a second row). `money` orders the day when the
// budget cannot cover all of them (a number going to the kill line first). `number` is the figure, read in code.
export type Spark = { key: string; trigger: string; kind: 'metric' | 'lead' | 'page' | 'promise'; at: number; money: number; why: string; facts: string; number?: string; out: Output; roomId?: string; cardId?: string };

export type MetricsCard = { cardId: string; metrics: Metric[] };

// (a) and the kill-signal trend: the open kill signal of the partner's last verdict, read against the Metrics row it
// names from the day it was set; and every open bet's own number read from the day it was taken toward its target.
export function metricSparks(cards: MetricsCard[], kill: FounderPromise | undefined, bets: Bet[], at: number): Spark[] {
  const found: Spark[] = [];
  const all = cards.flatMap((card) => card.metrics.map((metric) => ({ card, metric })));
  if (kill && kill.status === 'open') {
    const lineOf = killLineOf(kill.what, all.map((one) => one.metric));
    const card = lineOf && all.find((one) => one.metric === lineOf.metric)!.card;
    const read = lineOf && readingsSince(lineOf.metric.points, kill.said);
    const toward = read && towardLine(read.start.value, read.latest.value, lineOf!.line);
    if (lineOf && read && trending(toward)) {
      const { metric } = lineOf;
      const said = (value: number) => formatValue(value, metric.unit);
      const number = `${metric.label}: ${said(read.latest.value)} on ${read.latest.at}, from ${said(read.start.value)} on ${read.start.at}; the kill line is ${said(lineOf.line)} (${kill.what}, checked on ${kill.due}).`;
      found.push({
        key: `kill:${kill.id}:${metric.key}`, trigger: `kill:${metric.key}`, kind: 'metric', at, money: 100, cardId: card!.cardId, number,
        why: toward.crossed ? `${metric.label} crossed the kill line` : `${metric.label} is trending to the kill line`,
        facts: `${toward.crossed ? 'The number has crossed the kill line' : `The number is trending to the kill line: ${Math.round(toward.share * 100)}% of the way from where it stood at your verdict`}.\n${number}\n${kill.due >= localDay(at) ? `The verdict's check is on ${kill.due}.` : `The verdict's check day, ${kill.due}, has passed.`}`,
        out: { kind: 'task-or-decision' },
      });
    }
  }
  for (const bet of bets.filter((one) => one.status === 'open' && !one.result)) {
    const hit = all.find((one) => one.metric.key === bet.metric.toLowerCase() || one.metric.label.toLowerCase() === bet.metric.toLowerCase());
    const read = hit && readingsSince(hit.metric.points, bet.made);
    const toward = read && towardLine(read.start.value, read.latest.value, bet.target);
    if (!hit || !read || !trending(toward)) continue;
    const said = (value: number) => formatValue(value, hit.metric.unit);
    const number = `${hit.metric.label}: ${said(read.latest.value)} on ${read.latest.at}, from ${said(read.start.value)} when the bet was taken; the target is ${said(bet.target)} by ${bet.checkDate}.`;
    found.push({
      key: `bet:${bet.id}`, trigger: `bet:${bet.id}`, kind: 'metric', at, money: 60, cardId: hit.card.cardId, number,
      why: toward.crossed ? `the bet "${bare(bet.what)}" reached its target` : `the bet "${bare(bet.what)}" is half-way to its target`,
      facts: `An open bet is ${toward.crossed ? 'at its target already' : 'half-way to its target'}: "${bare(bet.what)}" (${bet.hypothesis}).\n${number}`,
      out: { kind: 'task-or-decision' },
    });
  }
  return found;
}

// (b) A lead that moved to Replied since the last look. The first look only learns where every lead stands. A lead the
// partner never saw that arrives already at Replied counts as a move too.
export function leadSparks(leads: (Lead & { cardId: string })[], seen: Record<string, string> | undefined, at: number): Spark[] {
  if (!seen) return [];
  return leads.filter((lead) => lead.stage === 'replied' && seen[lead.id] !== 'replied').map((lead) => {
    const who = `${lead.person.name}${lead.person.title ? `, ${lead.person.title}` : ''} at ${lead.company.name}`;
    const notes = lead.notes.slice(-4).map((note) => `- ${localDay(note.at)} ${note.by}: ${note.text}`).join('\n');
    return {
      key: `lead:${lead.id}:replied:${lead.updatedAt}`, trigger: `lead:${lead.id}`, kind: 'lead' as const, at, money: 80, cardId: lead.cardId,
      why: `${lead.person.name} moved to ${STAGE_NAMES.replied}`,
      number: `${lead.person.name} (${lead.company.name}) moved from ${STAGE_NAMES[(seen[lead.id] ?? 'new') as Lead['stage']] ?? 'New'} to ${STAGE_NAMES.replied}.`,
      facts: `A lead replied: ${who}.${lead.person.email ? ` Address on record: ${lead.person.email}.` : ' No email address is on record for them.'}${notes ? `\nNotes on the lead:\n${notes}` : ''}`,
      out: lead.person.email ? { kind: 'email' as const, to: lead.person.email, name: lead.person.name } : { kind: 'task' as const },
    };
  });
}

// (c) A watched page that changed: one per change (the row's id carries the moment it changed).
export function pageSparks(rows: Attention[], at: number): Spark[] {
  return rows.filter((row) => row.kind === 'page-changed').map((row) => ({
    key: `page:${row.id}`, trigger: `page:${row.id.split(':')[1] ?? row.id}`, kind: 'page' as const, at, money: 30, ...(row.cardId ? { cardId: row.cardId } : {}),
    why: row.title.replace(/^The page /, 'the page ').replace(/\s+changed$/, ' changed'),
    facts: `${row.title}${row.who ? `, watched by ${row.who}` : ''}.\nWhat changed:\n${(row.detail ?? '').slice(0, 2500)}`,
    out: { kind: 'task' as const },
  }));
}

// (d) A promise the founder made, two days past its day and still open. The verdict's own check is not one.
export const LATE_DAYS = 2;
export function promiseSparks(promises: FounderPromise[], at: number): Spark[] {
  const cutoff = plusDays(localDay(at), -LATE_DAYS);
  return promises.filter((one) => one.status === 'open' && !one.check && one.due <= cutoff).map((one) => {
    const late = Math.round((new Date(`${localDay(at)}T12:00`).getTime() - new Date(`${one.due}T12:00`).getTime()) / DAY);
    return {
      key: `promise:${one.id}`, trigger: `promise:${one.id}`, kind: 'promise' as const, at, money: 50, ...(one.roomId ? { roomId: one.roomId } : {}),
      why: `"${one.what}" is ${late} days late`,
      number: `You said you would ${one.what} by ${one.due}; that was ${late} days ago.`,
      facts: `A promise the founder made is ${late} days late and still open: "${one.what}" (said on ${one.said}, due ${one.due}).`,
      out: { kind: 'task-or-drop' as const, promiseId: one.id, what: one.what },
    };
  });
}

// ---------------------------------------------------------------- the turn and what it ends in

export type Draft = { kind: 'email'; to: string; subject: string; body: string } | { kind: 'task'; title: string; due: string }
  | { kind: 'decision'; title: string } | { kind: 'drop'; promiseId: string; what: string };
export type Proposal = {
  id: string; key: string; trigger: string; at: number; who: string; roomId: string; sparkKind: Spark['kind'];
  move: string; why: string; number?: string; read?: string; draft: Draft; cardId?: string;
  status: 'open' | 'run' | 'declined'; answered?: number; provider?: string; model?: string;
};

// What the partner is asked, after their own system prompt: the facts in code's words, then the lines to answer in.
export function watchAsk(spark: Spark, today: string): string {
  const due = `Due: YYYY-MM-DD, a day from ${today} to ${plusDays(today, 7)}`;
  const task = `Task: the task for the founder, in a few words\n${due}`;
  const out = spark.out.kind === 'email'
    ? `Subject: the email's subject\nBody: the reply to ${spark.out.name}, plain text, under 120 words, proposing a 20-minute call, signed by the founder. Every line after "Body:" is the email.`
    : spark.out.kind === 'task-or-decision' ? `Then EITHER\n${task}\nOR, when the move is a call the founder makes rather than work they do,\nDecision: what the founder decides, in one line`
    : spark.out.kind === 'task-or-drop' ? `Then EITHER\n${task}\nOR, when letting it go is right,\nDrop: one line on why`
    : task;
  const read = spark.kind === 'page' ? 'Read: one paragraph, what changed on the page and what it means for us\n' : '';
  return `Nobody asked you: you noticed this yourself, and the founder will see it in Needs you with Run and Don't.\n\n${spark.facts}\n\n`
    + 'Answer in exactly these lines and nothing else. Use only the numbers above; invent none.\n'
    + `${read}Move: the one move for this week, in one sentence\n${out}`;
}

const line = (text: string, label: string) => new RegExp(`^\\s*(?:\\*\\*)?${label}(?:\\*\\*)?\\s*:\\s*(?:\\*\\*)?\\s*(.+)$`, 'im').exec(text)?.[1]?.replace(/\*\*/g, '').trim() ?? '';
const tidy = (text: string, most: number) => text.replace(/\s+/g, ' ').trim().slice(0, most);

// The partner's answer read back into a ready output. Whatever the answer leaves out is filled from the facts, so the
// row is always something the founder can run: the address is the lead's own, the day a real day this week.
export function proposalOf(spark: Spark, reply: string, today: string): Pick<Proposal, 'move' | 'read' | 'draft'> {
  const move = tidy(line(reply, 'Move'), 240) || fallbackMove(spark);
  const read = spark.kind === 'page' ? tidy(line(reply, 'Read'), 900) || undefined : undefined;
  const dueSaid = line(reply, 'Due').slice(0, 10);
  const due = isDay(dueSaid) && dueSaid >= today && dueSaid <= plusDays(today, 14) ? dueSaid : plusDays(today, 1);
  const taskTitle = tidy(line(reply, 'Task'), 140) || tidy(move.replace(/[.]+$/, ''), 140);
  let draft: Draft;
  if (spark.out.kind === 'email') {
    const body = /^\s*(?:\*\*)?Body(?:\*\*)?\s*:\s*([\s\S]+)$/im.exec(reply)?.[1]?.trim() ?? '';
    draft = { kind: 'email', to: spark.out.to, subject: tidy(line(reply, 'Subject'), 140) || 'Thanks for getting back to me', body: body.slice(0, 2000) || `Hi ${spark.out.name.split(' ')[0]},\n\nThanks for your reply. Would a 20-minute call this week work for you?\n\nBest,` };
  } else if (spark.out.kind === 'task-or-drop' && line(reply, 'Drop') && !line(reply, 'Task')) {
    draft = { kind: 'drop', promiseId: spark.out.promiseId, what: spark.out.what };
  } else if (spark.out.kind === 'task-or-decision' && line(reply, 'Decision') && !line(reply, 'Task')) {
    draft = { kind: 'decision', title: tidy(line(reply, 'Decision'), 160) };
  } else draft = { kind: 'task', title: taskTitle, due };
  return { move, ...(read ? { read } : {}), draft };
}

const fallbackMove = (spark: Spark) => spark.kind === 'metric' ? 'Find out this week what is moving the number, before the check day.'
  : spark.kind === 'lead' ? 'Reply today and propose a short call.'
  : spark.kind === 'promise' ? 'Put it on a day this week, or let it go.'
  : 'Look at what changed and decide whether it changes our plan.';

// What a fake run's partner says, so a browser check sees the whole road without a key.
export function fakeWatchReply(messages: ModelMessage[]): string {
  const asked = messages.at(-1)?.content ?? '';
  const move = /kill line/.test(asked) ? 'Call five lapsed signups this week and ask what stopped them.' : /A lead replied/.test(asked) ? 'Reply today and offer a 20-minute call.'
    : /promise/.test(asked) ? 'Put it on Thursday, or drop it.' : 'Check whether their change undercuts our price.';
  const lines = [`Move: ${move}`];
  if (/^Read:/m.test(asked)) lines.unshift('Read: The page changed its offer; it matters if it now competes with our price.');
  if (/^Subject:/m.test(asked)) lines.push('Subject: Thanks for your reply', 'Body: Hi,\n\nThanks for getting back to me. Would a 20-minute call on Thursday work?\n\nBest,');
  else lines.push(`Task: ${move.replace(/[.]$/, '')}`);
  return lines.join('\n');
}

// What a row says: who proposes what, then that nobody asked and why the partner spoke, the number, the read, and
// the ready thing itself.
export function draftLine(draft: Draft): string {
  if (draft.kind === 'email') return `Ready: an email to ${draft.to}, "${draft.subject}"\n${draft.body}`;
  if (draft.kind === 'task') return `Ready: the task "${draft.title}", due ${draft.due}`;
  if (draft.kind === 'decision') return `Ready: the decision "${draft.title}"`;
  return `Ready: drop the promise "${draft.what}"`;
}
export const proposalRow = (one: Proposal): Attention => ({
  id: `partner-proposal:${one.id}`, kind: 'partner-proposal', at: one.at, who: one.who, roomId: one.roomId, ...(one.cardId ? { cardId: one.cardId } : {}),
  title: `${one.who} proposes: ${one.move}`,
  detail: [`Unasked · ${one.why}.`, one.number, one.read, draftLine(one.draft)].filter(Boolean).join('\n'),
});

// ---------------------------------------------------------------- the watch itself

export type WatchState = { fired: string[]; proposals: Proposal[]; seenLeads?: Record<string, string>; waiting: { key: string; why: string; what: string; at: number }[] };
// What a Run does, kind by kind; the partner slice hands in the real ones (the board, the decisions log, the promises
// book, Needs you's email row).
export type Acts = {
  email(draft: Extract<Draft, { kind: 'email' }>, proposal: Proposal): Promise<unknown>;
  task(draft: Extract<Draft, { kind: 'task' }>, proposal: Proposal): Promise<unknown>;
  decision(draft: Extract<Draft, { kind: 'decision' }>, proposal: Proposal): Promise<unknown>;
  drop(draft: Extract<Draft, { kind: 'drop' }>, proposal: Proposal): Promise<unknown>;
};
export type WatchDeps = {
  workspace: string; now: () => number; budget: Budget; busy: Set<string>;
  stage(): Promise<Stage>;
  attention(): Promise<Attention[]>;
  promises(): Promise<FounderPromise[]>;
  bets(): Promise<Bet[]>;
  leads(cardId: string): Promise<Lead[]>;
  promptFor(stage: Stage, roomId: string): Promise<ModelMessage[]>;
  // The partner's unasked turn: routed with `reserved: false`, so never on the partner-only model.
  ask(messages: ModelMessage[]): Promise<{ text: string; provider?: string; model?: string }>;
  acts: Acts;
  changed(): Promise<void>;
  notify?(title: string, body: string): void;
  // SAID-NO SEAM: the founder-said-no helper (`saidNo.check`) goes here when it lands on main. Given the proposal
  // before it is raised, it answers with the proposal (relabelled if it must name what changed) or null to hold it back.
  vet?(proposal: Proposal): Promise<Proposal | null>;
};
const MOST_FIRED = 400;
const MOST_KEPT = 60;
const readJson = async <T>(path: string, fallback: T): Promise<T> => { try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return fallback; } };

export function createWatch(deps: WatchDeps) {
  const path = join(deps.workspace, 'partner-watch.json');
  let held: WatchState | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<WatchState> => {
    if (held) return held;
    const saved = await readJson<Partial<WatchState>>(path, {});
    held = { fired: Array.isArray(saved.fired) ? saved.fired : [], proposals: Array.isArray(saved.proposals) ? saved.proposals : [], waiting: Array.isArray(saved.waiting) ? saved.waiting : [], ...(saved.seenLeads ? { seenLeads: saved.seenLeads } : {}) };
    return held;
  };
  function change<T>(edit: (state: WatchState) => T | Promise<T>): Promise<T> {
    const job = queue.then(async () => {
      const state = await read();
      const out = await edit(state);
      state.fired = state.fired.slice(-MOST_FIRED);
      state.proposals = [...state.proposals.filter((one) => one.status === 'open'), ...state.proposals.filter((one) => one.status !== 'open').slice(-MOST_KEPT)];
      await writeAtomic(path, JSON.stringify(state, null, 2), { mkdir: true });
      return out;
    });
    queue = job.catch(() => {});
    return job;
  }

  // Every Metrics card on the stage, read from its file.
  async function metricsCards(stage: Stage): Promise<MetricsCard[]> {
    return Promise.all((stage.cards ?? []).filter((card) => card.kind === 'metrics').map(async (card) => ({ cardId: card.id, metrics: (await readJson<Partial<Metrics>>(join(deps.workspace, 'metrics', `${card.id}.json`), {})).metrics ?? [] })));
  }

  // One look: every trigger found, ordered by money at risk, each turned into one proposal while the budget lasts.
  let looking: Promise<{ made: Proposal[]; waiting: WatchState['waiting'] }> | null = null;
  const look = () => (looking ??= (async () => {
    try {
      const at = deps.now();
      const today = localDay(at);
      const stage = await deps.stage();
      const partner = stage.rooms.find((room) => room.partner);
      if (!partner || deps.busy.has(partner.id)) return { made: [], waiting: (await read()).waiting };
      const [promises, bets, rows, cards] = await Promise.all([deps.promises().catch(() => []), deps.bets().catch(() => []), deps.attention().catch(() => []), metricsCards(stage)]);
      const leads = (await Promise.all((stage.cards ?? []).filter((card) => card.kind === 'leads').map(async (card) => (await deps.leads(card.id).catch(() => [])).map((lead) => ({ ...lead, cardId: card.id }))))).flat();
      const state = await read();
      const kill = promises.filter((one) => one.check && one.status === 'open').at(-1);
      const sparks = [...metricSparks(cards, kill, bets, at), ...leadSparks(leads, state.seenLeads, at), ...promiseSparks(promises, at), ...pageSparks(rows, at)]
        .sort((a, b) => b.money - a.money);
      const open = new Set(state.proposals.filter((one) => one.status === 'open').map((one) => one.trigger ?? one.key));
      const fired = new Set(state.fired);
      const made: Proposal[] = [];
      const waiting: WatchState['waiting'] = [];
      const held = new Set<string>();
      for (const spark of sparks) {
        if (open.has(spark.trigger) || fired.has(spark.key)) continue;
        const taken = await deps.budget.take(spark.why);
        if (!taken.ok) { waiting.push({ key: spark.key, what: spark.why, why: taken.why ?? 'no unasked turns left today', at }); held.add(spark.key); continue; }
        const messages: ModelMessage[] = [...await deps.promptFor(stage, partner.id), { role: 'user', content: watchAsk(spark, today) }];
        const reply = await deps.ask(messages).catch((error: Error) => { console.error(`partner watch: ${error.message}`); return null; });
        const shaped = proposalOf(spark, reply?.text ?? '', today);
        let proposal: Proposal | null = {
          id: `${spark.kind}-${at.toString(36)}-${made.length}`, key: spark.key, trigger: spark.trigger, at, who: partner.name, roomId: partner.id, sparkKind: spark.kind,
          why: spark.why, ...(spark.number ? { number: spark.number } : {}), ...(spark.cardId ? { cardId: spark.cardId } : {}), ...shaped, status: 'open',
          ...(reply?.provider ? { provider: reply.provider } : {}), ...(reply?.model ? { model: reply.model } : {}),
        };
        if (deps.vet) proposal = await deps.vet(proposal);
        fired.add(spark.key);
        open.add(spark.trigger);
        if (proposal) made.push(proposal);
      }
      // A lead is seen where it stands now, except one whose move still waits for tomorrow's budget.
      const later = new Set(sparks.filter((one) => one.kind === 'lead' && held.has(one.key)).map((one) => one.trigger));
      const seen = Object.fromEntries(leads.map((lead) => [lead.id, later.has(`lead:${lead.id}`) ? (state.seenLeads?.[lead.id] ?? 'new') : lead.stage]));
      await change((draft) => {
        draft.fired = [...draft.fired, ...[...fired].filter((key) => !draft.fired.includes(key))];
        draft.proposals = [...draft.proposals, ...made];
        draft.seenLeads = seen;
        draft.waiting = waiting;
      });
      if (made.length) {
        await deps.changed().catch(() => {});
        deps.notify?.(`${partner.name} proposes a move`, made[0].move);
      }
      return { made, waiting };
    } finally { looking = null; }
  })());

  return {
    look,
    read,
    settled: () => queue,
    rows: async (): Promise<Attention[]> => (await read()).proposals.filter((one) => one.status === 'open').map(proposalRow),
    // Run: the ready thing is done (the email drafted, the task on the board, the decision on record, the promise
    // dropped). Don't: it goes, and the trigger stays answered.
    async answer(id: string, run: boolean): Promise<Proposal> {
      const proposal = (await read()).proposals.find((one) => one.id === id && one.status === 'open');
      if (!proposal) throw new Error('that proposal is no longer waiting');
      if (run) {
        const { draft } = proposal;
        if (draft.kind === 'email') await deps.acts.email(draft, proposal);
        else if (draft.kind === 'task') await deps.acts.task(draft, proposal);
        else if (draft.kind === 'decision') await deps.acts.decision(draft, proposal);
        else await deps.acts.drop(draft, proposal);
      }
      const done = await change((draft) => {
        const one = draft.proposals.find((each) => each.id === id)!;
        one.status = run ? 'run' : 'declined';
        one.answered = deps.now();
        return { ...one };
      });
      await deps.changed().catch(() => {});
      return done;
    },
  };
}
export type Watch = ReturnType<typeof createWatch>;
