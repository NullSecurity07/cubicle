import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Card, Stage } from '../../shared/model.ts';
import { createApprovals } from '../approvals.ts';
import { createStore } from '../store.ts';
import { stageRoutes } from './stage.ts';

describe('PUT /api/stage', () => {
  it('closes a Chrome session only for a browser or source card that left, and keeps a doc the server just made', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'stage-route-')));
    const closed: string[] = [];
    const route = stageRoutes({ store, events: { restage: () => {}, join: async () => () => {} } as never, browser: { close: async (session: string) => { closed.push(session); } } as never, attention: { refresh: async () => {} }, approvals: createApprovals() });
    const server = createServer(async (req, res) => { const url = new URL(req.url ?? '/', 'http://x'); if (!(await route(req, res, url.pathname, url))) { res.writeHead(404); res.end(); } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const put = (stage: Stage) => fetch(`${base}/api/stage`, { method: 'PUT', body: JSON.stringify(stage) });
    const box = { x: 0, y: 0, w: 300, h: 200 };
    const cards = [{ id: 'web', kind: 'browser', ...box }, { id: 'site', kind: 'source', url: 'https://a.test', ...box }, { id: 'note', kind: 'note', text: '', ...box }] as Card[];
    const seen = { ...(await store.loadStage()), cards };
    await put(seen);
    // A person made a doc while this window was looking elsewhere.
    await store.patchStage((stage) => { stage.docs.push({ id: 'doc-made', title: 'Made', x: 900, y: 0, w: 340, h: 300 }); });
    expect((await put({ ...seen, cards: [] })).status).toBe(200);
    expect(closed.sort()).toEqual(['card-site', 'card-web']);
    expect((await store.loadStage()).docs.map((one) => one.id)).toContain('doc-made');
    server.close();
  });

  it('answers a save made over an older stage with 409 and the stage as it is, and a fresh one with the next revision', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'stage-route-')));
    const route = stageRoutes({ store, events: { restage: () => {}, join: async () => () => {} } as never, browser: { close: async () => {} } as never, attention: { refresh: async () => {} }, approvals: createApprovals() });
    const server = createServer(async (req, res) => { const url = new URL(req.url ?? '/', 'http://x'); if (!(await route(req, res, url.pathname, url))) { res.writeHead(404); res.end(); } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const put = (stage: Stage, rev?: string) => fetch(`${base}/api/stage`, { method: 'PUT', body: JSON.stringify(stage), headers: rev === undefined ? {} : { 'if-match': rev } });
    const got = await fetch(`${base}/api/stage`);
    // The revision rides in the headers: the stage a script reads is plain data it can put back as it is.
    expect(got.headers.get('etag')).toBe('"0"');
    const seen = (await got.json()) as Stage;
    expect(seen.rev).toBeUndefined();
    const fresh = await put({ ...seen, rooms: seen.rooms.map((room) => ({ ...room, x: room.x + 10 })) }, '"0"');
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toEqual({ ok: true, rev: 1 });
    // Another window, still on revision 0, tries to take every person away.
    const stale = await put({ ...seen, rooms: [] }, '"0"');
    expect(stale.status).toBe(409);
    const said = (await stale.json()) as { stage: Stage; rev: number };
    expect(said.rev).toBe(1);
    expect(said.stage.rooms).toHaveLength(seen.rooms.length);
    expect((await store.loadStage()).rooms).toHaveLength(seen.rooms.length);
    // A script that puts back what it read, revision number in the body or not, is never refused.
    expect((await put({ ...seen, rev: 0 })).status).toBe(200);
    expect((await put({ ...seen, rev: null } as unknown as Stage)).status).toBe(200);
    expect((await put(seen, 'nonsense')).status).toBe(200);
    expect((await fetch(`${base}/api/stage`)).headers.get('etag')).toBe('"4"');
    server.close();
  });
});
