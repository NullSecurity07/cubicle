import type { Repeat } from './model.ts';

// When a task runs, said in the founder's own words. Everything here is pure and has no dependency, so the field on
// the board can answer while they are still typing and the server can read the very same sentence when it saves.

// A quicker interval than this would spend a free model's whole day in an afternoon, so a typo cannot ask for one.
export const FLOOR = 15;
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// What the founder may type for a day. A plural ("mondays") is the same day; "thurs" is already here, so a trailing
// "s" is only dropped when the whole word is not a day by itself.
const DAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MINUTES: Record<string, number> = { m: 1, min: 1, mins: 1, minute: 1, minutes: 1, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, d: 1440, day: 1440, days: 1440 };
const UNIT = 'm|mins?|minutes?|h|hrs?|hours?|d|days?';
const ONCE = new RegExp(`\\bin (\\d+) ?(${UNIT})\\b`);
const EVERY = new RegExp(`\\bevery (\\d+) ?(${UNIT})\\b`);
const CLOCK = /\b(\d{1,2}):(\d{2}) ?(am|pm)?\b/;
const HOUR = /\b(\d{1,2}) ?(am|pm)\b/;
const BARE_HOUR = /\bat (\d{1,2})\b/;
const FILLER = /\b(at|on|every|each|and|the|of|starting|please|run|it|runs)\b|[,&;.!]/g;
const HELP = 'Try "every day at 9am", "weekdays at 9", "mondays at 14:30", "every 30 minutes" or "in 2 hours".';

// What the field says back: the schedule it understood, or the words it could not place.
export type Schedule = { repeat: Repeat; next: number; words: string; note?: string } | { problem: string };

const two = (value: number) => String(value).padStart(2, '0');
const clock = (hours: number, minutes: number) => `${two(hours)}:${two(minutes)}`;
const hours12 = (hour: number, half: string) => (half === 'am' ? (hour === 12 ? 0 : hour) : hour === 12 ? 12 : hour + 12);
const dayOf = (word: string) => DAYS[word] ?? DAYS[word.replace(/s$/, '')];
// The weekdays a repeat falls on. The three shapes that were saved before schedules could be typed answer this too,
// which is why nothing on disk has to be rewritten.
const daysOf = (repeat: Repeat): number[] =>
  (repeat.every === 'day' ? [0, 1, 2, 3, 4, 5, 6] : repeat.every === 'weekdays' ? [1, 2, 3, 4, 5] : repeat.every === 'week' ? [repeat.weekday ?? 1] : repeat.every === 'days' ? repeat.weekdays : []);

// The next moment a repeat falls due, strictly after `after`, in this machine's own time.
export function nextDue(repeat: Repeat, after: number): number {
  if (repeat.every === 'minutes') return after + repeat.minutes * 60_000;
  // A one-off has nothing after it: 0 is "never again", which every caller already reads as no next run.
  if (repeat.every === 'once') return repeat.at > after ? repeat.at : 0;
  const [hours, minutes] = repeat.time.split(':').map(Number);
  const fits = new Set(daysOf(repeat));
  const at = new Date(after);
  at.setHours(hours, minutes, 0, 0);
  for (let day = 0; day < 9; day += 1) {
    if (fits.has(at.getDay()) && at.getTime() > after) return at.getTime();
    at.setDate(at.getDate() + 1);
  }
  return at.getTime();
}

const time = (value: unknown) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)) ? String(value) : '');
const weekday = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 6 ? (value as number) : undefined);

// Anything that arrives from the founder's window or from a board file written by an older version of this.
export function cleanRepeat(value: unknown): Repeat | undefined {
  const repeat = value as Partial<Repeat> & { minutes?: unknown; at?: unknown; weekdays?: unknown };
  if (!repeat || typeof repeat !== 'object') return undefined;
  const when = time((repeat as { time?: unknown }).time);
  if (repeat.every === 'day' || repeat.every === 'weekdays') return when ? { every: repeat.every, time: when } : undefined;
  if (repeat.every === 'week') return when ? { every: 'week', time: when, weekday: weekday((repeat as { weekday?: unknown }).weekday) ?? 1 } : undefined;
  if (repeat.every === 'days') {
    const days = [...new Set((Array.isArray(repeat.weekdays) ? repeat.weekdays : []).flatMap((one) => (weekday(one) === undefined ? [] : [one as number])))].sort();
    return when && days.length ? { every: 'days', time: when, weekdays: days } : undefined;
  }
  if (repeat.every === 'minutes') {
    const minutes = Math.round(Number(repeat.minutes));
    return Number.isFinite(minutes) && minutes > 0 ? { every: 'minutes', minutes: Math.max(minutes, FLOOR) } : undefined;
  }
  if (repeat.every === 'once') {
    const at = Number(repeat.at);
    return Number.isFinite(at) && at > 0 ? { every: 'once', at } : undefined;
  }
  return undefined;
}

// How a schedule reads back on the card: the shortest true thing, never more.
export function sayRepeat(repeat?: Repeat): string {
  if (!repeat) return '';
  if (repeat.every === 'once') return 'once';
  if (repeat.every === 'minutes') return repeat.minutes % 60 === 0 && repeat.minutes >= 60
    ? `every ${repeat.minutes / 60} ${repeat.minutes === 60 ? 'hour' : 'hours'}` : `every ${repeat.minutes} minutes`;
  if (repeat.every === 'day') return `every day ${repeat.time}`;
  if (repeat.every === 'weekdays') return `weekdays ${repeat.time}`;
  if (repeat.every === 'days') return `${repeat.weekdays.map((day) => DAY_NAMES[day].slice(0, 3)).join(', ')} ${repeat.time}`;
  return `${DAY_NAMES[repeat.weekday ?? 1].slice(0, 3)} ${repeat.time}`;
}

// A run that fell due while the app was closed. Daily and slower catch up once however many were missed; something
// that runs every few minutes has nothing to catch up on, because the next one is minutes away.
export const missedDefault = (repeat: Repeat): 'once' | 'skip' => (repeat.every === 'minutes' && repeat.minutes < 12 * 60 ? 'skip' : 'once');
export const catchUp = (repeat?: Repeat, choice?: 'once' | 'skip') => !!repeat && (choice ?? missedDefault(repeat)) === 'once';

// The founder's sentence, read once. What it cannot place comes back in their own words rather than as a shrug, and
// the time it lands on is this machine's, the same as every other clock in the app.
export function parseSchedule(text: string, now: number): Schedule {
  let rest = ` ${String(text).toLowerCase().replace(/[“”"']/g, '').replace(/\s+/g, ' ').trim()} `;
  if (!rest.trim()) return { problem: `Say when it should run. ${HELP}` };
  const take = (pattern: RegExp) => {
    const found = pattern.exec(rest);
    if (found) rest = rest.replace(found[0], ' ');
    return found;
  };
  const left = () => rest.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  const nothingLeft = (repeat: Repeat, note?: string): Schedule => {
    const over = left();
    if (over) return { problem: `I did not understand "${over}". ${HELP}` };
    return { repeat, next: nextDue(repeat, now), words: sayRepeat(repeat), ...(note ? { note } : {}) };
  };

  const once = take(ONCE);
  if (once) {
    const minutes = Number(once[1]) * MINUTES[once[2]];
    if (!minutes) return { problem: `"In ${once[1]} ${once[2]}" is no time at all. Say how long to wait, like "in 2 hours".` };
    return nothingLeft({ every: 'once', at: now + minutes * 60_000 }, 'It runs once and then stops.');
  }
  const every = take(EVERY);
  if (every) {
    const asked = Number(every[1]) * MINUTES[every[2]];
    if (!asked) return { problem: `"Every ${every[1]} ${every[2]}" is no time at all. Say how often, like "every 30 minutes".` };
    const minutes = Math.max(asked, FLOOR);
    return nothingLeft({ every: 'minutes', minutes }, asked < FLOOR ? `Anything quicker than every ${FLOOR} minutes would use up the free models in an afternoon, so this is every ${FLOOR} minutes.` : undefined);
  }

  // The time of day, tried from the most certain way of writing it to the least.
  let when = '';
  if (take(/\b(noon|midday)\b/)) when = '12:00';
  else if (take(/\bmidnight\b/)) when = '00:00';
  else {
    const found = take(CLOCK) ?? take(HOUR) ?? take(BARE_HOUR);
    if (found) {
      const half = found[3] ?? (found[2] === 'am' || found[2] === 'pm' ? found[2] : '');
      const hour = half ? hours12(Number(found[1]), half) : Number(found[1]);
      const minutes = /^\d{2}$/.test(found[2] ?? '') ? Number(found[2]) : 0;
      if (hour > 23 || (half && Number(found[1]) > 12) || minutes > 59) return { problem: `There is no ${found[0].trim()} on a clock. Say it like "9am" or "14:30".` };
      when = clock(hour, minutes);
    }
  }

  const weekdays = !!take(/\bweekdays?\b/);
  const weekends = !!take(/\bweekends?\b/);
  const named: number[] = [];
  for (const word of rest.match(/\b[a-z]+\b/g) ?? []) {
    const day = dayOf(word);
    if (day !== undefined) { named.push(day); rest = rest.replace(new RegExp(`\\b${word}\\b`, 'g'), ' '); }
  }
  const daily = !!take(/\b(every ?day|daily|each day)\b/);
  if (!when) {
    const over = left();
    return { problem: over ? `I did not understand "${over}". ${HELP}` : `Say what time as well. ${HELP}` };
  }

  const days = [...new Set([...named, ...(weekdays ? [1, 2, 3, 4, 5] : []), ...(weekends ? [0, 6] : [])])].sort();
  // "Every day" and "weekdays" keep the shapes they have always been saved in, so a board file written last week
  // still reads the same and the founder's old dropdown choices come back untouched.
  if (daily || (!days.length && !weekdays && !weekends)) return nothingLeft({ every: 'day', time: when });
  if (days.length === 5 && days.every((day) => day >= 1 && day <= 5)) return nothingLeft({ every: 'weekdays', time: when });
  if (days.length === 1) return nothingLeft({ every: 'week', time: when, weekday: days[0] });
  return nothingLeft({ every: 'days', time: when, weekdays: days });
}
