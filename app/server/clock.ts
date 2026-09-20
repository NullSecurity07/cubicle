// One place that puts a moment into words, so a person, a note and a folded summary all say the day the same way.
// Every caller takes the moment as a number, because nothing here may read the clock behind a test's back.
const FULL = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const SHORT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export const fullDay = (at: number) => FULL.format(new Date(at));
export const weekDay = (at: number) => WEEKDAY.format(new Date(at));
export const shortDay = (at: number) => SHORT.format(new Date(at));
// The machine's own zone, which is the founder's: a date without it is a date in somebody else's day.
export const zoneName = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
// The calendar day a moment falls on where the founder is, as a key two moments can be compared by.
export const dayKey = (at: number) => new Date(at).toDateString();
