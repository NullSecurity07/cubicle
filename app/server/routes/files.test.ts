import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStore } from '../store.ts';
import { fileRoutes } from './files.ts';

let server: Server;
let base = '';
const film = Buffer.from(Array.from({ length: 1000 }, (_, at) => at % 256));

beforeAll(async () => {
  const store = createStore(await mkdtemp(join(tmpdir(), 'files-route-')));
  await store.saveFileBytes('media/film.mp4', film);
  await store.saveFileBytes('notes/page.html', Buffer.from('<script>alert(1)</script>'));
  await store.saveFileBytes('media/film.credits.txt', Buffer.from('"Stalls" by Someone · CC0 · Wikimedia Commons — https://commons.wikimedia.org/x\n', 'utf8'));
  const route = fileRoutes({ store });
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!(await route(req, res, url.pathname, url))) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('/api/files', () => {
  it('serves the whole file with its type and length', async () => {
    const res = await fetch(`${base}/api/files/media/film.mp4`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe('1000');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await res.arrayBuffer()).equals(film)).toBe(true);
  });

  it('serves only the piece a player asked for', async () => {
    const res = await fetch(`${base}/api/files/media/film.mp4`, { headers: { range: 'bytes=100-199' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(res.headers.get('content-length')).toBe('100');
    expect(Buffer.from(await res.arrayBuffer()).equals(film.subarray(100, 200))).toBe(true);
    const tail = await fetch(`${base}/api/files/media/film.mp4`, { headers: { range: 'bytes=-10' } });
    expect(tail.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect(Buffer.from(await tail.arrayBuffer()).equals(film.subarray(990))).toBe(true);
  });

  it('refuses a range outside the file, and a file that is not there', async () => {
    const bad = await fetch(`${base}/api/files/media/film.mp4`, { headers: { range: 'bytes=2000-' } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */1000');
    expect((await fetch(`${base}/api/files/media/none.mp4`)).status).toBe(404);
    expect((await fetch(`${base}/api/files/..%2Fstage.json`)).status).toBe(404);
    expect((await fetch(`${base}/api/files/media`)).status).toBe(404);
  });

  it('never serves a page somebody made as a page', async () => {
    const res = await fetch(`${base}/api/files/notes/page.html`);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
  });

  // Journey 13: a film's credits file showed "Â·" and "â€”", because text went out with no charset.
  it('says text is UTF-8, so a credits line reads as written', async () => {
    const res = await fetch(`${base}/api/files/media/film.credits.txt`);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe('"Stalls" by Someone · CC0 · Wikimedia Commons — https://commons.wikimedia.org/x\n');
    expect((await fetch(`${base}/api/files/media/film.mp4`)).headers.get('content-type')).toBe('video/mp4');
  });

  it('takes an upload and says where it went', async () => {
    const res = await fetch(`${base}/api/files?name=${encodeURIComponent('My notes.md')}`, { method: 'POST', body: 'hello' });
    const saved = await res.json() as { path: string; type: string; size: number };
    expect(saved).toMatchObject({ type: 'text/markdown', size: 5 });
    expect(saved.path).toMatch(/^uploads\/[a-z0-9]+-My-notes\.md$/);
    expect(await (await fetch(`${base}/api/files/${saved.path}`)).text()).toBe('hello');
  });
});
