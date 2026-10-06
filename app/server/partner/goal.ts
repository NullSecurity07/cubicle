import { dayIn } from './call.ts';

// The Company brief's dated goal: "Goal this quarter: 10 paying practices", "Goal: 10 paying practices by 3 November
// 2026". Journey 14: the brief said "this quarter"; two days later the partner's update said "by 3 November 2026" and
// nobody had asked for the move. A goal's day is the founder's: read here in code, held to on every write to the brief,
// and a goal whose day has passed brings the partner's verdict up again.

export type Goal = { what: string; by: string; said: string; line: string };

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (year: number, month: number) => `${year}-${pad(month + 1)}-${pad(new Date(year, month + 1, 0).getDate())}`;

// The day a goal's words name, and the words: a day written out, or the end of a quarter, a month or the year.
export function goalDay(text: string, today: string): { by: string; said: string } | null {
  const day = dayIn(text);
  if (day) return { by: day.day, said: text.slice(day.at, day.end) };
  const [year, month] = today.split('-').map(Number);
  const quarter = /\b(?:this|the current|end of (?:the|this)) quarter\b|\bq([1-4])\b/i.exec(text);
  if (quarter) {
    const q = quarter[1] ? Number(quarter[1]) : Math.ceil(month / 3);
    return { by: lastDay(year, q * 3 - 1), said: quarter[0] };
  }
  const named = new RegExp(`\\b(?:by|before|end of|in|until)\\s+(?:the end of\\s+)?(${MONTHS.join('|')})\\b`, 'i').exec(text);
  if (named) {
    const at = MONTHS.indexOf(named[1].toLowerCase());
    return { by: lastDay(at + 1 < month ? year + 1 : year, at), said: named[1] };
  }
  const span = /\b(?:this|end of (?:the|this)) (month|year)\b/i.exec(text);
  if (span) return { by: span[1].toLowerCase() === 'month' ? lastDay(year, month - 1) : `${year}-12-31`, said: span[0] };
  return null;
}

// What a goal counts: "10 paying practices".
const TARGET = /(\d[\d,]*)\s+((?:[a-z][a-z-]*\s?){1,4}?)(?=\s+(?:by|before|on|this|in|at|until|per|a|each|of)\b|[.,;:(]|\s*$)/i;
const norm = (what: string) => what.toLowerCase().replace(/,/g, '').replace(/s\b/g, '').replace(/\s+/g, ' ').trim();

// Every goal with a day in a document: one per sentence that names a goal and a count.
export function goalsIn(text: string, today: string): Goal[] {
  const found: Goal[] = [];
  for (const line of text.split('\n')) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const at = /\bgoal\b/i.exec(sentence);
      if (!at) continue;
      const rest = sentence.slice(at.index);
      const target = TARGET.exec(rest.replace(/^[^:]*:\s*/, ''));
      const when = goalDay(rest, today);
      if (!target || !when) continue;
      found.push({ what: `${target[1]} ${target[2].trim()}`, by: when.by, said: when.said, line: line.trim() });
    }
  }
  return found;
}

// A write to the brief that moves a goal's day, or null. It stands only with the old day kept on the same line ("was
// this quarter") and a reason ("because", "since", "after", "as", "due to").
export function goalMoved(before: string, after: string, today: string): string | null {
  const was = goalsIn(before, today);
  const had = new Set(before.split('\n').map((line) => line.trim()));
  for (const goal of goalsIn(after, today)) {
    if (had.has(goal.line)) continue;
    const old = was.find((one) => norm(one.what) === norm(goal.what) && one.by !== goal.by);
    if (!old) continue;
    const kept = new RegExp(`\\bwas\\b[^)\\n]*${old.said.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(goal.line);
    const why = /\b(?:because|since|after|as|due to|given)\b/i.test(goal.line.replace(goal.said, ''));
    if (kept && why) continue;
    return `the goal "${goal.what}" moves from ${old.said} to ${goal.said}. A goal's day is the founder's: keep "${old.said}", or keep the old day on the same line as "(was ${old.said})" with the reason the founder gave ("because …").`;
  }
  return null;
}
