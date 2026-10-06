import type { TurnResult } from '../loop.ts';

// Journey 11: asked "keep going, pivot, or stop?", the partner said "keep going" with reasons from the brief, and named
// nothing that would change its mind or when to look. A co-founder's verdict commits: the call, the strongest reason
// on record, the one number that would change it with the day to check it, and the first move this week. The shape
// is asked for in the prompt and read back in code; a verdict missing a part is asked once for only that part, and a
// kill signal still not named is said so in words, never filled in by the app.

export type Decision = 'keep going' | 'change course' | 'stop';
// The one measurable thing that would change the call: what it is with its threshold, the day to look, and anything
// said after the day ("; if not, change course").
export type KillSignal = { what: string; by: string; then?: string };
export type PartnerCall = { decision?: Decision; why?: string; signal?: KillSignal; move?: string };
export type CallField = 'call' | 'why' | 'kill signal' | 'date' | 'this week';
export type ReadCall = PartnerCall & { missing: CallField[]; unsourced: string[]; rest: string };

// A day of two to six weeks from today: soon enough to matter, long enough for the number to move.
export const SOONEST = 14;
export const LATEST = 42;
const DAY = 86_400_000;
export const plusDays = (day: string, days: number) => {
  const at = new Date(`${day}T12:00`);
  at.setDate(at.getDate() + days);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
};
const between = (from: string, to: string) => Math.round((new Date(`${to}T12:00`).getTime() - new Date(`${from}T12:00`).getTime()) / DAY);

// The founder asks for the verdict on the company, not on one task: "your verdict", "keep going or stop?",
// "should we kill it?", "go or no-go".
export const asksVerdict = (said: string) => /\bverdict\b|\bkeep going\b[^.!\n]*\b(?:pivot|stop|quit|kill|change course)\b|\bshould (?:i|we) (?:keep going|continue|stop|quit|kill|shut|give up|pivot)\b|\bkill (?:it|this|the (?:idea|company|project|product))\b|\bgo or no[- ]go\b/i.test(said);

export const callShape = (today: string) => `The founder asks for your verdict on the company. Start your answer with these four lines, each on its own line with its label, then at most a few short lines more:\n`
  + 'My call: keep going, change course or stop (one of the three).\n'
  + 'Why: the strongest reason, using only numbers from the Company document, the chat or what you read this turn. Never a number you worked out or guessed.\n'
  + `Kill signal: one number the founder can measure and the threshold that would change your call, then "by YYYY-MM-DD", a day from ${plusDays(today, SOONEST)} to ${plusDays(today, LATEST)} (today is ${today}).\n`
  + 'This week: the first move, one thing the founder does this week.';

const LABELS: { field: 'call' | 'why' | 'kill' | 'week'; label: RegExp }[] = [
  { field: 'call', label: /^(?:my call|verdict|decision|the call)\s*:\s*/i },
  { field: 'why', label: /^(?:why|reason|the reason|strongest reason|because)\s*:\s*/i },
  { field: 'kill', label: /^(?:kill signal|kill criterion|kill metric|kill switch|kill line|tripwire)\s*:\s*/i },
  { field: 'week', label: /^(?:this week|first move(?: this week)?|next move|first step)\s*:\s*/i },
];
// A line as the label sees it: no bullet, no bold or italics, no heading marks.
const plain = (line: string) => line.replace(/^\s*(?:[-*+]|\d+[.)]|#+)\s+/, '').replace(/[*_`]/g, '').trim();
const tidy = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/^[\s:,-]+/, '');

const DECISIONS: [Decision, RegExp][] = [
  ['keep going', /\bkeep (?:going|building|at it)\b|\bcontinue\b|\bpress on\b|\bstay the course\b|^\W*keep\b/i],
  ['change course', /\bchange (?:course|direction)\b|\bpivot\w*\b|\bchange tack\b/i],
  ['stop', /\bstop\b|\bkill\b|\bshut (?:it )?down\b|\bwind (?:it )?down\b|\bquit\b|\bgive up\b/i],
];
export function decisionOf(text: string): Decision | undefined {
  let best: { decision: Decision; at: number } | undefined;
  for (const [decision, pattern] of DECISIONS) {
    const found = pattern.exec(text);
    if (found && (!best || found.index < best.at)) best = { decision, at: found.index };
  }
  return best?.decision;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = `(${MONTHS.join('|')})[a-z]*\\.?`;
// A day written out in full: "2026-11-03", "3 November 2026", "November 3, 2026".
const DATED = new RegExp(`\\b(20\\d\\d)-(\\d\\d)-(\\d\\d)\\b|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\s+(20\\d\\d)\\b|\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d\\d)\\b`, 'i');
const pad = (n: number) => String(n).padStart(2, '0');
function dayIn(text: string): { day: string; at: number; end: number } | null {
  const found = DATED.exec(text);
  if (!found) return null;
  const [year, month, date] = found[1] ? [Number(found[1]), Number(found[2]), Number(found[3])]
    : found[4] ? [Number(found[6]), MONTHS.indexOf(found[5].toLowerCase().slice(0, 3)) + 1, Number(found[4])]
      : [Number(found[9]), MONTHS.indexOf(found[7].toLowerCase().slice(0, 3)) + 1, Number(found[8])];
  const check = new Date(year, month - 1, date, 12);
  if (check.getMonth() !== month - 1 || check.getDate() !== date) return null;
  return { day: `${year}-${pad(month)}-${pad(date)}`, at: found.index, end: found.index + found[0].length };
}

// A kill signal as said: the thing and its threshold before the day, and whatever follows the day. Without a number
// besides the day it measures nothing; without a day of two to six weeks ahead it has no date.
export function killOf(text: string, today: string): { signal?: KillSignal; missing: CallField[] } {
  const day = dayIn(text);
  const what = tidy((day ? text.slice(0, day.at) : text).replace(/\b(?:by|on|before|until|at)\s*(?:the\s+)?$/i, '')).replace(/[\s,;:.(-]+$/, '');
  const then = day ? tidy(text.slice(day.end)).replace(/^[).,;\s]+/, '').replace(/[\s.]+$/, '') : '';
  const missing: CallField[] = [];
  if (!/\d/.test(what)) missing.push('kill signal');
  const ahead = day ? between(today, day.day) : -1;
  if (!day || ahead < SOONEST || ahead > LATEST) missing.push('date');
  if (missing.length) return { missing };
  return { signal: { what, by: day!.day, ...(then ? { then } : {}) }, missing };
}

// Numbers of the reason that nothing on record gives: "17%" worked out from 2 of 12, a market size from nowhere.
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const flat = (text: string) => text.replace(/(?<=\d),(?=\d{3}\b)/g, '');
export function unsourcedIn(text: string, evidence: string): string[] {
  const held = flat(evidence);
  const out: string[] = [];
  for (const found of flat(text).matchAll(NUMBER)) {
    const number = found[0].replace(/[,.]+$/, '');
    if (!new RegExp(`(?<![\\d.])${number.replace(/\./g, '\\.')}(?![\\d]|\\.\\d)`).test(held) && !out.includes(number)) out.push(number);
  }
  return out;
}

// The verdict in a reply: each labelled line read, what is missing named, and the reply's other lines kept as they are.
export function readCall(text: string, today: string, evidence: string): ReadCall {
  const said: Partial<Record<'call' | 'why' | 'kill' | 'week', string>> = {};
  const rest: string[] = [];
  for (const line of text.split('\n')) {
    const bare = plain(line);
    const hit = LABELS.find((one) => one.label.test(bare));
    if (hit && !said[hit.field]) said[hit.field] = tidy(bare.replace(hit.label, ''));
    else if (!hit) rest.push(line);
  }
  const missing: CallField[] = [];
  const decision = said.call ? decisionOf(said.call) : undefined;
  if (!decision) missing.push('call');
  const why = said.why || undefined;
  const unsourced = why ? unsourcedIn(why, evidence) : [];
  if (!why || unsourced.length) missing.push('why');
  const kill = said.kill ? killOf(said.kill, today) : { missing: ['kill signal', 'date'] as CallField[] };
  missing.push(...kill.missing);
  const move = said.week || undefined;
  if (!move) missing.push('this week');
  return { decision, why, signal: kill.signal, move, missing, unsourced, rest: rest.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

// The second look asks only for what is missing, each line with its rule.
export function callNudge(read: Pick<ReadCall, 'missing' | 'unsourced'>, today: string): string {
  const lines: string[] = [];
  if (read.missing.includes('call')) lines.push('My call: keep going, change course or stop (one of the three).');
  if (read.missing.includes('why')) lines.push(`Why: the strongest reason, with only numbers the Company document, the chat or what you read gives${read.unsourced.length ? ` (nothing on record gives ${read.unsourced.join(', ')})` : ''}.`);
  if (read.missing.includes('kill signal') || read.missing.includes('date')) lines.push(`Kill signal: one number the founder can measure and the threshold that would change your call, then "by YYYY-MM-DD", a day from ${plusDays(today, SOONEST)} to ${plusDays(today, LATEST)} (today is ${today}).`);
  if (read.missing.includes('this week')) lines.push('This week: the first move, one thing the founder does this week.');
  const names = read.missing.filter((one, index, all) => all.indexOf(one) === index && !(one === 'date' && all.includes('kill signal')));
  return `Take another look before this goes to the founder: your verdict is missing ${names.join(', ')}. Answer with only these lines, nothing else:\n${lines.join('\n')}`;
}

export const NO_SIGNAL = 'no kill signal named yet';
const sentence = (text: string) => text.replace(/[\s.]+$/, '') + '.';
// The verdict as the founder reads it: the four lines first, then whatever else the partner said.
export function renderCall(call: PartnerCall, rest = ''): string {
  const lines = [
    ...(call.decision ? [`My call: **${call.decision}**.`] : []),
    ...(call.why ? [`Why: ${sentence(call.why)}`] : []),
    call.signal ? `Kill signal: ${call.signal.what} by ${call.signal.by}${call.signal.then ? `; ${call.signal.then.replace(/[\s.]+$/, '')}` : ''}.` : `Kill signal: ${NO_SIGNAL}.`,
    ...(call.move ? [`This week: ${sentence(call.move)}`] : []),
  ];
  return [lines.join('\n'), rest.trim()].filter(Boolean).join('\n\n');
}

// What a Needs you row asks on the signal's day.
export const checkTitle = (signal: KillSignal) => `Check: ${signal.what} by ${signal.by}?`;

// The partner's reply to a verdict ask, held to the shape. `again` answers once more in words only; a part the second
// answer gives fills the first's gap, and a kill signal named by neither is said to be missing.
export async function holdCall(asked: string, first: TurnResult, again: ((first: TurnResult, nudge: string) => Promise<TurnResult>) | undefined, today: string, evidence: string): Promise<{ reply: TurnResult; call: PartnerCall | null; askedAgain: boolean }> {
  if (first.stopped || !asksVerdict(asked)) return { reply: first, call: null, askedAgain: false };
  const read = readCall(first.text, today, evidence);
  let call: PartnerCall = { decision: read.decision, why: read.why, signal: read.signal, move: read.move };
  let reply = first;
  const askedAgain = !!read.missing.length && !!again;
  if (askedAgain) {
    const second = await again!(first, callNudge(read, today));
    if (!second.stopped) {
      const more = readCall(second.text, today, evidence);
      call = {
        decision: call.decision ?? more.decision,
        // A reason with a number nothing gives is put right by a second one that is sourced; else the first stands.
        why: !read.why || (read.unsourced.length && more.why && !more.unsourced.length) ? more.why ?? call.why : call.why,
        signal: call.signal ?? more.signal,
        move: call.move ?? more.move,
      };
    }
    reply = { ...second, tools: [...first.tools, ...second.tools], usage: { input: first.usage.input + second.usage.input, output: first.usage.output + second.usage.output } };
  }
  return { reply: { ...reply, text: renderCall(call, read.rest) }, call, askedAgain };
}
