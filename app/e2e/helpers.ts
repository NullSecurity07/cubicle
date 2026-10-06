import { expect, type Page } from '@playwright/test';

// Helpers more than one check can use.
//
// The clock: the server's one "now" (server/clock.ts) can be moved on a check run, never on the founder's own
// (server/clock-offset.ts refuses it there). `advanceDay(page, 1)` puts the server at 06:30 tomorrow and runs the
// half-minute tick at once, so a check lives "day 2" (the morning note, late promises, bets, lead nudges) without
// waiting. `tick(page)` runs the tick again where the clock stands. `resetClock(page)` puts it back; call it in an
// afterEach so no later check starts on a moved day.

type Clock = { now: number; offset: number };
const clockOf = async (page: Page) => (await (await page.request.get('/api/clock')).json()) as Clock;

async function setOffset(page: Page, ms: number, tick: boolean) {
  const moved = await page.request.post('/api/clock/offset', { data: { ms, tick } });
  expect(moved.ok(), await moved.text()).toBe(true);
  return (await moved.json()) as Clock;
}

// Forward `days` days, to `at` (HH:MM, the founder's own clock) on that day, then one tick.
export async function advanceDay(page: Page, days: number, at = '06:30'): Promise<Clock> {
  const clock = await clockOf(page);
  const target = new Date(clock.now);
  target.setDate(target.getDate() + days);
  const [hours, minutes] = at.split(':').map(Number);
  target.setHours(hours, minutes, 0, 0);
  return setOffset(page, clock.offset + (target.getTime() - clock.now), true);
}

export const tick = async (page: Page) => setOffset(page, (await clockOf(page)).offset, true);
export const resetClock = async (page: Page) => setOffset(page, 0, false);
