import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { ChatEvent, Stage } from '../shared/model.ts';
import { buildMessages, wiredDocIds } from './prompt.ts';
import { fakeClient, realClients, streamReply } from './providers.ts';
import { createStore } from './store.ts';

const root = resolve(import.meta.dirname, '../..');
try { process.loadEnvFile(resolve(root, '.env')); } catch { /* no .env: only the fake model will work */ }

const port = Number(process.env.STAGE_API_PORT ?? 7421);
const store = createStore(process.env.STAGE_WORKSPACE ?? resolve(root, 'workspace'));
const clients = process.env.STAGE_FAKE_MODEL === '1' ? [fakeClient] : realClients();
const busy = new Set<string>();

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function body(req: IncomingMessage): Promise<any> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 2_000_000) throw new Error('body too large');
  }
  return text ? JSON.parse(text) : {};
}

async function chat(roomId: string, text: string, res: ServerResponse) {
  const stage = await store.loadStage();
  if (!stage.rooms.some((room) => room.id === roomId)) return json(res, 404, { error: 'unknown room' });
  if (busy.has(roomId)) return json(res, 409, { error: 'this person is still replying' });
  busy.add(roomId);

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event: ChatEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  try {
    await store.appendChat(roomId, { role: 'user', text, at: Date.now() });
    const docs: Record<string, string> = {};
    for (const id of wiredDocIds(stage, roomId)) docs[id] = await store.readDoc(id);
    const messages = buildMessages(stage, roomId, docs, await store.readChat(roomId));
    const reply = await streamReply(messages, (token) => send({ token }), clients);
    await store.appendChat(roomId, { role: 'assistant', text: reply.text, at: Date.now(), provider: reply.provider });
    send({ done: true, provider: reply.provider });
  } catch (error) {
    send({ error: (error as Error).message });
  } finally {
    busy.delete(roomId);
    res.end();
  }
}

createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const doc = /^\/api\/docs\/([^/]+)$/.exec(path)?.[1];
    const room = /^\/api\/rooms\/([^/]+)\/chat$/.exec(path)?.[1];

    if (path === '/api/stage' && req.method === 'GET') return json(res, 200, await store.loadStage());
    if (path === '/api/stage' && req.method === 'PUT') { await store.saveStage((await body(req)) as Stage); return json(res, 200, { ok: true }); }
    if (doc && req.method === 'GET') return json(res, 200, { text: await store.readDoc(doc) });
    if (doc && req.method === 'PUT') { await store.writeDoc(doc, String((await body(req)).text ?? '')); return json(res, 200, { ok: true }); }
    if (room && req.method === 'GET') return json(res, 200, await store.readChat(room));
    if (room && req.method === 'POST') {
      const text = String((await body(req)).text ?? '').trim();
      if (!text) return json(res, 400, { error: 'empty message' });
      return await chat(room, text, res);
    }
    json(res, 404, { error: 'not found' });
  } catch (error) {
    if (!res.headersSent) json(res, 500, { error: (error as Error).message });
    else res.end();
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`stage api on http://127.0.0.1:${port} — models: ${clients.map((client) => client.name).join(', ') || 'NONE (no keys found)'}`);
});
