import { describe, expect, it } from 'vitest';
import { catchUp, cleanRepeat, FLOOR, missedDefault, nextDue, parseSchedule, sayRepeat } from '../../shared/automation.ts';
import type { Repeat } from '../../shared/model.ts';

// The schedule reader is shared with the founder's window, so it lives in `shared/`; the checks live here because
// this is where vitest looks. Every time below is this machine's own, the way the board's clock is.
const local = (text: string) => new Date(text).getTime();
const SATURDAY = local('2026-09-19T08:00');
const read = (text: string, now = SATURDAY) => parseSchedule(text, now);
const repeatOf = (text: string, now = SATURDAY) => { const said = read(text, now); return 'repeat' in said ? said.repeat : said.problem; };

describe('schedules in words', () => {
  it('reads every phrase the field offers', () => {
    const cases: [string, Repeat][] = [
      ['every 30m', { every: 'minutes', minutes: 30 }],
      ['every 30 minutes', { every: 'minutes', minutes: 30 }],
      ['every 6h', { every: 'minutes', minutes: 360 }],
      ['every 2 days', { every: 'minutes', minutes: 2880 }],
      ['daily at 8am', { every: 'day', time: '08:00' }],
      ['every day at noon', { every: 'day', time: '12:00' }],
      ['each day at midnight', { every: 'day', time: '00:00' }],
      ['at 8pm', { every: 'day', time: '20:00' }],
      ['weekdays at 9', { every: 'weekdays', time: '09:00' }],
      ['every weekday at 07:45', { every: 'weekdays', time: '07:45' }],
      ['mondays 14:30', { every: 'week', time: '14:30', weekday: 1 }],
      ['monday at 9am', { every: 'week', time: '09:00', weekday: 1 }],
      ['every thursday at 5pm', { every: 'week', time: '17:00', weekday: 4 }],
      ['mon, wed and fri at 10', { every: 'days', time: '10:00', weekdays: [1, 3, 5] }],
      ['sat and sun at 11:15', { every: 'days', time: '11:15', weekdays: [0, 6] }],
      ['weekends at 11', { every: 'days', time: '11:00', weekdays: [0, 6] }],
      // Five named weekdays are the shape that was already on disk before any of this, not a list of five.
      ['mon tue wed thu fri at 7', { every: 'weekdays', time: '07:00' }],
      ['12am daily', { every: 'day', time: '00:00' }],
      ['12pm daily', { every: 'day', time: '12:00' }],
    ];
    for (const [words, repeat] of cases) expect(repeatOf(words), words).toEqual(repeat);
  });

  it('answers with the next moment it lands on, in this machine\'s own time', () => {
    expect(read('weekdays at 9')).toMatchObject({ next: local('2026-09-21T09:00'), words: 'weekdays 09:00' });
    expect(read('every day at 9am')).toMatchObject({ next: local('2026-09-19T09:00') });
    expect(read('mondays 14:30')).toMatchObject({ next: local('2026-09-21T14:30'), words: 'Mon 14:30' });
    expect(read('every 30m')).toMatchObject({ next: SATURDAY + 30 * 60_000, words: 'every 30 minutes' });
  });

  it('runs a one-off once and then stops', () => {
    const said = read('in 2h');
    expect(said).toMatchObject({ repeat: { every: 'once', at: SATURDAY + 7_200_000 }, next: SATURDAY + 7_200_000 });
    expect('note' in said && said.note).toContain('once');
    expect(repeatOf('in 90 minutes')).toEqual({ every: 'once', at: SATURDAY + 90 * 60_000 });
    // Nothing comes after a one-off, and 0 is what every caller already reads as no next run.
    expect(nextDue({ every: 'once', at: SATURDAY }, SATURDAY + 1)).toBe(0);
  });

  it('will not run quicker than the free models can stand, and says so', () => {
    const said = read('every 2m');
    expect(said).toMatchObject({ repeat: { every: 'minutes', minutes: FLOOR } });
    expect('note' in said && said.note).toContain(`every ${FLOOR} minutes`);
    expect(repeatOf('every 15 minutes')).toEqual({ every: 'minutes', minutes: 15 });
  });

  it('says what it did not understand, in words the founder can do something about', () => {
    expect(repeatOf('')).toContain('Say when it should run');
    expect(repeatOf('blorp')).toContain('I did not understand "blorp"');
    expect(repeatOf('every fortnight')).toContain('fortnight');
    expect(repeatOf('mondays')).toContain('Say what time as well');
    expect(repeatOf('at 25:00')).toContain('no 25:00 on a clock');
    expect(repeatOf('at 13pm')).toContain('no 13pm on a clock');
    expect(repeatOf('every 0 minutes')).toContain('no time at all');
    // Every refusal offers the way out, so nobody is left guessing at the shape of a sentence.
    expect(repeatOf('blorp')).toContain('every day at 9am');
  });

  it('reads back what it wrote', () => {
    for (const words of ['every day 09:00', 'weekdays 09:00', 'Mon 14:30', 'Mon, Wed, Fri 10:00', 'every 30 minutes', 'every 2 hours']) {
      const repeat = repeatOf(words);
      expect(typeof repeat === 'string' ? repeat : sayRepeat(repeat), words).toBe(words);
    }
    expect(sayRepeat({ every: 'minutes', minutes: 60 })).toBe('every 1 hour');
    expect(sayRepeat({ every: 'once', at: 1 })).toBe('once');
    expect(sayRepeat()).toBe('');
  });
});

describe('what a repeat means in time', () => {
  it('finds the next slot for the shapes that were saved before words were allowed, and for the new ones', () => {
    expect(nextDue({ every: 'day', time: '09:00' }, local('2026-09-19T09:00'))).toBe(local('2026-09-20T09:00'));
    expect(nextDue({ every: 'weekdays', time: '09:00' }, SATURDAY)).toBe(local('2026-09-21T09:00'));
    expect(nextDue({ every: 'week', time: '18:30', weekday: 3 }, SATURDAY)).toBe(local('2026-09-23T18:30'));
    expect(nextDue({ every: 'days', time: '10:00', weekdays: [1, 3, 5] }, SATURDAY)).toBe(local('2026-09-21T10:00'));
    expect(nextDue({ every: 'minutes', minutes: 45 }, SATURDAY)).toBe(SATURDAY + 45 * 60_000);
  });

  it('accepts only a well-formed repeat, whichever shape it is in', () => {
    expect(cleanRepeat({ every: 'week', time: '07:05' })).toEqual({ every: 'week', time: '07:05', weekday: 1 });
    expect(cleanRepeat({ every: 'day', time: '9:00' })).toBeUndefined();
    expect(cleanRepeat({ every: 'hourly', time: '09:00' })).toBeUndefined();
    expect(cleanRepeat({ every: 'days', time: '10:00', weekdays: [3, 1, 3, 9] })).toEqual({ every: 'days', time: '10:00', weekdays: [1, 3] });
    expect(cleanRepeat({ every: 'days', time: '10:00', weekdays: [] })).toBeUndefined();
    expect(cleanRepeat({ every: 'minutes', minutes: 3 })).toEqual({ every: 'minutes', minutes: FLOOR });
    expect(cleanRepeat({ every: 'minutes', minutes: 'soon' })).toBeUndefined();
    expect(cleanRepeat({ every: 'once', at: 1758268800000 })).toEqual({ every: 'once', at: 1758268800000 });
    expect(cleanRepeat(null)).toBeUndefined();
  });

  it('catches a missed run up once when the schedule is slow, and lets a quick one go', () => {
    expect(missedDefault({ every: 'day', time: '09:00' })).toBe('once');
    expect(missedDefault({ every: 'minutes', minutes: 30 })).toBe('skip');
    expect(missedDefault({ every: 'minutes', minutes: 1440 })).toBe('once');
    expect(catchUp({ every: 'minutes', minutes: 30 }, 'once')).toBe(true);
    expect(catchUp({ every: 'day', time: '09:00' }, 'skip')).toBe(false);
    expect(catchUp(undefined)).toBe(false);
  });
});
