import { pipeline } from 'node:stream/promises';
import { answer, raw, servedType, typeOf, type Route } from '../http.ts';
import { rangeOf } from '../static.ts';
import type { Store } from '../store.ts';

// The shared files: a file dropped into a chat comes in here, and everything in the folder goes out from here, to a
// chat, a picture card or a player.
export function fileRoutes(deps: { store: Store }): Route {
  const { store } = deps;
  return async (req, res, path, url) => {
    if (path === '/api/files' && req.method === 'POST') {
      const name = url.searchParams.get('name') ?? 'file';
      const data = await raw(req, 15_000_000);
      const saved = await store.saveUpload(name, data);
      return answer(res, 200, { path: saved, type: typeOf(saved), size: data.length });
    }
    if (path.startsWith('/api/files/') && req.method === 'GET') {
      const name = decodeURIComponent(path.slice('/api/files/'.length));
      const size = await store.fileSize(name);
      if (size === null) return answer(res, 404, { error: 'no such file' });
      // Files may hold anything a person or a page produced: never let one run as a page of this app.
      const headers = { 'content-type': servedType(name), 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache', 'accept-ranges': 'bytes' };
      // A player asks for a piece at a time, and will not play or seek a sound or a video that answers with the lot.
      // Only the piece asked for is read off the disk: seeking in a long film is not the whole film read again.
      const piece = rangeOf(Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range, size);
      if (piece === 'bad') { res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` }); res.end(); return true; }
      if (piece) res.writeHead(206, { ...headers, 'content-range': `bytes ${piece.from}-${piece.to}/${size}`, 'content-length': String(piece.to - piece.from + 1) });
      else res.writeHead(200, { ...headers, 'content-length': String(size) });
      // A file taken away mid-read, or a player that stopped listening, ends this answer and nothing else.
      await pipeline(store.fileStream(name, piece ?? undefined), res).catch(() => { if (!res.destroyed) res.destroy(); });
      return true;
    }
    return false;
  };
}
