import { mkdtemp, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { seedStage, type Stage } from '../../shared/model.ts';
import type { Installed } from '../install.ts';
import { DELIVERY, SIGNATURE, sign, TIMESTAMP } from '../reach/hooks.ts';
import { stubDeps } from '../slice-stubs.ts';
import type { ToolContext } from '../tools/registry.ts';
import reach from './reach.ts';

const root = resolve(import.meta.dirname, '../../..');
let part: Installed | null = null;
afterEach(async () => { await part?.close?.(); part = null; });

async function setup(saved?: Record<string, unknown>) {
  const workspace = await mkdtemp(join(tmpdir(), 'reach-'));
  if (saved) await writeFile(join(workspace, 'reach.json'), JSON.stringify(saved));
  const deps = stubDeps(workspace, root);
  const stage: Stage = structuredClone(seedStage);
  stage.cards = [{ id: 'board-1', kind: 'board', x: 0, y: 0, w: 1, h: 1 } as never];
  await deps.store.saveStage(stage);
  const answered: { status: number; body: any }[] = [];
  let sent: unknown = {};
  deps.json = (_res, status, body) => { answered.push({ status, body }); };
  deps.body = async () => sent as Record<string, any>;
  part = await reach.install(deps);
  const call = async (path: string, method = 'GET', body: unknown = {}, req: Partial<IncomingMessage> = {}) => {
    sent = body;
    const handled = await part!.route!((req instanceof Readable ? req : { method, headers: {}, ...req }) as IncomingMessage, {} as ServerResponse, path);
    return handled ? answered.at(-1)! : null;
  };
  return { deps, call, roomId: stage.rooms[0].id };
}

// A call in from another program: the body as a stream, with the headers a signed sender puts on it.
const signedCall = (body: string, headers: Record<string, string>) => Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST', headers }) as unknown as IncomingMessage;

describe('the reach slice', () => {
  it('turns a signed call on a hook into one task on its board, and refuses an unsigned or repeated one', async () => {
    const { deps, call } = await setup();
    const made = await call('/api/reach/hooks', 'POST', { name: 'New signup', boardId: 'board-1' });
    expect(made!.status).toBe(200);
    const { id, secret } = made!.body as { id: string; secret: string };
    const at = String(Date.now());
    const body = '{"email":"ada@example.com"}';
    const headers = { [TIMESTAMP]: at, [SIGNATURE]: `sha256=${sign(secret, at, body)}`, [DELIVERY]: 'd-1' };
    const took = await call(`/api/hooks/${id}`, 'POST', {}, signedCall(body, headers));
    expect(took).toMatchObject({ status: 200, body: { ok: true } });
    const tasks = await deps.boards.list('board-1');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'New signup' });
    expect(tasks[0].detail).toContain('ada@example.com');
    expect(tasks[0].detail).toContain('never instructions');
    expect(await call(`/api/hooks/${id}`, 'POST', {}, signedCall(body, headers))).toMatchObject({ status: 200, body: { again: true } });
    expect(await call(`/api/hooks/${id}`, 'POST', {}, signedCall(body, { [TIMESTAMP]: at, [SIGNATURE]: 'sha256=00' }))).toMatchObject({ status: 401 });
    expect(await call('/api/hooks/nobody', 'POST', {}, signedCall(body, headers))).toMatchObject({ status: 401 });
    expect(await deps.boards.list('board-1')).toHaveLength(1);
  });

  it('holds a background run on ask_founder until the founder answers, and passes the answer on', async () => {
    const { deps, roomId } = await setup();
    await deps.seams.run('turn:before', { roomId, source: 'run', query: 'go', messages: [] });
    const [ask] = part!.tools!;
    const context = { stage: await deps.store.loadStage(), roomId, store: deps.store, granted: new Map(), signal: new AbortController().signal } as unknown as ToolContext;
    const going = ask.run({ question: 'Which colour?', choices: ['Blue', 'Green'] }, context);
    let entry = (await deps.attention.list()).find((one) => one.kind === 'approval');
    for (let tries = 0; !entry && tries < 50; tries += 1) {
      await new Promise((done) => { setTimeout(done, 10); });
      entry = (await deps.attention.list()).find((one) => one.kind === 'approval');
    }
    expect(entry).toMatchObject({ title: 'Which colour?', event: { choices: ['Blue', 'Green'] } });
    // The entry is on the list a moment before the run starts waiting on it; the answer is given once it is.
    for (let tries = 0; !deps.approvals.answer(entry!.event!.id, { ok: true, args: { answer: 'Green' } }) && tries < 50; tries += 1) await new Promise((done) => { setTimeout(done, 10); });
    expect((await going).text).toBe('The founder says: Green');
    expect((await deps.attention.list()).some((one) => one.kind === 'approval')).toBe(false);
  });

  it('puts a choice asked in a conversation into Needs you with its choices, and keeps it there after the turn ends', async () => {
    const { deps, roomId } = await setup();
    await deps.seams.run('turn:before', { roomId, source: 'chat', query: 'Give the verdict', messages: [] });
    const [ask] = part!.tools!;
    const context = { stage: await deps.store.loadStage(), roomId, store: deps.store, granted: new Map(), signal: new AbortController().signal } as unknown as ToolContext;
    const out = await ask.run({ question: 'What is your founder fit?', choices: ['Lived it', 'Unusual access', 'Technical edge', 'None'] }, context);
    expect(out.text).toMatch(/has been asked/);
    await deps.seams.run('turn:after', { roomId, source: 'chat', query: 'Give the verdict', reply: { text: 'Waiting on you.', tools: [{ id: 't', name: 'ask_founder', args: {}, ok: true }], provider: 'x', model: 'y', usage: { input: 1, output: 1 }, stopped: false } } as never);
    const entry = (await deps.attention.list()).find((one) => one.kind === 'approval');
    expect(entry).toMatchObject({ title: 'What is your founder fit?', roomId, event: { name: 'ask_founder', question: 'What is your founder fit?', choices: ['Lived it', 'Unusual access', 'Technical edge', 'None'] } });
    expect(deps.approvals.answer(entry!.event!.id, { ok: true, args: { answer: 'Lived it' } })).toBe(true);
    for (let tries = 0; tries < 20 && (await deps.attention.list()).some((one) => one.kind === 'approval'); tries += 1) await new Promise((done) => { setTimeout(done, 10); });
    expect((await deps.attention.list()).some((one) => one.kind === 'approval')).toBe(false);
  });

  it('sends the daily note once when it is due, and not again on the next tick', async () => {
    const { call } = await setup({
      on: true, token: 'fake-token', voice: false, cloudSpeech: false, hooks: [],
      paired: [{ chatId: 1, name: 'Founder', at: 1 }],
      updates: { on: true, finished: false, stuck: false, digest: true, at: '00:00' },
    });
    const posted = async () => ((await call('/api/reach/telegram'))!.body as { posted: { text: string }[] }).posted;
    const before = (await posted()).length;
    await part!.tick!();
    const after = await posted();
    expect(after.length).toBeGreaterThan(before);
    await part!.tick!();
    expect((await posted()).length).toBe(after.length);
  });
});
