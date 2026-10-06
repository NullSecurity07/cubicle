import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { armClock, CHECK_MARK, clockRefusal, clockRoutes } from './clock-offset.ts';
import { clockOffset, localDay, moveClock, now } from './clock.ts';
import { promisesBook } from './partner/promises.ts';

const DAY = 86_400_000;
const founderWorkspace = '/home/founder/cublicle/workspace';

async function serve(place: Parameters<typeof clockRoutes>[0]) {
  const route = clockRoutes(place);
  const server: Server = createServer(async (req, res) => { const url = new URL(req.url ?? '/', 'http://x'); if (!await route(req, res, url.pathname, url)) { res.writeHead(404); res.end(); } });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((done) => server.close(() => done())) };
}

afterEach(() => moveClock(0));

describe('one "now" for every date-based check', () => {
  it('is the machine clock until a check moves it, and moved by exactly the offset after', () => {
    expect(clockOffset()).toBe(0);
    expect(Math.abs(now() - Date.now())).toBeLessThan(50);
    moveClock(DAY);
    expect(Math.abs(now() - (Date.now() + DAY))).toBeLessThan(50);
  });

  it('is the clock the promises book keeps by when none is handed in', async () => {
    moveClock(2 * DAY);
    const made = await promisesBook(await mkdtemp(join(tmpdir(), 'clock-promises-'))).add({ what: 'call 5 beta users', due: '2099-01-01' });
    expect(made!.said).toBe(localDay(Date.now() + 2 * DAY));
  });
});

describe('the offset is never active on the founder\'s real run', () => {
  it('refuses a real-model run in a workspace not marked as a check workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'clock-real-'));
    expect(clockRefusal({ fake: false, workspace, founderWorkspace })).toMatch(/only on a check run/);
  });

  it('refuses the founder\'s own workspace even on a fake run or with the mark in it', () => {
    expect(clockRefusal({ fake: true, workspace: founderWorkspace, founderWorkspace })).toMatch(/never moved in your own workspace/);
    expect(clockRefusal({ fake: false, workspace: `${founderWorkspace}/`, founderWorkspace })).toMatch(/never moved in your own workspace/);
  });

  it('allows a fake-model run and a marked check workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'clock-check-'));
    expect(clockRefusal({ fake: true, workspace, founderWorkspace })).toBeNull();
    await writeFile(join(workspace, CHECK_MARK), '');
    expect(clockRefusal({ fake: false, workspace, founderWorkspace })).toBeNull();
  });

  it('ignores STAGE_CLOCK_OFFSET_MS on a real run and says so, and honours it on a check run', async () => {
    const said: string[] = [];
    const real = await mkdtemp(join(tmpdir(), 'clock-real-'));
    expect(armClock({ fake: false, workspace: real, founderWorkspace }, { STAGE_CLOCK_OFFSET_MS: String(DAY) }, (line) => said.push(line))).toBe(0);
    expect(armClock({ fake: true, workspace: founderWorkspace, founderWorkspace }, { STAGE_CLOCK_OFFSET_MS: String(DAY) }, (line) => said.push(line))).toBe(0);
    expect(clockOffset()).toBe(0);
    expect(said.every((line) => line.startsWith('clock: STAGE_CLOCK_OFFSET_MS ignored.'))).toBe(true);
    expect(armClock({ fake: true, workspace: real, founderWorkspace }, { STAGE_CLOCK_OFFSET_MS: 'soon' }, () => {})).toBe(0);
    expect(armClock({ fake: true, workspace: real, founderWorkspace }, { STAGE_CLOCK_OFFSET_MS: String(DAY) }, () => {})).toBe(DAY);
  });

  it('answers POST /api/clock/offset with 403 on a real run, moving nothing and ticking nothing', async () => {
    let ticks = 0;
    const workspace = await mkdtemp(join(tmpdir(), 'clock-real-'));
    const server = await serve({ fake: false, workspace, founderWorkspace, tick: async () => { ticks += 1; } });
    try {
      const refused = await fetch(`${server.url}/api/clock/offset`, { method: 'POST', body: JSON.stringify({ ms: DAY, tick: true }) });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toMatch(/only on a check run/);
      expect(clockOffset()).toBe(0);
      expect(ticks).toBe(0);
    } finally { await server.close(); }
  });

  it('moves the clock and ticks once on a check run, and says where now is', async () => {
    let ticks = 0;
    const server = await serve({ fake: true, workspace: await mkdtemp(join(tmpdir(), 'clock-check-')), founderWorkspace, tick: async () => { ticks += 1; } });
    try {
      const moved = (await (await fetch(`${server.url}/api/clock/offset`, { method: 'POST', body: JSON.stringify({ ms: DAY, tick: true }) })).json()) as { offset: number; now: number };
      expect(moved.offset).toBe(DAY);
      expect(ticks).toBe(1);
      const read = (await (await fetch(`${server.url}/api/clock`)).json()) as { offset: number; now: number };
      expect(read.offset).toBe(DAY);
      expect((await fetch(`${server.url}/api/clock/offset`, { method: 'POST', body: JSON.stringify({ ms: 9e12 }) })).status).toBe(400);
    } finally { await server.close(); }
  });
});
