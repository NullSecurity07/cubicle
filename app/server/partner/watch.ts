import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Lead } from '../../shared/leads.ts';
import { STAGE_NAMES } from '../../shared/leads.ts';
import { formatValue, isDay, type Metric, type MetricPoint, type Metrics } from '../../shared/metrics.ts';
import type { Attention, Stage } from '../../shared/model.ts';
import { bare, type Bet } from '../../shared/partner.ts';
import { localDay, now as clockNow } from '../clock.ts';
import { writeAtomic } from '../fsx.ts';
import type { ModelMessage } from '../prompt.ts';
import type { Unasked } from '../usage.ts';
import { plusDays, thresholdOf } from './call.ts';
import type { FounderPromise } from './promises.ts';
import { breakEvenFix, breakEvenLine, sameMetric, type EconomicsState } from './economics.ts';
import { saidNoFor, type Proposal as SaidNoProposal } from './saidno.ts';
import { filledIn, guardUnasked, leftOutLine } from './unasked.ts';

// The partner watch (gap audit 2026-10-06, A. Initiative). The partner wrote one morning note a day and nothing else
// woke them: a number sliding toward the kill line, a lead who replied, a competitor's page that changed and a promise
// gone stale were rows the founder had to read and act on alone. Now each of the four wakes the partner for one turn
// of their own, and the turn ends in something ready to run — an email draft, a dated task, a decision, or "drop it?"
// — waiting in Needs you with Run and Don't. Unasked turns are few (a daily budget), one open row per trigger, and
// never on the partner-only model: those turns are kept for what the founder asks.

const DAY = 86_400_000;

// ---------------------------------------------------------------- the daily budget for unasked turns

// What the budget answers: whether this turn may be taken, and in words why not. `release`: the turn found nothing to
// say, so it does not count.
export type Taken = { ok: boolean; why?: string; left?: number; release?: () => void };
// Anything with `take` fits; the slice hands in `watchBudget` over the shared unasked budget (usage.ts).
export type Budget = { take(reason: string): Taken | Promise<Taken> };
export const UNASKED_A_DAY = 3;
export const budgetUsed = (used: number, cap: number) => `budget used today: ${used} of ${cap} unasked turns`;
export const WATCH_REASON = 'watch: ';

// The watch's turns come out of the day's shared budget for unasked work (twelve, kept in `unasked.json`, never on a
// partner-only model), and the watch takes at most three of them: both limits hold. The three are counted from the
// shared book's own reasons, so a restart does not hand them back and a released turn is free again.
export function watchBudget(unasked: Pick<Unasked, 'take' | 'used'>, cap = UNASKED_A_DAY): Budget & { used(): number } {
  const used = () => unasked.used().filter((one) => one.reason.startsWith(WATCH_REASON)).length;
  return {
    used,
    take(reason: string): Taken {
      const mine = used();
      if (mine >= cap) return { ok: false, left: 0, why: budgetUsed(mine, cap) };
      const taken = unasked.take(`${WATCH_REASON}${reason}`);
      if (!taken.ok) return { ok: false, left: 0, why: taken.why };
      return { ok: true, left: Math.min(taken.left, cap - mine - 1), release: taken.release };
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

// Journey 15: kill signal "fewer than 10 print jobs done", readings 7 then 9, and Needs you said the number was
// "trending to the kill line" with a cold-outreach task. 7 to 9 is progress: towardLine measured the share of the way
// to the line without asking which side of it loses. A kill line has a losing side: under it for "below / fewer than"
// (a number the company wants up), over it for "above / more than". Only a move toward the losing side counts: from
// the safe side, half-way to the line or past it; from the losing side already (the company has yet to reach it), any
// move further away. `away`: on the losing side and moving further from the line.
export type KillToward = Toward & { away?: boolean };
export function killToward(start: number, latest: number, line: number, below: boolean): KillToward | null {
  const worse = below ? latest < start : latest > start;
  if (!worse) return null;
  const losing = below ? start < line : start > line;
  if (losing) return { start, latest, line, share: 1, crossed: false, away: true };
  return towardLine(start, latest, line);
}
// Which side of a kill signal's line loses: "fewer than 10", "below 5" and a bare count to reach lose under it.
export const losesBelow = (what: string) => thresholdOf(what)?.below ?? !/\b(?:above|over|more than|greater than|higher than|exceeds?)\b|>/i.test(what);

// The reading a line is measured from and the latest one. Null while no newer reading has come in since: nothing has
// moved yet. `since` a day (a bet's): measured from the last reading on or before it, else the first one after. `since`
// a moment (a kill line's): a reading is one day's, with no hour, so one dated the day the line was set may have come
// after it; the line is measured from the last reading of an earlier day. Journey 17: the kill line was replaced on
// 7 Oct and 9.5 logged for 7 Oct (from 11 on 6 Oct); measured from 7 Oct's own reading, the watch saw no move.
export function readingsSince(points: MetricPoint[], since: string | number): { start: MetricPoint; latest: MetricPoint } | null {
  const sorted = [...points].sort((a, b) => a.at.localeCompare(b.at));
  if (sorted.length < 2) return null;
  const before = typeof since === 'number' ? sorted.filter((point) => point.at < localDay(since)) : sorted.filter((point) => point.at <= since);
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
// `said`: the lead's own words when they wrote back, which the reply answers.
export type Output = { kind: 'email'; to: string; name: string; said?: string } | { kind: 'task' } | { kind: 'task-or-decision' } | { kind: 'task-or-drop'; promiseId: string; what: string };
// One trigger. `key` is the event, never raised twice; `trigger` is what it is about, which has one open row at most
// (a lead that replies again while the last reply's row waits is not a second row). `money` orders the day when the
// budget cannot cover all of them (a number going to the kill line first). `number` is the figure, read in code.
// `kill`: the kill-signal trend's own numbers, for holding it to the one state (economics.ts).
export type Spark = { key: string; trigger: string; kind: 'metric' | 'lead' | 'page' | 'promise'; at: number; money: number; why: string; facts: string; number?: string; out: Output; roomId?: string; cardId?: string; leadId?: string; kill?: { label: string; start: number; latest: number; line: number; below: boolean } };

export type MetricsCard = { cardId: string; metrics: Metric[] };

// (a) and the kill-signal trend: the open kill signal of the partner's last verdict, read against the Metrics row it
// names from the day it was set; and every open bet's own number read from the day it was taken toward its target.
export function metricSparks(cards: MetricsCard[], kill: FounderPromise | undefined, bets: Bet[], at: number): Spark[] {
  const found: Spark[] = [];
  const all = cards.flatMap((card) => card.metrics.map((metric) => ({ card, metric })));
  if (kill && kill.status === 'open') {
    const lineOf = killLineOf(kill.what, all.map((one) => one.metric));
    const card = lineOf && all.find((one) => one.metric === lineOf.metric)!.card;
    const read = lineOf && readingsSince(lineOf.metric.points, kill.at > 0 ? kill.at : kill.said);
    const toward = read && killToward(read.start.value, read.latest.value, lineOf!.line, losesBelow(kill.what));
    if (lineOf && read && trending(toward)) {
      const { metric } = lineOf;
      const said = (value: number) => formatValue(value, metric.unit);
      const number = `${metric.label}: ${said(read.latest.value)} on ${read.latest.at}, from ${said(read.start.value)} on ${read.start.at}; the kill line is ${said(lineOf.line)} (${kill.what}, checked on ${kill.due}).`;
      found.push({
        key: `kill:${kill.id}:${metric.key}`, trigger: `kill:${metric.key}`, kind: 'metric', at, money: 100, cardId: card!.cardId, number,
        why: toward.crossed ? `${metric.label} crossed the kill line` : toward.away ? `${metric.label} is moving away from the kill line it has to clear` : `${metric.label} is trending to the kill line`,
        facts: `${toward.crossed ? 'The number has crossed the kill line' : toward.away ? 'The number has not cleared the kill line yet and moved the wrong way since your verdict' : `The number is trending to the kill line: ${Math.round(toward.share * 100)}% of the way from where it stood at your verdict`}.\n${number}\n${kill.due >= localDay(at) ? `The verdict's check is on ${kill.due}.` : `The verdict's check day, ${kill.due}, has passed.`}`,
        out: { kind: 'task-or-decision' },
        kill: { label: metric.label, start: read.start.value, latest: read.latest.value, line: lineOf.line, below: losesBelow(kill.what) },
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
    // Their own words, as the thread has them: journey 15's draft to a lead who asked how pickup works and whether one
    // trial job was possible proposed a call instead, because the turn never saw what she wrote.
    const said = lead.thread?.filter((one) => one.kind === 'replied' && one.text?.trim()).at(-1)?.text?.replace(/\s+/g, ' ').trim().slice(0, 1200);
    return {
      key: `lead:${lead.id}:replied:${lead.updatedAt}`, trigger: `lead:${lead.id}`, kind: 'lead' as const, at, money: 80, cardId: lead.cardId, leadId: lead.id,
      why: `${lead.person.name} moved to ${STAGE_NAMES.replied}`,
      number: `${lead.person.name} (${lead.company.name}) moved from ${STAGE_NAMES[(seen[lead.id] ?? 'new') as Lead['stage']] ?? 'New'} to ${STAGE_NAMES.replied}.`,
      facts: `A lead replied: ${who}.${lead.person.email ? ` Address on record: ${lead.person.email}.` : ' No email address is on record for them.'}${said ? `\nWhat ${lead.person.name} wrote, word for word:\n"${said}"` : ''}${notes ? `\nNotes on the lead:\n${notes}` : ''}`,
      out: lead.person.email ? { kind: 'email' as const, to: lead.person.email, name: lead.person.name, ...(said ? { said } : {}) } : { kind: 'task' as const },
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
  move: string; why: string; number?: string; read?: string; draft: Draft; cardId?: string; leadId?: string;
  status: 'open' | 'run' | 'declined'; answered?: number; provider?: string; model?: string;
  // The founder said no to this before: their own words, put first on the Needs you row.
  saidNo?: string;
  // What the partner wrote that nothing on record backs, taken out (server/partner/unasked.ts).
  left?: string[];
};

// What the partner is asked, after their own system prompt: the facts in code's words, then the lines to answer in.
export function watchAsk(spark: Spark, today: string): string {
  const due = `Due: YYYY-MM-DD, a day from ${today} to ${plusDays(today, 7)}`;
  const task = `Task: the task for the founder, in a few words\n${due}`;
  const out = spark.out.kind === 'email'
    ? `Subject: the email's subject\nBody: the reply to ${spark.out.name}, plain text, under 120 words, signed by the founder. ${spark.out.said
      ? `It answers what ${spark.out.name.split(' ')[0]} wrote above, each question they asked in turn and in their own words; it proposes a call only if they asked for one.`
      : 'It thanks them and proposes one concrete next step.'} It is an email to them: no "My call", "Why", "Kill signal" or "This week" lines, nothing of your verdict or your notes. Every line after "Body:" is the email.`
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
    const fallback = spark.out.said ? `Hi ${spark.out.name.split(' ')[0]},\n\nThanks for your reply.\n\nBest,` : `Hi ${spark.out.name.split(' ')[0]},\n\nThanks for your reply. Would a 20-minute call this week work for you?\n\nBest,`;
    draft = { kind: 'email', to: spark.out.to, subject: tidy(line(reply, 'Subject'), 140) || 'Thanks for getting back to me', body: emailBody(body).slice(0, 2000) || fallback };
  } else if (spark.out.kind === 'task-or-drop' && line(reply, 'Drop') && !line(reply, 'Task')) {
    draft = { kind: 'drop', promiseId: spark.out.promiseId, what: spark.out.what };
  } else if (spark.out.kind === 'task-or-decision' && line(reply, 'Decision') && !line(reply, 'Task')) {
    draft = { kind: 'decision', title: tidy(line(reply, 'Decision'), 160) };
  } else draft = { kind: 'task', title: taskTitle, due };
  return { move, ...(read ? { read } : {}), draft };
}

// The partner's verdict shape never goes to a customer: journey 15's email to a lead ended "My call: Send the reply
// to Mira today ...". A line labelled as the verdict's, or as the watch's own Move, Task or Due, is not the email's.
const NOT_EMAIL = /^\s*(?:\*\*)?(?:my call|the call|verdict|why|kill signal|this week|move|task|due|decision|drop|read)(?:\*\*)?\s*:/i;
export const emailBody = (body: string) => body.split('\n').filter((one) => !NOT_EMAIL.test(one)).join('\n').replace(/\n{3,}/g, '\n\n').trim();

const fallbackMove = (spark: Spark) => spark.kind === 'metric' ? 'Find out this week what is moving the number, before the check day.'
  : spark.kind === 'lead' ? 'Reply today and propose a short call.'
  : spark.kind === 'promise' ? 'Put it on a day this week, or let it go.'
  : 'Look at what changed and decide whether it changes our plan.';

// "Can you deliver on Thursday?" → "Yes, we can deliver on Thursday."; "Are the meals nut-free?" → "Yes, the meals are nut-free."
const yesTo = (said: string) => said.split(/(?<=[.!?])\s+/).filter((one) => one.trim().endsWith('?')).map((question) => {
  const plain = question.trim().replace(/^(?:and|also|so)\s+/i, '').replace(/\?$/, '');
  const can = /^(?:can|could|will|would) you (.+)$/i.exec(plain);
  if (can) return `Yes, we can ${can[1]}.`;
  const be = /^(are|is) (the [\p{L}\s]+?|they|it) ([\p{L}-]+)$/iu.exec(plain);
  return be ? `Yes, ${be[2]} ${be[1].toLowerCase()} ${be[3]}.` : '';
}).filter(Boolean).join(' ') || 'Thanks for your questions.';

// What a fake run's partner says, so a browser check sees the whole road without a key.
export function fakeWatchReply(messages: ModelMessage[]): string {
  const asked = messages.at(-1)?.content ?? '';
  const move = /kill line/.test(asked) ? 'Call five lapsed signups this week and ask what stopped them.' : /A lead replied/.test(asked) ? 'Reply today and offer a 20-minute call.'
    : /promise/.test(asked) ? 'Put it on Thursday, or drop it.' : 'Check whether their change undercuts our price.';
  const lines = [`Move: ${move}`];
  if (/^Read:/m.test(asked)) lines.unshift('Read: The page changed its offer; it matters if it now competes with our price.');
  // A lead's own questions are answered yes, as a careless model would: the guard then shows what it takes out.
  const said = /word for word:\n"([^"]*)"/.exec(asked)?.[1];
  if (/^Subject:/m.test(asked)) lines.push('Subject: Thanks for your reply', `Body: Hi,\n\nThanks for getting back to me. ${said ? yesTo(said) : 'Would a 20-minute call on Thursday work?'}\n\nBest,`);
  else lines.push(`Task: ${move.replace(/[.]$/, '')}`);
  return lines.join('\n');
}

// The proposal held to the record: a sentence of the move, the read or the ready thing that promises, counts or quotes
// what no source gives is taken out, and the row says what was left out. The sources are the brief and the facts the
// turn was given, the lead's own words among them. A part left empty falls back to the plain one.
export function guardProposal(spark: Spark, shaped: Pick<Proposal, 'move' | 'read' | 'draft'>, sources: string[]): Pick<Proposal, 'move' | 'read' | 'draft' | 'left'> {
  const read = [...sources, spark.facts, spark.number ?? ''].filter(Boolean);
  const left: string[] = [];
  const hold = (text: string) => { const held = guardUnasked(text, read); left.push(...held.left); return held.text; };
  const move = hold(shaped.move) || fallbackMove(spark);
  const seen = shaped.read ? hold(shaped.read) : '';
  let draft = shaped.draft;
  if (draft.kind === 'email') {
    const name = spark.out.kind === 'email' ? spark.out.name.split(' ')[0] : '';
    draft = { ...draft, subject: hold(draft.subject) || 'Thanks for getting back to me', body: filledIn(hold(draft.body), sources.join('\n')) || `Hi ${name},\n\nThanks for your reply.\n\nBest,` };
  } else if (draft.kind === 'task') draft = { ...draft, title: hold(draft.title) || move.replace(/[.]+$/, '').slice(0, 140) };
  else if (draft.kind === 'decision') draft = { ...draft, title: hold(draft.title) || move.replace(/[.]+$/, '').slice(0, 160) };
  return { move, ...(seen ? { read: seen } : {}), draft, ...(left.length ? { left: [...new Set(left)] } : {}) };
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
  id: `partner-proposal:${one.id}`, kind: 'partner-proposal', at: one.at, who: one.who, roomId: one.roomId, ...(one.cardId ? { cardId: one.cardId } : {}), ...(one.leadId ? { leadId: one.leadId } : {}),
  title: `${one.who} proposes: ${one.move}`,
  detail: [one.saidNo, `Unasked · ${one.why}.`, one.number, one.read, leftOutLine(one.left ?? []), draftLine(one.draft)].filter(Boolean).join('\n'),
});

// One row per lead reply. Journey 16: Needs you showed "Anna replied. Draft an answer?" and Sam's ready answer to the
// same reply as two rows. While the partner's answer waits, the plain ask for that lead is settled by it; Don't on the
// answer brings the ask back.
export function leadTwins(rows: Attention[]): Set<string> {
  const answered = new Set(rows.filter((row) => row.kind === 'partner-proposal' && row.cardId && row.leadId).map((row) => `${row.cardId}:${row.leadId}`));
  return new Set(rows.filter((row) => row.kind === 'lead-replied' && answered.has(row.id.split(':').slice(1, 3).join(':'))).map((row) => row.id));
}

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
  workspace: string; now?: () => number; budget: Budget; busy: Set<string>;
  stage(): Promise<Stage>;
  attention(): Promise<Attention[]>;
  promises(): Promise<FounderPromise[]>;
  bets(): Promise<Bet[]>;
  leads(cardId: string): Promise<Lead[]>;
  promptFor(stage: Stage, roomId: string): Promise<ModelMessage[]>;
  // What an unasked output may rest on besides the turn's facts: the Company brief's text.
  sources?(stage: Stage): Promise<string[]>;
  // The partner's unasked turn: routed with `reserved: false`, so never on the partner-only model.
  ask(messages: ModelMessage[]): Promise<{ text: string; provider?: string; model?: string }>;
  acts: Acts;
  changed(): Promise<void>;
  notify?(title: string, body: string): void;
  // Given the proposal before it is raised, the proposal (with the founder's earlier no quoted) or null to hold it back.
  // By default the founder's said-no log decides (`vetBySaidNo`).
  vet?(proposal: Proposal): Promise<Proposal | null>;
  // The one picture of the numbers (economics.ts): where the count stands against break-even is said from it, never by
  // the model, and a kill trend is raised only when it agrees.
  economics?(): Promise<EconomicsState | null>;
};

// Journey 16: "Paying subscribers dropped from 11 to 9.5, moving us further below break-even" with break-even at 8. A
// kill trend on the paying count is raised only when the one state agrees (the count it holds now is the one read, or
// is moving toward the line too), and its facts carry the break-even side worked from the numbers.
export function heldToState(spark: Spark, state: EconomicsState | null | undefined): Spark | null {
  if (!spark.kill || !state) return spark;
  const paying = state.inputs.paying;
  const same = !!paying && sameMetric(paying.label, spark.kill.label);
  if (same && Math.abs(paying!.value - spark.kill.latest) > 1e-9 && !killToward(spark.kill.start, paying!.value, spark.kill.line, spark.kill.below)) return null;
  const side = same ? breakEvenLine(state, spark.kill.latest) : undefined;
  return side ? { ...spark, facts: `${spark.facts}\n${side}` } : spark;
}

// A watch proposal in the words the said-no log keeps: an email is about its lead, a task or a decision is its title,
// letting a promise go is about that promise.
export function saidNoProposal(one: Pick<Proposal, 'draft' | 'move'>): SaidNoProposal {
  const { draft } = one;
  if (draft.kind === 'email') return { tool: 'draft_email', subject: draft.subject, to: draft.to.toLowerCase(), key: `lead:${draft.to.toLowerCase()}` };
  if (draft.kind === 'task') return { tool: 'propose_task', subject: draft.title };
  if (draft.kind === 'decision') return { tool: 'propose_decision', subject: draft.title };
  return { tool: 'drop_promise', subject: `Let go: ${draft.what}`, key: `promise:${draft.promiseId}` };
}

// The founder's no stands: a first match goes up once more with their words quoted, a second is not raised at all.
export function vetBySaidNo(workspace: string, now: () => number = clockNow) {
  return async (proposal: Proposal): Promise<Proposal | null> => {
    const book = saidNoFor(workspace, now);
    const checked = await book.check(saidNoProposal(proposal)).catch(() => ({ verdict: 'fresh' as const }));
    if (checked.verdict === 'fresh') return proposal;
    if (checked.verdict === 'declined') { console.log(`partner watch: not raised. ${checked.line.trim()}`); return null; }
    await book.asked(checked.entry.id).catch(() => {});
    return { ...proposal, saidNo: checked.line };
  };
}
const MOST_FIRED = 400;
const MOST_KEPT = 60;
const readJson = async <T>(path: string, fallback: T): Promise<T> => { try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return fallback; } };

export function createWatch(given: WatchDeps) {
  const deps = { ...given, now: given.now ?? clockNow };
  const vet = given.vet ?? vetBySaidNo(deps.workspace, deps.now);
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
      const numbers = await deps.economics?.().catch(() => null) ?? null;
      const sparks = [...metricSparks(cards, kill, bets, at).flatMap((one) => heldToState(one, numbers) ?? []), ...leadSparks(leads, state.seenLeads, at), ...promiseSparks(promises, at), ...pageSparks(rows, at)]
        .sort((a, b) => b.money - a.money);
      const open = new Set(state.proposals.filter((one) => one.status === 'open').map((one) => one.trigger ?? one.key));
      const fired = new Set(state.fired);
      const made: Proposal[] = [];
      const waiting: WatchState['waiting'] = [];
      const held = new Set<string>();
      for (const spark of sparks) {
        if (open.has(spark.trigger) || fired.has(spark.key)) continue;
        const taken = await deps.budget.take(spark.trigger);
        if (!taken.ok) { waiting.push({ key: spark.key, what: spark.why, why: taken.why ?? 'no unasked turns left today', at }); held.add(spark.key); continue; }
        const messages: ModelMessage[] = [...await deps.promptFor(stage, partner.id), { role: 'user', content: watchAsk(spark, today) }];
        const reply = await deps.ask(messages).catch((error: Error) => { console.error(`partner watch: ${error.message}`); return null; });
        // No answer: the turn said nothing, so it goes back to the day's budget.
        if (!reply?.text.trim()) taken.release?.();
        const raw = proposalOf(spark, reply?.text ?? '', today);
        const fixed = { ...raw, move: breakEvenFix(raw.move, numbers), draft: raw.draft.kind === 'task' || raw.draft.kind === 'decision' ? { ...raw.draft, title: breakEvenFix(raw.draft.title, numbers) } : raw.draft };
        const shaped = guardProposal(spark, fixed, await deps.sources?.(stage).catch(() => []) ?? []);
        let proposal: Proposal | null = {
          id: `${spark.kind}-${at.toString(36)}-${made.length}`, key: spark.key, trigger: spark.trigger, at, who: partner.name, roomId: partner.id, sparkKind: spark.kind,
          why: spark.why, ...(spark.number ? { number: spark.number } : {}), ...(spark.cardId ? { cardId: spark.cardId } : {}), ...(spark.leadId ? { leadId: spark.leadId } : {}), ...shaped, status: 'open',
          ...(reply?.provider ? { provider: reply.provider } : {}), ...(reply?.model ? { model: reply.model } : {}),
        };
        proposal = await vet(proposal);
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
      // Don't is the founder's no: kept, so the same move is not put to them again unasked.
      if (!run) await saidNoFor(deps.workspace, deps.now).record({ ...saidNoProposal(proposal), who: proposal.who }).catch(() => {});
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
