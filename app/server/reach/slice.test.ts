import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Room, Stage } from '../../shared/model.ts';
import { createApprovals } from '../approvals.ts';
import { createAttention } from '../attention.ts';
import type { Deps } from '../install.ts';
import { createSeams } from '../seams.ts';
import type { ToolContext } from '../tools/registry.ts';
import reach from '../slices/reach.ts';

const room = (id: string, name: string): Room => ({ id, name, role: 'x', accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1 });
const stage: Stage = { rooms: [room('marketing', 'Maya')], docs: [], wires: [], cards: [] };
const context = (): ToolContext => ({ stage, roomId: 'marketing', store: {} as never, granted: new Map() });

// The app's own chat route, stood in for on a port this check owns: what the slice does with the founder's answer is
// send it to the person the way the window does, and this is where it lands.
let server: Server;
let port = 0;
const asked: { path: string; body: string; token: string }[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      asked.push({ path: req.url ?? '', body, token: String(req.headers['x-stage-token'] ?? '') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ done: true, message: { id: 'm1', role: 'assistant', text: 'right you are', at: 0 } })}\n\n`);
    });
  });
  await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done); });
  port = (server.address() as { port: number }).port;
});
afterAll(() => { server.close(); });

async function bench() {
  const dir = mkdtempSync(join(tmpdir(), 'reach-slice-'));
  const seams = createSeams();
  const approvals = createApprovals();
  const attention = createAttention(dir);
  const deps = {
    workspace: dir, root: dir, fake: true, seams, approvals, attention,
    store: { loadStage: async () => stage },
    boards: {}, own: { ports: [port, port + 1], token: 'launch-token' },
    json: () => {}, body: async () => ({}), runs: {},
  } as unknown as Deps;
  // Read before anything is written, the way the app reads it when the founder's window first asks what waits for them.
  await attention.list();
  return { deps, seams, approvals, attention };
}
const opened = async (attention: ReturnType<typeof createAttention>) => (await attention.list()).filter((one) => one.event?.name === 'ask_founder');
// Waits for something the slice does off to one side, without holding the check open for longer than it takes.
async function until<T>(get: () => Promise<T>, right: (value: T) => boolean): Promise<T> {
  for (let tries = 0; tries < 100; tries += 1) {
    const value = await get();
    if (right(value)) return value;
    await new Promise((done) => { setTimeout(done, 20); });
  }
  throw new Error('that never happened');
}

describe('a person asking the founder', () => {
  it('ends its turn in a conversation, and the founder is asked wherever they are', async () => {
    const { deps, seams, attention } = await bench();
    const part = await reach.install(deps);
    const tool = part.tools!.find((one) => one.name === 'ask_founder')!;
    await seams.run('turn:before', { roomId: 'marketing', source: 'chat', query: 'price it', messages: [] });
    const said = await tool.run({ question: 'Which price should I use?', choices: ['£29', '£49'] }, context());
    expect(said.text).toContain('Stop here');
    const open = await opened(attention);
    expect(open).toHaveLength(1);
    expect(open[0].title).toBe('Which price should I use?');
    expect(open[0].detail).toContain('£29 · £49');
    await part.close?.();
  });

  it('carries the founder\'s answer into the room as their next message', async () => {
    const { deps, seams, approvals, attention } = await bench();
    const part = await reach.install(deps);
    const tool = part.tools!.find((one) => one.name === 'ask_founder')!;
    await seams.run('turn:before', { roomId: 'marketing', source: 'chat', query: 'price it', messages: [] });
    await tool.run({ question: 'Which price?' }, context());
    const id = (await opened(attention))[0].event!.id;
    asked.length = 0;
    expect(approvals.answer(id, { ok: true, args: { answer: 'the higher one' } })).toBe(true);
    await until(async () => asked.length, (many) => many === 1);
    expect(asked[0].path).toBe('/api/rooms/marketing/chat');
    expect(JSON.parse(asked[0].body).text).toBe('the higher one');
    // It goes the app's own road, which means it carries this launch's token like any other script.
    expect(asked[0].token).toBe('launch-token');
    expect(await opened(attention)).toEqual([]);
    await part.close?.();
  });

  it('stops waiting the moment the founder writes in that room themselves', async () => {
    const { deps, seams, attention } = await bench();
    const part = await reach.install(deps);
    const tool = part.tools!.find((one) => one.name === 'ask_founder')!;
    await seams.run('turn:before', { roomId: 'marketing', source: 'chat', query: 'price it', messages: [] });
    await tool.run({ question: 'Which price?' }, context());
    asked.length = 0;
    await seams.run('turn:before', { roomId: 'marketing', source: 'chat', query: 'the higher one', messages: [] });
    await until(() => opened(attention), (list) => !list.length);
    // Their words are already in the room: nothing is sent there a second time.
    expect(asked).toEqual([]);
    await part.close?.();
  });

  it('makes a background run wait, and hands back what the founder said', async () => {
    const { deps, seams, approvals, attention } = await bench();
    const part = await reach.install(deps);
    const tool = part.tools!.find((one) => one.name === 'ask_founder')!;
    await seams.run('turn:before', { roomId: 'marketing', source: 'run', query: 'the weekly note', messages: [] });
    const running = tool.run({ question: 'Which price?' }, context());
    const [open] = await until(() => opened(attention), (list) => list.length === 1);
    // The question is on the list the moment it is asked; the run is waiting on it a heartbeat later.
    await until(async () => approvals.answer(open.event!.id, { ok: true, args: { answer: '£49, always' } }), (known) => known);
    expect((await running).text).toBe('The founder says: £49, always');
    expect(await opened(attention)).toEqual([]);
    await part.close?.();
  });

  it('carries on without an answer when the founder says no', async () => {
    const { deps, seams, approvals, attention } = await bench();
    const part = await reach.install(deps);
    const tool = part.tools!.find((one) => one.name === 'ask_founder')!;
    await seams.run('turn:before', { roomId: 'marketing', source: 'run', query: 'the weekly note', messages: [] });
    const running = tool.run({ question: 'Which price?' }, context());
    const [open] = await until(() => opened(attention), (list) => list.length === 1);
    await until(async () => approvals.answer(open.event!.id, { ok: false }), (known) => known);
    expect((await running).text).toContain('did not answer');
    await part.close?.();
  });
});
