// One place that puts a moment into words, so a person, a note and a folded summary all say the day the same way.
// Every caller takes the moment as a number, because nothing here may read the clock behind a test's back.
const FULL = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const SHORT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

export const fullDay = (at: number) => FULL.format(new Date(at));
export const weekDay = (at: number) => WEEKDAY.format(new Date(at));
export const shortDay = (at: number) => SHORT.format(new Date(at));
export const clockTime = (at: number) => TIME.format(new Date(at));
// The machine's own zone, which is the founder's: a date without it is a date in somebody else's day.
export const zoneName = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
// The calendar day a moment falls on where the founder is, as a key two moments can be compared by.
export const dayKey = (at: number) => new Date(at).toDateString();
// When something happened, said the way the founder would say it: today by the clock, any other day by its name.
// A backlog that arrives after a day away is unreadable without this — everything in it sounds like it just happened.
export const timeOrDay = (at: number, now: number) => (dayKey(at) === dayKey(now) ? `at ${clockTime(at)}` : `on ${weekDay(at)}`);

// A day as the founder's calendar names it, YYYY-MM-DD in local time: what a file is named by and a review falls due on.
export const localDay = (at: number) => { const day = new Date(at); return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`; };
// The front of a name in trash: when it was let go of, to the millisecond, in characters every file system takes.
export const trashStamp = (at: number = Date.now()) => new Date(at).toISOString().replace(/[:.]/g, '-');

// ---------------------------------------------------------------- the one "now"

// Every date-based check (the morning note, late promises, bets, lead nudges, the phone's digest, Today's five) asks
// this for the moment, never Date.now itself, so a check run can live "day 2" without waiting a day. The offset is
// zero on the founder's own run and can only be moved through `server/clock-offset.ts`, which refuses it there.
let offset = 0;
export const now = () => Date.now() + offset;
export const clockOffset = () => offset;
// Only `server/clock-offset.ts` calls this, after it has said yes; tests call it to put the clock back.
export function moveClock(ms: number) { offset = Number.isFinite(ms) ? Math.round(ms) : 0; }
