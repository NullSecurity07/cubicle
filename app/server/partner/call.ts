import { markClaims } from '../tools/evidence.ts';
import type { TurnResult } from '../loop.ts';
import { briefRow } from './bets.ts';
import { saysGap, wideGap, type Economics } from './economics.ts';

// Journey 11: asked "keep going, pivot, or stop?", the partner said "keep going" with reasons from the brief, and named
// nothing that would change its mind or when to look. A co-founder's verdict commits: the call, the strongest reason
// on record, the one number that would change it with the day to check it, and the first move this week. The shape
// is asked for in the prompt and read back in code; a verdict missing a part is asked once for only that part, and a
// kill signal still not named is said so in words, never filled in by the app.

export type Decision = 'keep going' | 'change course' | 'stop';
// The one measurable thing that would change the call: what it is with its threshold, the day to look, and anything
// said after the day ("; if not, change course").
export type KillSignal = { what: string; by: string; then?: string };
// `working`: the brief's numbers worked out with calc before the call, shown under the reason. `gap`: said when the
// call is "keep going" far below break-even and nothing says how the gap closes.
export type PartnerCall = { decision?: Decision; why?: string; signal?: KillSignal; move?: string; working?: string[]; gap?: string };
export type CallField = 'call' | 'why' | 'kill signal' | 'date' | 'this week' | 'how the gap closes';
// `dead`: why the kill signal said cannot do its job (it cannot fire from where the company stands, or cannot be met).
export type ReadCall = PartnerCall & { missing: CallField[]; unsourced: string[]; rest: string; closes?: string; dead?: string };

// A day of one to six weeks from today: soon enough to matter, long enough for the number to move. Journey 15: the
// founder's goal was 13 days out and a floor of 14 refused the kill signal on the goal's own day twice, then took one
// two days past it. The founder's dated goal is always a day the signal may name (goalDays).
export const SOONEST = 7;
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

// Journey 14: "I don't buy it. Your kill signal ... can only fire if I lose one. Give me a sharper call and a kill
// signal that can actually fail." The partner gave a new kill signal in loose prose; nothing read it, and the check
// stayed on the old one. The founder challenging the call or its kill signal is a verdict ask too.
const CHALLENGE = /\b(?:(?:i\s+)?don'?t buy|disagree|not convinced|unconvinced|push(?:ing)? back|sharper|tighter|(?:can(?:not|'t)|could(?:n'?t| not)|never) (?:actually |really )?(?:fail|fire)|that'?s (?:just )?hope|rethink|reconsider|(?:is|seems|looks) (?:wrong|weak|soft|too easy)|too (?:soft|easy|weak))\b/i;
const CALL_WORDS = /\bkill (?:signal|criterion|metric|switch|line)\b|\byour (?:call|verdict)\b|\bthe (?:call|verdict)\b|\bkeep going\b|\btripwire\b/i;
export const pushesBack = (said: string) => CHALLENGE.test(said) && CALL_WORDS.test(said);
export const PUSHBACK_LINE = 'The founder is pushing back on your verdict. Answer their point in a line or two, then give the four lines again: keep the call or change it, and a kill signal that can fail from where the company stands today.';

// The founder's dated goals, as the brief has them (server/partner/goal.ts): `what` is the count ("10 print jobs done").
export type GoalDay = { what: string; by: string };
const window = (today: string, goals: GoalDay[]) => {
  const ahead = goals.filter((goal) => between(today, goal.by) > 0).map((goal) => goal.by);
  return `a day from ${plusDays(today, SOONEST)} to ${plusDays(today, LATEST)}${ahead.length ? `, or the founder's goal day ${[...new Set(ahead)].join(' or ')}` : ''} (today is ${today})`;
};

export const callShape = (today: string, worked = false, goals: GoalDay[] = []) => `The founder asks for your verdict on the company. Start your answer with these four lines, each on its own line with its label, then at most a few short lines more:\n`
  + 'My call: keep going, change course or stop (one of the three).\n'
  + `Why: the strongest reason, using only numbers from the Company document, the chat or what you read this turn${worked ? ', and the break-even and runway working given you below' : ''}. Never a number you worked out or guessed.\n`
  + `Kill signal: one number the founder can measure and the threshold that would change your call, then "by YYYY-MM-DD", ${window(today, goals)}.${goalRule(goals)}\n`
  + 'This week: the first move, one thing the founder does this week.';

const LABELS: { field: 'call' | 'why' | 'kill' | 'week' | 'gap'; label: RegExp }[] = [
  { field: 'call', label: /^(?:my call|verdict|decision|the call)\s*:\s*/i },
  { field: 'why', label: /^(?:why|reason|the reason|strongest reason|because)\s*:\s*/i },
  { field: 'kill', label: /^(?:kill signal|kill criterion|kill metric|kill switch|kill line|tripwire)\s*:\s*/i },
  { field: 'week', label: /^(?:this week|first move(?: this week)?|next move|first step)\s*:\s*/i },
  { field: 'gap', label: /^(?:gap|the gap|how the gap closes)\s*:\s*/i },
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
export function dayIn(text: string): { day: string; at: number; end: number } | null {
  const found = DATED.exec(text);
  if (!found) return null;
  const [year, month, date] = found[1] ? [Number(found[1]), Number(found[2]), Number(found[3])]
    : found[4] ? [Number(found[6]), MONTHS.indexOf(found[5].toLowerCase().slice(0, 3)) + 1, Number(found[4])]
      : [Number(found[9]), MONTHS.indexOf(found[7].toLowerCase().slice(0, 3)) + 1, Number(found[8])];
  const check = new Date(year, month - 1, date, 12);
  if (check.getMonth() !== month - 1 || check.getDate() !== date) return null;
  return { day: `${year}-${pad(month)}-${pad(date)}`, at: found.index, end: found.index + found[0].length };
}

// The words that name what a count is ("print jobs" of "10 print jobs done"), one form for one and many.
const nouns = (text: string) => new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((word) => !/^(?:done|than|fewer|less|more|under|below|above|over|least|most|with|from|paying|total)$/.test(word)).map((word) => word.replace(/s$/, '')));
// The goal a kill signal is about: one sharing a word of what it counts.
export function goalOf(what: string, goals: GoalDay[]): GoalDay | undefined {
  const words = nouns(what);
  return goals.find((goal) => [...nouns(goal.what)].some((word) => words.has(word)));
}
const goalRule = (goals: GoalDay[]) => (goals.length ? ` A signal on the goal's own number is checked on or before its day (${goals.map((goal) => `${goal.what} by ${goal.by}`).join('; ')}), never after it.` : '');

// A kill signal as said: the thing and its threshold before the day, and whatever follows the day. Without a number
// besides the day it measures nothing; without a day of one to six weeks ahead (or the founder's own goal day) it has
// no date, and a day past the goal it is about is no date either: the check comes after the goal has been missed.
export function killOf(text: string, today: string, goals: GoalDay[] = []): { signal?: KillSignal; missing: CallField[] } {
  const day = dayIn(text);
  const what = tidy((day ? text.slice(0, day.at) : text).replace(/\b(?:by|on|before|until|at)\s*(?:the\s+)?$/i, '')).replace(/[\s,;:.(-]+$/, '');
  const then = day ? tidy(text.slice(day.end)).replace(/^[).,;\s]+/, '').replace(/[\s.]+$/, '') : '';
  const missing: CallField[] = [];
  if (!/\d/.test(what)) missing.push('kill signal');
  const ahead = day ? between(today, day.day) : -1;
  const onGoal = !!day && ahead > 0 && goals.some((goal) => goal.by === day.day);
  const subject = goalOf(what, goals);
  const late = !!day && !!subject && between(subject.by, day.day) > 0 && between(today, subject.by) > 0;
  if (!day || late || (!onGoal && (ahead < SOONEST || ahead > LATEST))) missing.push('date');
  if (missing.length) return { missing };
  return { signal: { what, by: day!.day, ...(then ? { then } : {}) }, missing };
}

// The threshold of a kill signal: "paying practices < 2", "fewer than 10 paying practices", "monthly burn above €1,200".
// `below`: the signal fires when the number is under the threshold (a number the company wants up); else when it is over.
const UNDER = String.raw`<=?|≤|below|under|less than|fewer than|lower than|at most|no more than`;
const OVER = String.raw`>=?|≥|above|over|more than|greater than|higher than|exceeds?|at least`;
const VALUE = String.raw`[$€£]?\s?(\d[\d,]*(?:\.\d+)?)\s?(k\b|%)?`;
const QUALIFIER = /^(?:still|stays?|remains?|is|are|has|have|falls?|drops?|goes|gets?|reaches?|hits?|only|fewer|still at)\s+/i;
export function thresholdOf(what: string): { metric: string; below: boolean; value: number } | null {
  const said = what.replace(/[*_`]/g, '').trim();
  const number = (digits: string, unit?: string) => Number(digits.replace(/,/g, '')) * (unit?.toLowerCase() === 'k' ? 1000 : 1);
  const after = new RegExp(String.raw`^(.*?[a-z].*?)\s*(?:is\s+|are\s+|stays?\s+|remains?\s+|falls?\s+|drops?\s+|goes\s+|still\s+)*(${UNDER}|${OVER})\s*${VALUE}`, 'i').exec(said);
  if (after) {
    let metric = after[1].replace(/[\s:,-]+$/, '').trim();
    while (QUALIFIER.test(metric)) metric = metric.replace(QUALIFIER, '');
    return { metric, below: new RegExp(`^(?:${UNDER})$`, 'i').test(after[2]), value: number(after[3], after[4]) };
  }
  const before = new RegExp(String.raw`^(?:\w+\s+){0,3}?(${UNDER}|${OVER})\s*${VALUE}\s+([a-z][^,;.(]*)`, 'i').exec(said);
  if (before) return { metric: before[4].trim(), below: new RegExp(`^(?:${UNDER})$`, 'i').test(before[1]), value: number(before[2], before[3]) };
  // "6 paying users": a count to reach, so it fires under it.
  const bare = new RegExp(String.raw`^${VALUE}\s+([a-z][^,;.(]*)$`, 'i').exec(said);
  if (bare) return { metric: bare[3].trim(), below: true, value: number(bare[1], bare[2]) };
  return null;
}

// Journey 14: "Kill signal: paying practices < 2" with 2 paying already could only fire if a customer left. A kill
// signal holds the call to a test it could fail: today's value is on the losing side of the threshold (under it for a
// number the company wants up, over it for one it wants down), and the threshold is in reach by the day (within ten
// times today's value). Read against the Company brief's Numbers; a number the brief does not hold is not judged.
export function deadSignal(signal: KillSignal, numbers: string): string | null {
  const said = thresholdOf(signal.what);
  if (!said || !numbers.trim()) return null;
  const row = briefRow(numbers, said.metric);
  if (!row) return null;
  const now = row.value;
  const name = row.label.toLowerCase();
  if (said.below ? now >= said.value : now <= said.value) {
    return `${row.label} is ${now} now (Company brief), so "${signal.what}" can only fire if it ${said.below ? 'falls' : 'rises'} back: it cannot fail on progress. Name a threshold ${said.below ? 'above' : 'below'} ${now} that ${name} must ${said.below ? 'reach' : 'come down to'} by the day, one the company could miss.`;
  }
  const far = said.below ? now > 0 && said.value > now * 10 : said.value < now / 10;
  if (far) return `${row.label} is ${now} now (Company brief), so ${said.value} by ${signal.by} is out of reach: name a threshold the company could ${said.below ? 'reach' : 'come down to'} by then.`;
  return null;
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

const WORKING = /^(?:break[- ]?even|runway)\s*:/i;

// The verdict in a reply: each labelled line read, what is missing named, and the reply's other lines kept as they are.
// `numbers`: the Company brief's Numbers section, which a kill signal is held against (deadSignal).
export function readCall(text: string, today: string, evidence: string, economics?: Economics | null, numbers = '', goals: GoalDay[] = []): ReadCall {
  const said: Partial<Record<'call' | 'why' | 'kill' | 'week' | 'gap', string>> = {};
  const rest: string[] = [];
  for (const line of text.split('\n')) {
    const bare = plain(line);
    const hit = LABELS.find((one) => one.label.test(bare));
    if (hit && !said[hit.field]) said[hit.field] = tidy(bare.replace(hit.label, ''));
    // The working is shown under the reason from the calc results themselves, so a copy of it in the reply goes.
    else if (!hit && !(economics && WORKING.test(bare))) rest.push(line);
  }
  const missing: CallField[] = [];
  const decision = said.call ? decisionOf(said.call) : undefined;
  if (!decision) missing.push('call');
  const why = said.why || undefined;
  const unsourced = why ? unsourcedIn(why, evidence) : [];
  if (!why || unsourced.length) missing.push('why');
  const kill: { signal?: KillSignal; missing: CallField[] } = said.kill ? killOf(said.kill, today, goals) : { missing: ['kill signal', 'date'] };
  const dead = kill.signal ? deadSignal(kill.signal, numbers) : null;
  if (dead) kill.missing.push('kill signal');
  missing.push(...kill.missing);
  const move = said.week || undefined;
  if (!move) missing.push('this week');
  const restText = rest.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const closed = !!economics && saysGap(`${why ?? ''}\n${said.gap ?? ''}\n${move ?? ''}\n${restText}`, economics);
  if (decision === 'keep going' && wideGap(economics) && !closed) missing.push('how the gap closes');
  return { decision, why, ...(dead ? { dead } : { signal: kill.signal }), move, missing, unsourced, rest: restText, ...(said.gap ? { closes: said.gap } : {}) };
}

// The second look asks only for what is missing, each line with its rule.
export function callNudge(read: Pick<ReadCall, 'missing' | 'unsourced' | 'dead'>, today: string, economics?: Economics | null, goals: GoalDay[] = []): string {
  const lines: string[] = [];
  if (read.missing.includes('how the gap closes') && economics) lines.push(`Gap: your call is keep going, but break-even is ${economics.breakEven} ${economics.unit} and the company has ${economics.current}. In one line, say how that gap closes (price, cost, or reaching ${economics.breakEven} by when), or change the call.`);
  if (read.missing.includes('call')) lines.push('My call: keep going, change course or stop (one of the three).');
  if (read.missing.includes('why')) lines.push(`Why: the strongest reason, with only numbers the Company document, the chat or what you read gives${read.unsourced.length ? ` (nothing on record gives ${read.unsourced.join(', ')})` : ''}.`);
  if (read.missing.includes('kill signal') || read.missing.includes('date')) lines.push(`Kill signal: one number the founder can measure and the threshold that would change your call, then "by YYYY-MM-DD", ${window(today, goals)}.${goalRule(goals)}${read.dead ? ` ${read.dead}` : ''}`);
  if (read.missing.includes('this week')) lines.push('This week: the first move, one thing the founder does this week.');
  const names = read.missing.filter((one, index, all) => all.indexOf(one) === index && !(one === 'date' && all.includes('kill signal')));
  // A gap asked about may change the call itself, so the call line is answered again with it.
  if (read.missing.includes('how the gap closes') && !read.missing.includes('call')) lines.unshift('My call: keep going, change course or stop (one of the three).');
  return `Take another look before this goes to the founder: your verdict is missing ${names.join(', ')}. Answer with only these lines, nothing else:\n${lines.join('\n')}`;
}

export const NO_SIGNAL = 'no kill signal named yet';
const sentence = (text: string) => text.replace(/[\s.]+$/, '') + '.';
// The verdict as the founder reads it: the four lines first, then whatever else the partner said.
export function renderCall(call: PartnerCall, rest = ''): string {
  const lines = [
    ...(call.decision ? [`My call: **${call.decision}**.`] : []),
    ...(call.why ? [`Why: ${sentence(call.why)}`] : []),
    ...(call.working ?? []).map((line) => `- ${sentence(line)}`),
    ...(call.gap ? [`Gap: ${sentence(call.gap)}`] : []),
    call.signal ? `Kill signal: ${call.signal.what} by ${call.signal.by}${call.signal.then ? `; ${call.signal.then.replace(/[\s.]+$/, '')}` : ''}.` : `Kill signal: ${NO_SIGNAL}.`,
    ...(call.move ? [`This week: ${sentence(call.move)}`] : []),
  ];
  return [lines.join('\n'), rest.trim()].filter(Boolean).join('\n\n');
}

// What a Needs you row asks on the signal's day.
export const checkTitle = (signal: KillSignal) => `Check: ${signal.what} by ${signal.by}?`;

// The partner's reply to a verdict ask, held to the shape. `again` answers once more in words only; a part the second
// answer gives fills the first's gap, and a kill signal named by neither is said to be missing.
// `said` is what may back a claim of evidence in the reason ("the product works"): the founder's words, the Company
// document and this turn's tool results, never the partner's own past replies. One nothing backs stays, marked
// "(assumption)" (server/tools/evidence.ts).
// `pushed`: the founder pushed back on the verdict standing (pushesBack), which is held to the same four lines.
export async function holdCall(asked: string, first: TurnResult, again: ((first: TurnResult, nudge: string) => Promise<TurnResult>) | undefined, today: string, evidence: string, said: string[] = [evidence], economics?: Economics | null, numbers = '', pushed = false, goals: GoalDay[] = []): Promise<{ reply: TurnResult; call: PartnerCall | null; askedAgain: boolean }> {
  if (first.stopped || (!pushed && !asksVerdict(asked))) return { reply: first, call: null, askedAgain: false };
  // The brief's working is on record for the reason: its figures are calc results, not the partner's guesses.
  const working = economics?.working.map((one) => one.line) ?? [];
  const held = [evidence, ...working].join('\n');
  const read = readCall(first.text, today, held, economics, numbers, goals);
  let call: PartnerCall = { decision: read.decision, why: read.why, signal: read.signal, move: read.move, ...(read.closes ? { gap: read.closes } : {}) };
  let reply = first;
  let gapOpen = read.missing.includes('how the gap closes');
  const askedAgain = !!read.missing.length && !!again;
  if (askedAgain) {
    const second = await again!(first, callNudge(read, today, economics, goals));
    if (!second.stopped) {
      const more = readCall(second.text, today, held, economics, numbers, goals);
      // Asked how the gap closes, the partner may change the call: the second call stands then. Their line on how it
      // closes is kept as the Gap line, labelled or not.
      const closes = more.closes ?? (economics ? more.rest.split('\n').map((line) => plain(line)).find((line) => saysGap(line, economics)) : undefined);
      call = {
        decision: gapOpen && more.decision ? more.decision : call.decision ?? more.decision,
        // A reason with a number nothing gives is put right by a second one that is sourced; else the first stands.
        why: !read.why || (read.unsourced.length && more.why && !more.unsourced.length) ? more.why ?? call.why : call.why,
        signal: call.signal ?? more.signal,
        move: call.move ?? more.move,
        ...(closes ?? call.gap ? { gap: closes ?? call.gap } : {}),
      };
      if (gapOpen) gapOpen = !closes;
    }
    reply = { ...second, tools: [...first.tools, ...second.tools], usage: { input: first.usage.input + second.usage.input, output: first.usage.output + second.usage.output } };
  }
  // Still "keep going" far below break-even with nothing said on how that closes: said so, never filled in.
  if (gapOpen && economics && call.decision === 'keep going') call = { ...call, gap: `break-even is ${economics.breakEven} ${economics.unit} and the company has ${economics.current}; nothing said yet closes that gap` };
  // A gap line belongs to a "keep going" only, and never repeats the reason.
  if (call.gap && (call.decision !== 'keep going' || tidy(call.gap) === tidy(call.why ?? ''))) { const { gap: _gap, ...rest } = call; call = rest; }
  if (working.length) call = { ...call, working };
  if (call.why) call = { ...call, why: markClaims(call.why, [...said, ...working]) };
  return { reply: { ...reply, text: renderCall(call, read.rest) }, call, askedAgain };
}
