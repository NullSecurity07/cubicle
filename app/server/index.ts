import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { isHeaded, newMessageId, type ChatEvent, type Stage } from '../shared/model.ts';
import { createApprovals } from './approvals.ts';
import { createBoards } from './boards.ts';
import { fakeCoder, opencodeCoder } from './coder.ts';
import { createBrowser, fakeRunner, jinaReader, realRunner } from './browser.ts';
import { runTurn } from './loop.ts';
import { createMail, fakeMailHttp } from './mail.ts';
import { createMemory } from './memory.ts';
import { buildMessages, colleagueIds, readableDocIds } from './prompt.ts';
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
const clients = fake ? [fakeClient] : realClients();
const busy = new Set<string>();
const workspace = process.env.STAGE_WORKSPACE ?? resolve(root, 'workspace');
const store = createStore(workspace);
const usage = createUsage(resolve(workspace, 'usage.json'));
await usage.load();
const browser = fake ? createBrowser(fakeRunner) : createBrowser(realRunner(), process.env.STAGE_NO_READER === '1' ? null : jinaReader);
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
  return buildMessages(stage, roomId, docs, fresh ? [] : await store.readChat(roomId), toolNames, colleagues, await memory.read(roomId));
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

async function chat(roomId: string, text: string, res: ServerResponse) {
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
    await store.appendChat(roomId, { id: newMessageId(), role: 'user', text, at: Date.now() });
    const messages = await promptFor(stage, roomId, tools.map((tool) => tool.name));
    const room = stage.rooms.find((candidate) => candidate.id === roomId)!;
    const { order, notice } = route(clients, usage, { pinned: room.model, promptChars: promptSize(messages), tools: true });
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
    const remembered = /^\/api\/rooms\/([^/]+)\/memory$/.exec(path)?.[1];
    if (remembered && req.method === 'GET') { const { notes, summary } = await memory.read(remembered); return json(res, 200, { notes, summary }); }
    if (remembered && req.method === 'PUT') { await memory.write(remembered, await body(req)); return json(res, 200, { ok: true }); }
    if (room && req.method === 'GET') return json(res, 200, await store.readChat(room));
    if (room && req.method === 'POST') {
      const text = String((await body(req)).text ?? '').trim();
      if (!text) return json(res, 400, { error: 'empty message' });
      return await chat(room, text, res);
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
