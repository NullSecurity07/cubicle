import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { isHeaded, newMessageId, type Attachment, type ChatEvent, type Stage } from '../shared/model.ts';
import { createApprovals } from './approvals.ts';
import { createBoards } from './boards.ts';
import { fakeCoder, opencodeCoder } from './coder.ts';
import { guard } from './guard.ts';
import { createBrowser, dnsResolve, fakeRunner, jinaReader, realRunner } from './browser.ts';
import { archiveCopy, redditFeed, stackExchange } from './readers.ts';
import { runTurn } from './loop.ts';
import { createMail, fakeMailHttp } from './mail.ts';
import { createMemory } from './memory.ts';
import { recent } from './memory.ts';
import { buildMessages, colleagueIds, readableDocIds, wired, type Attached } from './prompt.ts';
import { complete, fakeClient, promptSize, realClients } from './providers.ts';
import { route } from './router.ts';
import { createRuns, desktopNotify } from './runs.ts';
import { readStatic } from './static.ts';
import { createStore } from './store.ts';
import { docTools } from './tools/docs.ts';
import { fileTools } from './tools/files.ts';
import { outwardTools } from './tools/outward.ts';
import { projectTools } from './tools/project.ts';
import { memoryTools } from './tools/remember.ts';
import { taskTools } from './tools/tasks.ts';
import { teamTools, type Consult } from './tools/team.ts';
import { browserSession, webTools } from './tools/web.ts';
import { createUsage } from './usage.ts';

const root = resolve(import.meta.dirname, '../..');
try { process.loadEnvFile(resolve(root, '.env')); } catch { /* no .env: only the fake model will work */ }

const port = Number(process.env.STAGE_API_PORT ?? 7421);
const fake = process.env.STAGE_FAKE_MODEL === '1';
// Who may use the api: the app's own page (here, or on Vite's port in development) and scripts that hold this launch's token.
const own = { ports: [port, Number(process.env.STAGE_PORT ?? 7420)], token: process.env.STAGE_API_TOKEN || randomBytes(24).toString('base64url') };
const clients = fake ? [fakeClient] : realClients();
const busy = new Set<string>();
const workspace = process.env.STAGE_WORKSPACE ?? resolve(root, 'workspace');
const store = createStore(workspace);
const usage = createUsage(resolve(workspace, 'usage.json'));
await usage.load();
const browser = fake ? createBrowser(fakeRunner) : createBrowser(realRunner(), { direct: [redditFeed(), stackExchange()], fallback: process.env.STAGE_NO_READER === '1' ? [] : [jinaReader, archiveCopy()] }, dnsResolve);
const approvals = createApprovals();
// Summaries go to a model with room to spare: the last configured providers are the large free ones.
const memory = createMemory(store, async (messages) => {
  const { order } = route([...clients].reverse(), usage, { promptChars: promptSize(messages), tools: false });
  const reply = await complete(messages, { onToken: () => {} }, order);
  usage.record(reply.client.name, reply.usage, reply.quota);
  return reply.text;
});
const boards = createBoards(workspace);

// What one person's turn is built from: their readable docs, their own history, and the recent talk of wired colleagues.
async function promptFor(stage: Stage, roomId: string, toolNames: string[], fresh = false) {
  const docs: Record<string, string> = {};
  for (const id of readableDocIds(stage, roomId)) docs[id] = await store.readDoc(id);
  const colleagues: Record<string, Awaited<ReturnType<typeof store.readChat>>> = {};
  for (const id of colleagueIds(stage, roomId)) colleagues[id] = await store.readChat(id);
  // A board task starts from a clean slate: the person, their documents and colleagues, not their chat.
  // Link cards wired to this person: the page text, read once and kept until the address changes.
  const pages: Record<string, { title: string; text: string }> = {};
  const mine = new Set(wired(stage, roomId, (stage.cards ?? []).map((card) => card.id)));
  for (const card of stage.cards ?? []) {
    if (card.kind !== 'link' || !card.url || !mine.has(card.id)) continue;
    let page = await store.readPage(card.id);
    if (!page || page.url !== card.url) { page = { url: card.url, ...(await browser.page(card.url).catch((error: Error) => ({ title: card.url, text: `(could not be read: ${error.message})` }))) }; await store.writePage(card.id, page); }
    pages[card.id] = page;
  }
  const messages = buildMessages(stage, roomId, docs, fresh ? [] : await store.readChat(roomId), toolNames, colleagues, await memory.read(roomId), fresh ? undefined : await attachedTo(roomId), pages);
  // Image cards wired to this person ride along with the latest question, for a model that can see.
  const pictures: { name: string; url: string }[] = [];
  for (const card of stage.cards ?? []) {
    if (card.kind !== 'image' || !card.path || !mine.has(card.id)) continue;
    const bytes = await store.readFileBytes(card.path).catch(() => null);
    if (bytes && bytes.length <= 4_000_000) pictures.push({ name: card.path, url: `data:${typeOf(card.path)};base64,${bytes.toString('base64')}` });
  }
  const last = messages.at(-1);
  if (pictures.length && last?.role === 'user') last.images = [...(last.images ?? []), ...pictures.slice(0, 4)];
  return messages;
}

// A consult: the question lands in the colleague's room under the asker's name, they answer once without tools, and both are kept there.
const consult: Consult = async ({ fromRoomId, toRoomId, question, signal }) => {
  const stage = await store.loadStage();
  const asker = stage.rooms.find((room) => room.id === fromRoomId)!;
  const target = stage.rooms.find((room) => room.id === toRoomId)!;
  await store.appendChat(toRoomId, { id: newMessageId(), role: 'user', text: question, at: Date.now(), from: asker.name });
  const messages = await promptFor(stage, toRoomId, []);
  const { order } = route(clients, usage, { pinned: target.model, promptChars: promptSize(messages), tools: false });
  const reply = await complete(messages, { onToken: () => {}, signal }, order);
  usage.record(reply.client.name, reply.usage, reply.quota);
  await store.appendChat(toRoomId, { id: newMessageId(), role: 'assistant', text: reply.text, at: Date.now(), provider: reply.client.name, model: reply.client.model, usage: reply.usage });
  return reply.text;
};
const tools = [...docTools, ...fileTools, ...webTools(browser, (id, headed) => ({ profile: store.browserProfile(id), headed })), ...outwardTools(fake ? createMail({ AGENTMAIL_API_KEY: 'fake' }, fakeMailHttp) : createMail(), store.filesDir), ...projectTools(fake ? fakeCoder : opencodeCoder(), [workspace, root]), ...teamTools(consult), ...taskTools(boards), ...memoryTools(memory)];
const runs = createRuns({ boards, store, tools, clients, usage, approvals, promptFor, busy, notify: fake ? () => {} : desktopNotify });
setInterval(() => { void runs.tick().catch(() => {}); }, 30_000).unref();

// Started by the desktop shell: leave when the shell does, even if it was killed.
if (process.env.STAGE_EXIT_WITH_PARENT === '1') {
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
}

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

const TEXT_FILE = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|sh|sql|log|ini|toml|env)$/i;
const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;
const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf', csv: 'text/csv', json: 'application/json', md: 'text/markdown' };
const typeOf = (name: string) => TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? (TEXT_FILE.test(name) ? 'text/plain' : 'application/octet-stream');

async function raw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error(`file too large (limit ${Math.round(limit / 1_000_000)} MB)`); chunks.push(chunk as Buffer); }
  return Buffer.concat(chunks);
}

// What the founder attached to the messages still in the window: text files as text, pictures as pictures.
async function attachedTo(roomId: string): Promise<Attached> {
  const attached: Attached = { texts: {}, images: {} };
  for (const message of recent(await store.readChat(roomId))) {
    for (const file of message.attachments ?? []) {
      const bytes = await store.readFileBytes(file.path);
      if (!bytes) continue;
      if (IMAGE_FILE.test(file.path) && bytes.length <= 4_000_000) attached.images[file.path] = `data:${typeOf(file.path)};base64,${bytes.toString('base64')}`;
      else if (TEXT_FILE.test(file.path) && bytes.length <= 400_000) attached.texts[file.path] = bytes.toString('utf8');
    }
  }
  return attached;
}

async function chat(roomId: string, text: string, res: ServerResponse, extra: { replace?: string; attachments?: Attachment[] } = {}) {
  const stage = await store.loadStage();
  if (!stage.rooms.some((room) => room.id === roomId)) return json(res, 404, { error: 'unknown room' });
  if (busy.has(roomId)) return json(res, 409, { error: 'this person is still replying' });
  busy.add(roomId);

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event: ChatEvent) => !res.writableEnded && res.write(`data: ${JSON.stringify(event)}\n\n`);
  // The founder pressing Stop closes the request; the turn ends there and what was said is kept.
  const stop = new AbortController();
  res.on('close', () => stop.abort());
  try {
    // Regenerate and edit: the old message and everything after it leave the conversation (to trash) before the new one goes in.
    if (extra.replace) await store.cutChat(roomId, extra.replace, true);
    await store.appendChat(roomId, { id: newMessageId(), role: 'user', text, at: Date.now(), ...(extra.attachments?.length ? { attachments: extra.attachments } : {}) });
    const messages = await promptFor(stage, roomId, tools.map((tool) => tool.name));
    const room = stage.rooms.find((candidate) => candidate.id === roomId)!;
    const vision = messages.some((message) => message.role === 'user' && !!message.images?.length);
    const { order, notice } = route(clients, usage, { pinned: room.model, promptChars: promptSize(messages), tools: true, vision });
    if (vision && !order[0]?.vision) send({ notice: 'No model that can see images is set up (Gemini can), so the picture is described to the model only by its file name.' });
    if (notice) send({ notice });
    const reply = await runTurn({
      messages, tools, clients: order, usage, signal: stop.signal,
      approve: (event, signal) => approvals.ask(event.id, signal),
      context: { stage, roomId, store, granted: new Map() },
      events: { token: (token) => send({ token }), tool: (tool) => send({ tool }), notice: (text) => send({ notice: text }) },
    });
    const message = {
      id: newMessageId(), role: 'assistant' as const, text: reply.text, at: Date.now(), provider: reply.provider, model: reply.model,
      usage: reply.usage, ...(reply.tools.length ? { tools: reply.tools } : {}), ...(reply.stopped ? { stopped: true } : {}),
    };
    if (reply.text.trim() || reply.tools.length) await store.appendChat(roomId, message);
    send({ done: true, message });
    // Older talk folds into the person's memory after the reply, never in the founder's way.
    void memory.fold(roomId).catch(() => {});
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
    const refused = guard({ path, method: req.method ?? 'GET', headers: req.headers }, own);
    if (refused) return json(res, 403, { error: refused });
    const doc = /^\/api\/docs\/([^/]+)$/.exec(path)?.[1];
    const room = /^\/api\/rooms\/([^/]+)\/chat$/.exec(path)?.[1];

    if (path === '/api/stage' && req.method === 'GET') return json(res, 200, await store.loadStage());
    if (path === '/api/stage' && req.method === 'PUT') {
      const [before, next] = [await store.loadStage(), (await body(req)) as Stage];
      await store.saveStage(next);
      // A browser card that left the stage takes its Chrome session with it.
      for (const card of before.cards ?? []) if (!next.cards?.some((kept) => kept.id === card.id)) void browser.close(browserSession(card.id));
      return json(res, 200, { ok: true });
    }
    const asked = /^\/api\/approvals\/([\w.:-]{1,120})$/.exec(path)?.[1];
    if (asked && req.method === 'POST') {
      const answer = await body(req);
      const known = approvals.answer(asked, { ok: answer.ok === true, args: answer.args && typeof answer.args === 'object' ? answer.args : undefined });
      return json(res, known ? 200 : 404, known ? { ok: true } : { error: 'nothing is waiting under that id' });
    }
    const board = /^\/api\/boards\/([^/]+)(?:\/(events|tasks)(?:\/([^/]+)(?:\/(run|stop))?)?)?$/.exec(path);
    if (board) {
      const [, boardId, part, taskId, action] = board;
      if (!(await store.loadStage()).cards?.some((card) => card.id === boardId && card.kind === 'board')) return json(res, 404, { error: 'unknown board' });
      if (!part && req.method === 'GET') return json(res, 200, await boards.list(boardId));
      if (part === 'events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const tell = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        tell({ tasks: await boards.list(boardId) });
        res.on('close', boards.watch(boardId, tell));
        return;
      }
      if (part === 'tasks' && !taskId && req.method === 'POST') return json(res, 200, await boards.add(boardId, await body(req)));
      if (taskId && !action && req.method === 'PATCH') return json(res, 200, await boards.change(boardId, taskId, await body(req)));
      if (taskId && !action && req.method === 'DELETE') { runs.stop(taskId); await boards.remove(boardId, taskId); return json(res, 200, { ok: true }); }
      if (taskId && action === 'run' && req.method === 'POST') { await runs.start(boardId, taskId); return json(res, 200, { ok: true }); }
      if (taskId && action === 'stop' && req.method === 'POST') { runs.stop(taskId); return json(res, 200, { ok: true }); }
    }
    const linked = /^\/api\/links\/([^/]+)$/.exec(path)?.[1];
    if (linked && req.method === 'POST') {
      const card = (await store.loadStage()).cards?.find((one) => one.id === linked);
      if (!card || card.kind !== 'link' || !card.url) return json(res, 404, { error: 'unknown link' });
      const page = { url: card.url, ...(await browser.page(card.url)) };
      await store.writePage(linked, page);
      return json(res, 200, { title: page.title, preview: page.text.slice(0, 280) });
    }
    const watched = /^\/api\/browsers\/([^/]+)$/.exec(path)?.[1];
    if (watched && req.method === 'GET') {
      if (!(await store.loadStage()).cards?.some((card) => card.id === watched && card.kind === 'browser')) return json(res, 404, { error: 'unknown browser' });
      const card = (await store.loadStage()).cards!.find((one) => one.id === watched)!;
      return json(res, 200, await browser.watch(browserSession(watched), { profile: store.browserProfile(watched), headed: isHeaded(card) }));
    }
    // "Show window" changed: Chrome reads that only at start, so end the session and start it again the new way.
    const restarted = /^\/api\/browsers\/([^/]+)\/restart$/.exec(path)?.[1];
    if (restarted && req.method === 'POST') {
      const card = (await store.loadStage()).cards?.find((one) => one.id === restarted && one.kind === 'browser');
      if (!card) return json(res, 404, { error: 'unknown browser' });
      await browser.close(browserSession(restarted));
      return json(res, 200, await browser.watch(browserSession(restarted), { profile: store.browserProfile(restarted), headed: isHeaded(card) }));
    }
    if (doc && req.method === 'GET') return json(res, 200, { text: await store.readDoc(doc) });
    if (doc && req.method === 'PUT') { await store.writeDoc(doc, String((await body(req)).text ?? '')); return json(res, 200, { ok: true }); }
    if (path === '/api/models' && req.method === 'GET') return json(res, 200, usage.info(clients));
    const cut = /^\/api\/rooms\/([^/]+)\/chat\/([\w-]{1,80})$/.exec(path);
    if (cut && req.method === 'DELETE') {
      if (busy.has(cut[1])) return json(res, 409, { error: 'this person is still replying' });
      return json(res, 200, await store.cutChat(cut[1], cut[2], false));
    }
    if (path === '/api/files' && req.method === 'POST') {
      const name = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? 'file';
      const data = await raw(req, 15_000_000);
      const saved = await store.saveUpload(name, data);
      return json(res, 200, { path: saved, type: typeOf(saved), size: data.length });
    }
    if (path.startsWith('/api/files/') && req.method === 'GET') {
      const name = decodeURIComponent(path.slice('/api/files/'.length));
      const bytes = await store.readFileBytes(name).catch(() => null);
      if (!bytes) return json(res, 404, { error: 'no such file' });
      // Files may hold anything a person or a page produced: never let one run as a page of this app.
      res.writeHead(200, { 'content-type': typeOf(name), 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' });
      return res.end(bytes);
    }
    const remembered = /^\/api\/rooms\/([^/]+)\/memory$/.exec(path)?.[1];
    if (remembered && req.method === 'GET') { const { notes, summary } = await memory.read(remembered); return json(res, 200, { notes, summary }); }
    if (remembered && req.method === 'PUT') { await memory.write(remembered, await body(req)); return json(res, 200, { ok: true }); }
    if (room && req.method === 'GET') return json(res, 200, await store.readChat(room));
    if (room && req.method === 'POST') {
      const sent = await body(req);
      const text = String(sent.text ?? '').trim();
      const attachments: Attachment[] = [];
      for (const file of Array.isArray(sent.attachments) ? sent.attachments.slice(0, 5) : []) {
        const bytes = typeof file?.path === 'string' && file.path.startsWith('uploads/') ? await store.readFileBytes(file.path) : null;
        if (bytes) attachments.push({ path: file.path, type: typeOf(file.path), size: bytes.length });
      }
      if (!text && !attachments.length) return json(res, 400, { error: 'empty message' });
      return await chat(room, text || 'See the attached file.', res, { replace: typeof sent.replace === 'string' ? sent.replace : undefined, attachments });
    }
    if (path.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    const file = req.method === 'GET' ? await readStatic(resolve(import.meta.dirname, '../dist'), path) : null;
    if (!file) return json(res, 404, { error: 'not found — run `pnpm build` so the server has a client to serve' });
    res.writeHead(200, { 'content-type': file.type });
    res.end(file.body);
  } catch (error) {
    if (!res.headersSent) json(res, 500, { error: (error as Error).message });
    else res.end();
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`stage api on http://127.0.0.1:${port} — models: ${clients.map((client) => client.name).join(', ') || 'NONE (no keys found)'}`);
});
