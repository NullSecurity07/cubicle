import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { body, json, type Route } from './http.ts';
import { clockOffset, moveClock, now } from './clock.ts';

// The test-only clock offset: a check run moves "now" forward a day to see the morning note fire unasked, and the
// founder's own run never can. It is allowed only on a fake-model run or in a workspace marked as a check workspace,
// and never in the founder's own workspace whatever else is said, so a stray env var or a marker file dropped in the
// real workspace moves nothing.

// A file of this name in a workspace says it was made for a check (a journey on a real model, say).
export const CHECK_MARK = '.check-workspace';
const DAY = 86_400_000;
// A check moves the clock by days, not years: anything further is a mistake, not a test.
const MOST = 400 * DAY;

export type ClockPlace = { fake: boolean; workspace: string; founderWorkspace: string };

// Why the clock may not be moved here, or null when it may.
export function clockRefusal(place: ClockPlace): string | null {
  if (resolve(place.workspace) === resolve(place.founderWorkspace)) return 'The clock is never moved in your own workspace: the offset is for check runs only.';
  if (!place.fake && !existsSync(resolve(place.workspace, CHECK_MARK))) return 'The clock moves only on a check run: a fake-model run, or a workspace marked as a check workspace.';
  return null;
}

// At start: STAGE_CLOCK_OFFSET_MS moves the clock when this run is allowed to, and is said and ignored when not.
export function armClock(place: ClockPlace, env: NodeJS.ProcessEnv = process.env, say: (line: string) => void = console.error): number {
  const asked = env.STAGE_CLOCK_OFFSET_MS;
  if (asked === undefined || asked === '') return clockOffset();
  const ms = Number(asked);
  const refused = clockRefusal(place) ?? (!Number.isFinite(ms) || Math.abs(ms) > MOST ? 'STAGE_CLOCK_OFFSET_MS is not a number of milliseconds within a year.' : null);
  if (refused) { say(`clock: STAGE_CLOCK_OFFSET_MS ignored. ${refused}`); return clockOffset(); }
  moveClock(ms);
  say(`clock: moved ${ms} ms for this check run`);
  return clockOffset();
}

// GET /api/clock says what "now" is and by how much it is moved. POST /api/clock/offset { ms, tick } sets the offset
// (the whole of it, not a step) and, with `tick`, runs the half-minute tick at once so the check sees what the new day
// brings without waiting for it.
export function clockRoutes(place: ClockPlace & { tick: () => Promise<void> }): Route {
  return async (req, res, path) => {
    if (path === '/api/clock' && req.method === 'GET') { json(res, 200, { now: now(), offset: clockOffset() }); return true; }
    if (path !== '/api/clock/offset' || req.method !== 'POST') return false;
    const refused = clockRefusal(place);
    if (refused) { json(res, 403, { error: refused }); return true; }
    const sent = (await body(req).catch(() => ({}))) as { ms?: unknown; tick?: unknown };
    const ms = Number(sent.ms ?? 0);
    if (!Number.isFinite(ms) || Math.abs(ms) > MOST) { json(res, 400, { error: '"ms" is a number of milliseconds within a year' }); return true; }
    moveClock(ms);
    if (sent.tick === true) await place.tick();
    json(res, 200, { now: now(), offset: clockOffset() });
    return true;
  };
}
