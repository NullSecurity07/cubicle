import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Room, Stage } from '../../shared/model.ts';
import { voiceFor } from '../../shared/voices.ts';
import { createApprovals } from '../approvals.ts';
import { createAttention } from '../attention.ts';
import { localDay } from '../clock.ts';
import type { Deps, Installed } from '../install.ts';
import { fakeVoices, VOICES } from '../media/voice.ts';
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
    boards: { list: async () => [], onChange: () => () => {} },
    skills: { list: async () => [] }, busy: new Set<string>(),
    own: { ports: [port, port + 1], token: 'launch-token' },
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
    expect(open[0].event?.choices).toEqual(['£29', '£49']);
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

// A reply said out loud in the window. The route answers with the sound itself rather than json, so what this check
// watches is which voice the maker was asked for.
function saying(body: Record<string, unknown>, rooms: Room[] = [room('marketing', 'Maya'), room('build', 'Dev')]) {
  const dir = mkdtempSync(join(tmpdir(), 'reach-say-'));
  let held: Stage = { rooms, docs: [], wires: [], cards: [] };
  const deps = {
    workspace: dir, root: dir, fake: true, seams: createSeams(), approvals: createApprovals(), attention: createAttention(dir),
    store: { loadStage: async () => held, saveStage: async (next: Stage) => { held = next; } },
    boards: { list: async () => [], onChange: () => () => {} }, skills: { list: async () => [] }, busy: new Set<string>(),
    own: { ports: [port, port + 1], token: 'launch-token' }, json: () => {}, body: async () => body, runs: {},
  } as unknown as Deps;
  const req = { method: 'POST', headers: {} } as unknown as Parameters<NonNullable<Installed['route']>>[0];
  const res = { writeHead: () => {}, end: () => {} } as unknown as Parameters<NonNullable<Installed['route']>>[1];
  return { deps, req, res, stage: () => held };
}

describe('saying a reply out loud', () => {
  it('uses the voice of the person who wrote it, and writes that voice down on them', async () => {
    const asked = vi.spyOn(fakeVoices, 'make');
    try {
      const maya = saying({ text: 'Here is what I found.', roomId: 'marketing' });
      const first = await reach.install(maya.deps);
      expect(await first.route!(maya.req, maya.res, '/api/reach/speak')).toBe(true);
      const mine = voiceFor(maya.stage().rooms[0], maya.stage().rooms, VOICES);
      expect(asked.mock.calls.at(-1)![0].voice).toBe(mine);
      // Written down where it cannot move again, with the guess that chose it.
      expect(maya.stage().rooms[0]).toMatchObject({ gender: 'woman', voice: mine, voiceBy: 'cast' });
      expect(mine).toBe('af_heart');
      await first.close?.();

      const dev = saying({ text: 'Here is what I found.', roomId: 'build' });
      const second = await reach.install(dev.deps);
      await second.route!(dev.req, dev.res, '/api/reach/speak');
      // The same words from somebody else are somebody else's voice, not the one already made.
      expect(asked.mock.calls.at(-1)![0].voice).toBe(voiceFor(dev.stage().rooms[1], dev.stage().rooms, VOICES));
      expect(asked.mock.calls.at(-1)![0].voice).not.toBe(mine);
      await second.close?.();
    } finally { asked.mockRestore(); }
  });

  it('says one voice asked for by name, for the founder to hear before they give it to somebody', async () => {
    const asked = vi.spyOn(fakeVoices, 'make');
    try {
      const heard = saying({ text: 'Morning. Where would you like to start?', roomId: 'marketing', voice: 'bm_fable' });
      const part = await reach.install(heard.deps);
      await part.route!(heard.req, heard.res, '/api/reach/speak');
      expect(asked.mock.calls.at(-1)![0].voice).toBe('bm_fable');
      // Hearing a voice gives nobody that voice.
      expect(heard.stage().rooms[0].voice).toBeUndefined();
      await part.close?.();
    } finally { asked.mockRestore(); }
  });

  it('recasts a voice the app once cast badly as it starts, says so, and never touches the founder\'s pick', async () => {
    const said = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const rooms = [{ ...room('marketing', 'Maya'), gender: 'woman' as const, voice: 'af_kore' }, { ...room('build', 'Dev'), voice: 'am_eric', voiceBy: 'founder' as const }];
      const start = saying({ text: 'Hello.', roomId: 'marketing' }, rooms);
      const part = await reach.install(start.deps);
      expect(start.stage().rooms[0]).toMatchObject({ voice: 'af_heart', voiceBy: 'cast' });
      expect(start.stage().rooms[1]).toEqual(rooms[1]);
      expect(said.mock.calls.filter(([line]) => String(line).includes('Maya af_kore to af_heart'))).toHaveLength(1);
      await part.close?.();
    } finally { said.mockRestore(); }
  });

  it('speaks in Heart when no person is behind the words', async () => {
    const asked = vi.spyOn(fakeVoices, 'make');
    try {
      const nobody = saying({ text: 'Your digest.', roomId: '' });
      const part = await reach.install(nobody.deps);
      await part.route!(nobody.req, nobody.res, '/api/reach/speak');
      expect(asked.mock.calls.at(-1)![0].voice).toBe('af_heart');
      await part.close?.();
    } finally { asked.mockRestore(); }
  });
});

describe('the partner\'s morning note on the phone', () => {
  // A phone that is paired and switched on, with the daily note due since midnight, and today's note from the partner.
  async function paired(quiet = false, noNoteYet = false, digestAt = '00:00') {
    const dir = mkdtempSync(join(tmpdir(), 'reach-morning-'));
    const rooms = [room('marketing', 'Maya'), { ...room('pat', 'Pat'), role: 'Partner', partner: true }];
    const held: Stage = { rooms, docs: [], wires: [], cards: [] };
    writeFileSync(join(dir, 'reach.json'), JSON.stringify({ on: true, token: 'fake-token', paired: [{ chatId: 1, name: 'Founder', at: 1 }], updates: { on: !quiet, finished: true, stuck: true, digest: true, at: digestAt } }));
    const at = Date.now();
    const note = { day: localDay(at), at, roomId: 'pat', who: 'Pat', things: ['Call the three dentists who opened the email', 'Price the pilot at £49'], risk: 'the pilot has no end date', question: 'Which clinic goes first?' };
    const late = () => writeFileSync(join(dir, 'partner.json'), JSON.stringify({ decided: [], plans: [], morning: note }));
    if (noNoteYet) writeFileSync(join(dir, 'partner.json'), JSON.stringify({ decided: [], plans: [] }));
    else late();
    const attention = createAttention(dir);
    let answer: unknown = null;
    let incoming: Record<string, unknown> = {};
    const deps = {
      workspace: dir, root: dir, fake: true, seams: createSeams(), approvals: createApprovals(), attention,
      store: { loadStage: async () => held }, boards: { list: async () => [], onChange: () => () => {} },
      skills: { list: async () => [] }, busy: new Set<string>(), own: { ports: [port, port + 1], token: 'launch-token' },
      json: (_res: unknown, _status: number, body: unknown) => { answer = body; }, body: async () => incoming, runs: {},
    } as unknown as Deps;
    await attention.list();
    const part = await reach.install(deps);
    const call = (method: string) => ({ method, headers: {} }) as unknown as Parameters<NonNullable<Installed['route']>>[0];
    const telegram = async () => { await part.route!(call('GET'), {} as never, '/api/reach/telegram'); return answer as { posted: { chatId: number; text: string; messageId: number }[] }; };
    // The founder writing on their phone, the way the fake Telegram is handed a message.
    const says = async (body: Record<string, unknown>) => { incoming = body; await part.route!(call('POST'), {} as never, '/api/reach/telegram'); };
    return { part, telegram, says, late };
  }

  it('goes out as one message with the digest, under the partner\'s name, and only once', async () => {
    const { part, telegram } = await paired();
    await part.tick!();
    await part.tick!();
    const posted = (await telegram()).posted;
    expect(posted).toHaveLength(1);
    expect(posted[0].chatId).toBe(1);
    expect(posted[0].text).toContain('Pat');
    expect(posted[0].text).toContain('Call the three dentists who opened the email');
    expect(posted[0].text).toContain('Which clinic goes first?');
    // The digest is in the same message, not a second one.
    expect(posted[0].text).toContain('Today');
    await part.close?.();
  });

  it('takes a reply to it on the phone to the partner\'s room', async () => {
    const { part, telegram, says } = await paired();
    await part.tick!();
    const [note] = (await telegram()).posted;
    asked.length = 0;
    await says({ chatId: 1, text: 'Why the pilot first?', extra: { reply_to_message: { message_id: note.messageId, chat: { id: 1 }, text: 'x' } } });
    await until(async () => asked.length, (many) => many === 1);
    expect(asked[0].path).toBe('/api/rooms/pat/chat');
    expect(JSON.parse(asked[0].body).text).toContain('Why the pilot first?');
    await part.close?.();
  });

  // A digest at six, after the partner's hour: until ten past six it is still rightly held for the note, and before
  // six it is not due at all, so this has nothing to see then.
  const beforeTenPastSix = new Date().getHours() < 6 || (new Date().getHours() === 6 && new Date().getMinutes() < 11);
  it.skipIf(beforeTenPastSix)('does not send a late note on its own once the digest has gone without it: one message a day', async () => {
    const { part, telegram, late } = await paired(false, true, '06:00');
    await part.tick!();
    expect((await telegram()).posted).toHaveLength(1);
    expect((await telegram()).posted[0].text).not.toContain('Call the three dentists');
    late();
    await part.tick!();
    expect((await telegram()).posted).toHaveLength(1);
    await part.close?.();
  });

  it('sends the note on its own later when the digest came before the partner writes', async () => {
    // Midnight is before the partner's hour: the digest goes at once, and the note, when it comes, follows it.
    const { part, telegram, late } = await paired(false, true, '00:00');
    await part.tick!();
    expect((await telegram()).posted).toHaveLength(1);
    late();
    await part.tick!();
    const posted = (await telegram()).posted;
    expect(posted).toHaveLength(2);
    expect(posted[1].text).toContain('Call the three dentists');
    await part.tick!();
    expect((await telegram()).posted).toHaveLength(2);
    await part.close?.();
  });

  it('stays off the phone when the founder asked for quiet', async () => {
    const { part, telegram } = await paired(true);
    await part.tick!();
    expect((await telegram()).posted).toEqual([]);
    await part.close?.();
  });
});
