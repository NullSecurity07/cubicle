import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { TEXT_FILE } from './gather.ts';

// The small pieces every route shares: answering in JSON, reading what was sent, opening a live feed, and naming
// what kind of file a name is. Slices are handed the same `json` and `body`, so a slice answers the way the app does.

// One path answered, or not: a route tries its own paths and says true when it has sent the answer, false to let the
// next one try. The URL is parsed once per request and handed round, so nobody parses it again for a search param.
export type Route = (req: IncomingMessage, res: ServerResponse, path: string, url: URL) => Promise<boolean>;

export const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function body(req: IncomingMessage): Promise<any> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 2_000_000) throw new Error('body too large');
  }
  return text ? JSON.parse(text) : {};
}

// A chat attachment is read into memory, so it stays small; a piece of footage is written straight to disk as it
// arrives, so it can be as big as a phone makes them.
export const UPLOAD_LIMIT = 300_000_000;

export async function raw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error(`file too large (limit ${Math.round(limit / 1_000_000)} MB)`); chunks.push(chunk as Buffer); }
  return Buffer.concat(chunks);
}

// A feed that has gone quiet and a feed that has died look exactly the same from the other end: when this server
// restarts, or a laptop sleeps, whatever sits between (Vite's proxy, the shell's web view) can keep the window's half of
// the connection open and say nothing. So every feed says "still here" four times a minute, and a window that hears
// nothing for a while knows to open it again. A named event, so it never reaches a handler that expects real news.
const PULSE = 15_000;
export const pulse = (res: ServerResponse) => {
  const beat = setInterval(() => { if (!res.writableEnded) res.write('event: pulse\ndata: 1\n\n'); }, PULSE);
  beat.unref();
  res.on('close', () => clearInterval(beat));
};

// A live feed opened: the event-stream header, and the pulse that keeps it honest.
export const openFeed = (res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  pulse(res);
};

// Every kind of file this app names, in one table: what the founder and the people share, and the app's own client.
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4',
  pdf: 'application/pdf', csv: 'text/csv', json: 'application/json', md: 'text/markdown',
  html: 'text/html', js: 'text/javascript', css: 'text/css', woff2: 'font/woff2',
};
// A page, a script or a style sheet is only ever the app's own. One a person or a page produced is served as the
// plain text it is, so nothing anybody made can be taken for part of this app.
const OWN_ONLY = new Set(['html', 'js', 'css']);
const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

// A shared file: known kinds by name, other text as plain text, anything else as bytes.
export const typeOf = (name: string) => (!OWN_ONLY.has(extOf(name)) && MIME[extOf(name)]) || (TEXT_FILE.test(name) ? 'text/plain' : 'application/octet-stream');
// A file of the built client.
export const staticType = (path: string) => MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream';
