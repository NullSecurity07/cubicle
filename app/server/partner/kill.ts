import { asksVerdict, dayIn, plusDays, thresholdOf, type KillSignal } from './call.ts';
import { sameMetric } from './economics.ts';

// Journey 16: "Sam, tighten the kill signal: fewer than 9 paying subscribers by 2026-10-17. Replace the old one." The
// model asked for a Metrics card with a CSV header; asked again, it proposed a bet of 15 paying subscribers (the goal
// was 30). The check stayed "below 8". Then the refresh moved the line to "below 11" with the last reading at 9.5, and
// said nothing about it being crossed already. Moving the kill line is the founder's word, read here in code: no model,
// no bet, no card. And a line that moves is never silent: the line says old → new, and a reading already past the new
// line raises the check at once.

export type KillAsk = { signal: KillSignal; metric: string; line: number; below: boolean };

const KILL = /\bkill[- ]?(?:signal|line|criterion|metric|switch|threshold)\b|\btripwire\b|\bthe kill\b(?!\s+(?:it|this|the company))/i;
const CHANGE = /\b(?:replace|change|move|set|make|tighten|loosen|lower|raise|update|swap|use|put|reset)\b/i;
const IT_TO = /^\s*(?:ok(?:ay)?[,.!]?\s+)?(?:make|set|change|move|put)\s+it\s+(?:to\s+|at\s+)?(?:<|below|under|fewer than|less than|>|above|over|more than)?\s*\d/i;
const UNDER = /(?:<=?|≤|\bbelow|\bunder|\bfewer than|\bless than|\blower than|\bdrops? (?:below|under|to))\s*$/i;
const OVER = /(?:>=?|≥|\babove|\bover|\bmore than|\bgreater than|\bhigher than|\bexceeds?)\s*$/i;

// The founder's ask to set or move the kill signal, read against the brief's rows and the Metrics rows; null when what
// they said is not one. `signal`: the one standing. `lastSaid`: the partner's last message, for "make it 9".
// `loose`: read inside a verdict ask or a question too, to tell whether the founder named the kill line themselves.
export function killAskIn(said: string, given: { today: string; labels: string[]; signal?: KillSignal; lastSaid?: string; goalDay?: string; loose?: boolean }): KillAsk | null {
  const text = said.replace(/[*_`]/g, '').trim();
  if (!text || (!given.loose && (asksVerdict(text) || /\?\s*$/.test(text)))) return null;
  const named = KILL.test(text) && CHANGE.test(text);
  const itTo = !named && !!given.signal && IT_TO.test(text) && !!given.lastSaid && KILL.test(given.lastSaid);
  if (!named && !itTo) return null;
  // The day comes out first, so its digits are never the line.
  const day = dayIn(text);
  const rest = day ? `${text.slice(0, day.at)} ${text.slice(day.end)}` : text;
  // The number after the words "kill signal" (or the whole ask for "make it 9"): the first not part of a day.
  const from = named ? Math.max(0, rest.search(KILL)) : 0;
  const tail = rest.slice(from);
  const found = /(?<![\d.,])(\d[\d,]*(?:\.\d+)?)(?![\d.,]*\s*(?:%|days?|weeks?|months?\b))/.exec(tail);
  if (!found) return null;
  const line = Number(found[1].replace(/,/g, ''));
  const before = tail.slice(0, found.index);
  const old = given.signal ? thresholdOf(given.signal.what) : null;
  const below = UNDER.test(before) ? true : OVER.test(before) ? false : old ? old.below : true;
  // What it counts: the words after the number ("paying subscribers", "paying"), as a brief or Metrics row names it.
  const words = /^\s*([a-z][a-z -]{0,40}?)(?=\s+(?:by|on|before|until|and|instead|as|for|from|in|to)\b|[,.;:!)]|$)/i.exec(tail.slice(found.index + found[0].length))?.[1]?.trim() ?? '';
  const metric = (words ? best(given.labels, words) : undefined) ?? (old?.metric ? best(given.labels, old.metric) ?? old.metric : undefined) ?? (words || null);
  if (!metric) return null;
  const label = metric[0].toUpperCase() + metric.slice(1);
  const by = day?.day ?? given.signal?.by ?? given.goalDay ?? plusDays(given.today, 14);
  return { signal: { what: `${label} ${below ? 'below' : 'above'} ${line.toLocaleString('en-US')}`, by }, metric: label, line, below };
}

// The row a few words name: the one sharing the most words with them, the fewest besides ("paying" is "Paying
// subscribers", never "Subscribers").
const stems = (text: string) => (text.toLowerCase().match(/[a-z]{3,}/g) ?? []).map((one) => one.replace(/s$/, ''));
function best(labels: string[], words: string): string | undefined {
  const want = stems(words);
  const scored = labels.filter((label) => sameMetric(label, words)).map((label) => { const have = stems(label); return { label, score: have.filter((one) => want.includes(one)).length * 10 - have.filter((one) => !want.includes(one)).length }; });
  return scored.sort((a, b) => b.score - a.score)[0]?.label;
}

// Whether a reading sits past a kill line already.
export const pastLine = (value: number, line: number, below: boolean) => (below ? value < line : value > line);

// The one line that says a kill signal moved, and whether the number is already past it.
export function killMovedLine(old: KillSignal | undefined, fresh: KillSignal, reading?: { value: number; said: string } | null): string {
  const said = thresholdOf(fresh.what);
  const crossed = !!reading && !!said && pastLine(reading.value, said.value, said.below);
  const moved = old ? `Kill signal moved: "${old.what}" by ${old.by} → "${fresh.what}" by ${fresh.by}.` : `Kill signal set: "${fresh.what}" by ${fresh.by}.`;
  return `${moved}${crossed ? ` ${reading!.said}: already past the new line, so the check is in Needs you now.` : ` It is the check in Needs you on ${fresh.by}.${onLine(fresh, reading)}`}`;
}

// A line set at today's value ("below 11" with 11 paying) is allowed, and the founder is told how close it sits: one
// lost customer trips it.
export function onLine(signal: KillSignal, reading?: { value: number; said: string } | null): string {
  const said = thresholdOf(signal.what);
  if (!reading || !said || reading.value !== said.value) return '';
  return ` ${reading.said}, right on the line: ${said.below ? 'losing one trips it' : 'any rise trips it'}.`;
}

// Journey 18: the founder's "below 12" with 9 paying was taken with "already past the new line", while the partner's
// own crossed line is refused with a retry. One rule for both: a kill line crossed the moment it is set is no kill line.
// The founder is told so, with the line that would be taken: today's value, or any floor under it.
export function crossedRefusal(fresh: KillSignal, reading?: { value: number; said: string } | null): string | null {
  const said = thresholdOf(fresh.what);
  if (!reading || !said || !pastLine(reading.value, said.value, said.below)) return null;
  const metric = fresh.what.replace(/\s+(?:below|under|above|over)\s+[\d,.]+\s*$/i, '').trim() || said.metric;
  const value = reading.value.toLocaleString('en-US');
  return `Not set: "${fresh.what}" is crossed already (${reading.said}), so its check would fire today. The kill line stays as it was. `
    + `Say "replace the kill signal: ${metric} ${said.below ? 'below' : 'above'} ${value} by ${fresh.by}", or a line ${said.below ? 'under' : 'over'} ${value}, and I will set it.`;
}

// Journey 20: asked for the kill line and today's number, the partner said "9 paying cafés, above the kill line of 7"
// with 6 on the Metrics card that day. Every partner turn carries the line and today's reading against it, read in
// code at the turn, so the number quoted is today's and its side of the line is worked out, never guessed.
export function killStandLine(signal: KillSignal, reading?: { value: number; said: string } | null): string | null {
  const said = thresholdOf(signal.what);
  if (!said || !reading) return null;
  const stand = pastLine(reading.value, said.value, said.below) ? 'past the line: the kill line is crossed'
    : reading.value === said.value ? `right on the line, not past it: ${said.below ? 'losing one' : 'any rise'} crosses it` : 'on the safe side of the line';
  return `Kill line now: "${signal.what}" by ${signal.by}. Today's number against it: ${reading.said}, ${stand}. Quote this reading, never an older one.`;
}
