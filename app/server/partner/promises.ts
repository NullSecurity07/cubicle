import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Attention } from '../../shared/model.ts';
import { localDay } from '../clock.ts';
import { writeAtomic } from '../fsx.ts';
import { newId } from '../slice-kit.ts';

// The founder's promises, in `workspace/promises.json`. A co-founder remembers what the other said they would do: "I'll
// call five beta users by Friday" becomes a dated promise, comes to Needs you (and so Today's five) on its day, is
// chased once in the partner's room when it is late, and is closed by the founder alone. Read in code from the
// founder's own words; no model decides what was promised.

export type FounderPromise = {
  id: string; what: string; due: string; said: string; at: number; roomId?: string;
  status: 'open' | 'done' | 'dropped'; closed?: string; chased?: string;
};
export type Said = { what: string; due: string };

const DAY = 86_400_000;
const MOST = 200;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const COUNTS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14 };

// Noon on a local day, so adding days never trips over a clock change.
const noon = (at: number) => { const day = new Date(at); day.setHours(12, 0, 0, 0); return day; };
const plus = (at: number, days: number) => localDay(noon(at).getTime() + days * DAY);
// The first such weekday from today on (today counts when `today` is set), else strictly after today.
const nextWeekday = (at: number, target: number, today: boolean) => {
  const now = noon(at).getDay();
  let ahead = (target - now + 7) % 7;
  if (ahead === 0 && !today) ahead = 7;
  return ahead;
};
// The end of the week this day is in: its Friday, or its Sunday from Saturday on.
const weekEnd = (at: number) => { const now = noon(at).getDay(); return now === 6 ? 1 : now === 0 ? 0 : 5 - now; };

// The day a sentence gives for something, or null when it names none.
export function dueOf(sentence: string, now: number): string | null {
  const said = sentence.toLowerCase();
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(said);
  if (iso) return iso[1];
  if (/\b(?:today|tonight|this (?:morning|afternoon|evening)|end of (?:the )?day|eod)\b/.test(said)) return localDay(now);
  if (/\btomorrow\b/.test(said)) return plus(now, 1);
  if (/\bnext week\b/.test(said)) return plus(now, weekEnd(now) + 7);
  if (/\b(?:this week|(?:by |before )?(?:the )?end of (?:the |this )?week|eow)\b/.test(said)) return plus(now, weekEnd(now));
  const inSome = new RegExp(`\\bin (\\d+|${Object.keys(COUNTS).join('|')}) (days?|weeks?)\\b`).exec(said);
  if (inSome) {
    const count = Number(inSome[1]) || COUNTS[inSome[1]];
    return plus(now, count * (inSome[2].startsWith('week') ? 7 : 1));
  }
  const day = new RegExp(`\\b(next )?(${WEEKDAYS.join('|')})\\b`).exec(said);
  if (day) {
    const target = WEEKDAYS.indexOf(day[2]);
    // "By Friday" counts today when today is Friday; "on Monday" said on a Monday is the next one.
    let ahead = nextWeekday(now, target, /\bby\s+$/.test(said.slice(0, day.index)));
    // "Next Friday" said before Friday is the one after this week's.
    if (day[1] && noon(now).getDay() < target) ahead += 7;
    return plus(now, ahead);
  }
  const months = MONTHS.join('|');
  const dated = new RegExp(`\\b(?:(${months})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?|(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${months})[a-z]*)\\b`).exec(said);
  if (dated) {
    const month = MONTHS.indexOf(dated[1] ?? dated[4]);
    const date = Number(dated[2] ?? dated[3]);
    const year = new Date(now).getFullYear();
    let when = localDay(new Date(year, month, date, 12).getTime());
    if (when < localDay(now)) when = localDay(new Date(year + 1, month, date, 12).getTime());
    return when;
  }
  return null;
}

// Who says they will do something, and how: "I'll", "I will", "I'm going to" always; "we'll" only with a day on it.
const I_WILL = /\b(?:I'?ll|I will|I'm going to|I am going to|I'm gonna)\s+/i;
const WE_WILL = /\b(?:we'?ll|we will|we're going to|we are going to)\s+/i;
// "I call the bank this week", "Will ship it by Friday", "Calling the users by Friday": a day with the founder doing it.
const I_DO = /^\s*(?:I\s+(?!(?:am|was|have|had|think|guess|hope|wonder|feel|know|need|want|should|could|would|might|can|may|did|do|don't|just)\b)|will\s+(?=[a-z]))/i;
const DOING = /^\s*([A-Z][a-z]+ing)\b/;
const NOT_DOING = /^(?:nothing|something|everything|anything|morning|evening|during|pricing|funding|marketing|onboarding|spending|thing|king|bring)$/i;
// Not a promise: a thought, a state, a word to the app, a refusal.
const NOT_A_PROMISE = /^(?:not|never|probably|maybe|likely|be|have|need|see|think|consider|let\s+you|let's|paste|upload|share|attach|tell\s+you|answer|explain|get\s+back|wait|leave|keep\s+(?:you|it)|\w+\s+you\b)/i;
// A condition or a what-if before the words: "if it rains I'll", "maybe I'll", "what I'll do".
const HEDGED = /\b(?:if|whether|what|how|unless|in case|maybe|perhaps|might|wonder)\b/i;
// Said for right now, to the app: "I'll paste it now".
const RIGHT_NOW = /\b(?:now|right away|here|below|in a (?:sec|second|minute|moment))\b/i;

const clean = (text: string) => text.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().replace(/[.!,;:\s]+$/, '');

// Every promise in a message from the founder, with its day: what they said they would do, from the verb on.
export function promisesIn(message: string, now: number): Said[] {
  const found: Said[] = [];
  const sentences = message.split(/(?<=[.!?])\s+|\n+/);
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence || /\?\s*$/.test(sentence)) continue;
    const due = dueOf(sentence, now);
    let what: string | null = null;
    const will = I_WILL.exec(sentence) ?? (due ? WE_WILL.exec(sentence) : null);
    if (will) {
      if (HEDGED.test(sentence.slice(0, will.index))) continue;
      what = sentence.slice(will.index + will[0].length);
    } else if (due && I_DO.test(sentence)) {
      what = sentence.replace(I_DO, '');
    } else if (due && DOING.test(sentence) && !NOT_DOING.test(DOING.exec(sentence)![1])) {
      what = sentence;
    }
    if (!what) continue;
    what = clean(what);
    if (NOT_A_PROMISE.test(what) || RIGHT_NOW.test(what) || what.split(' ').length < 2) continue;
    found.push({ what: what.slice(0, 140), due: due ?? plus(now, 7) });
  }
  return found;
}

export function promisesBook(workspace: string, now: () => number = Date.now) {
  const path = join(workspace, 'promises.json');
  let queue: Promise<unknown> = Promise.resolve();
  async function list(): Promise<FounderPromise[]> {
    try { const saved = JSON.parse(await readFile(path, 'utf8')) as { promises?: FounderPromise[] }; return Array.isArray(saved.promises) ? saved.promises : []; } catch { return []; }
  }
  function change<T>(edit: (all: FounderPromise[]) => T): Promise<T> {
    const job = queue.then(async () => {
      const all = await list();
      const out = edit(all);
      await writeAtomic(path, JSON.stringify({ promises: all.slice(-MOST) }, null, 2), { mkdir: true });
      return out;
    });
    queue = job.catch(() => {});
    return job;
  }
  const held = (all: FounderPromise[], id: string) => { const one = all.find((each) => each.id === id); if (!one) throw new Error('there is no promise by that name'); return one; };
  return {
    list,
    settled: () => queue,
    // A thing already promised and still open is not promised twice.
    add: (said: Said & { roomId?: string }) => change((all) => {
      if (all.some((one) => one.status === 'open' && one.what.toLowerCase() === said.what.toLowerCase())) return null;
      const made: FounderPromise = { id: newId('promise-'), what: said.what, due: said.due, said: localDay(now()), at: now(), ...(said.roomId ? { roomId: said.roomId } : {}), status: 'open' };
      all.push(made);
      return made;
    }),
    // True the first time only: a late promise is chased once.
    chased: (id: string) => change((all) => { const one = held(all, id); if (one.chased) return false; one.chased = localDay(now()); return true; }),
    close: (id: string, done: boolean) => change((all) => {
      const one = held(all, id);
      if (one.status !== 'open') throw new Error('this promise is already closed');
      one.status = done ? 'done' : 'dropped';
      one.closed = localDay(now());
      return one;
    }),
  };
}
export type PromisesBook = ReturnType<typeof promisesBook>;

const daysBetween = (from: string, to: string) => Math.round((new Date(`${to}T12:00`).getTime() - new Date(`${from}T12:00`).getTime()) / DAY);

// Open promises whose day has come, for Needs you: due today, or how late.
export function promisesAttention(all: FounderPromise[], today: string): Attention[] {
  return all.filter((one) => one.status === 'open' && one.due <= today).map((one) => {
    const late = daysBetween(one.due, today);
    const when = late === 0 ? 'Due today.' : `Due ${one.due}, ${late === 1 ? '1 day' : `${late} days`} ago.`;
    return { id: `promise:${one.id}`, kind: 'promise' as const, title: `You said you would ${one.what}`, detail: `${when} Said on ${one.said}.`, at: new Date(`${one.due}T00:00`).getTime(), ...(one.roomId ? { roomId: one.roomId } : {}) };
  });
}

// The line under the reply that heard it, so the founder knows it was kept.
export const keptPromiseLine = (kept: Said[]) => `*Kept as a promise: ${kept.map((one) => `${one.what} (due ${one.due})`).join('; ')}. It comes to Needs you on the day.*`;
// What the partner says once in their room when a promise is late.
export const chaseLine = (one: Pick<FounderPromise, 'what' | 'due'>) => `You said you would ${one.what} (due ${one.due}). Done? Close it in Needs you, or tell me what got in the way.`;
// The line the partner's standing facts carry for each open promise.
export const promiseLine = (one: Pick<FounderPromise, 'what' | 'due'>) => `- ${one.what} (due ${one.due})`;
