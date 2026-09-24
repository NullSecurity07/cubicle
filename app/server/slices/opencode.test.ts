import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoderEvent } from '../../shared/coder.ts';
import type { Attention, ToolEvent } from '../../shared/model.ts';
import { createApprovals } from '../approvals.ts';
import { NOT_INSTALLED } from '../opencode/server.ts';
import type { Coder } from '../opencode/session.ts';
import { createSeams } from '../seams.ts';
import { hub } from '../events.ts';
import type { Deps } from '../install.ts';
import { runTurn } from '../loop.ts';
import type { ModelClient } from '../providers.ts';
import { createStore } from '../store.ts';
import { createUsage } from '../usage.ts';
import opencode, { coderTools } from './opencode.ts';
import safety from './safety.ts';

// A model that asks for one tool once, then says it is done.
const client = (name: string, args: Record<string, unknown>): ModelClient => {
  let step = 0;
  return { name: 's', model: 's', maxPromptChars: Infinity, tools: true, limits: {}, async step(_messages, { onToken }) {
    step += 1;
    if (step === 1) return { text: '', calls: [{ id: `call-${name}`, name, args: JSON.stringify(args) }] };
    onToken('ok'); return { text: '', calls: [] };
  } };
};

// The slice on a throwaway workspace, in fake mode: the in-process opencode, a real store, the real approvals book.
async function setup(wiredTo = 'build') {
  const workspace = await mkdtemp(join(tmpdir(), 'coder-slice-'));
  const folder = await mkdtemp(join(tmpdir(), 'coder-folder-'));
  const store = createStore(workspace);
  const stage = await store.loadStage();
  stage.cards = [{ id: 'coder-1', kind: 'project', path: folder, x: 0, y: 0, w: 1, h: 1 }];
  stage.wires.push({ id: 'w', from: wiredTo, fromHandle: 'r', to: 'coder-1', toHandle: 'l' });
  await store.saveStage(stage);
  const approvals = createApprovals();
  const raised: Attention[] = [];
  const answered: { status: number; body: any }[] = [];
  let sent: unknown = {};
  const deps = {
    workspace, root: workspace, fake: true, store, approvals,
    attention: { raise: async (one: Attention) => { raised.push(one); }, clear: async () => {} },
    json: (_res: ServerResponse, status: number, body: unknown) => { answered.push({ status, body }); },
    body: async () => sent,
  } as unknown as Deps;
  const part = await opencode.install(deps);
  const heard: { channel: string; data: CoderEvent }[] = [];
  hub.say = (channel, data) => heard.push({ channel, data: data as CoderEvent });
  const call = (path: string, method = 'POST', body: unknown = {}) => { sent = body; return part.route!({ method } as IncomingMessage, {} as ServerResponse, path); };
  const turn = async (name: string, args: Record<string, unknown>, approve: (event: ToolEvent) => Promise<{ ok: boolean }> = async () => ({ ok: true })) => {
    const events: ToolEvent[] = [];
    const reply = await runTurn({
      messages: [{ role: 'user', content: 'go' }], tools: part.tools!, clients: [client(name, args)], usage: createUsage(null),
      approve, context: { stage: await store.loadStage(), roomId: 'build', store, granted: new Map() }, events: { token: () => {}, tool: (event) => events.push(event) },
    });
    return { reply, events };
  };
  return { part, store, folder, raised, answered, heard, call, turn, approvals };
}

let closing: (() => Promise<void>) | undefined;
afterEach(async () => { await closing?.(); closing = undefined; });

describe('the coder card', () => {
  it('lets a wired person start work after the founder says start, streams it to the card, and reports what changed', async () => {
    const { part, folder, heard, turn, store } = await setup();
    closing = part.close;
    const { reply, events } = await turn('code_task', { brief: 'Add a health check endpoint' });
    expect(events[0]).toMatchObject({ waiting: true, question: `Start this coding task in ${folder}?` });
    expect(reply.tools[0]).toMatchObject({ ok: true, result: 'Did: Add a health check endpoint\n\nChanged: +12 −3 in 1 file (src/example.ts)' });
    const lines = heard.filter((one) => one.channel === 'coder:coder-1' && one.data.line).map((one) => one.data.line!.text);
    expect(lines).toEqual(['Add a health check endpoint', 'edit src/example.ts', 'Did: Add a health check endpoint', '+12 −3 in 1 file']);
    expect(heard.find((one) => one.data.line?.kind === 'ask')?.data.line?.by).toBe('Dev');
    // The session is written on the card, so it carries on after a restart.
    expect((await store.loadStage()).cards?.[0]).toMatchObject({ session: 'ses_fake0001' });
  });

  it('never starts without a wire or without a yes', async () => {
    const one = await setup('marketing');
    closing = one.part.close;
    expect((await one.turn('code_task', { brief: 'x' })).reply.tools[0].result).toMatch(/no coder card is connected/);
    await one.part.close!();
    const two = await setup();
    closing = two.part.close;
    expect((await two.turn('code_task', { brief: 'x' }, async () => ({ ok: false }))).reply.tools[0].result).toMatch(/founder said no/);
    expect(two.heard.some((one) => one.data.line)).toBe(false);
  });

  it('takes the founder\'s own words from the card, and their answer to a question', async () => {
    const { part, call, answered, heard, raised } = await setup();
    closing = part.close;
    expect(await call('/api/coder/coder-1/ask', 'POST', { text: 'Run the tests please' })).toBe(true);
    expect(answered.at(-1)).toMatchObject({ status: 202 });
    const until = async (check: () => boolean) => { for (let tries = 0; tries < 200 && !check(); tries += 1) await new Promise((settle) => setTimeout(settle, 10)); };
    await until(() => raised.length > 0);
    const permission = raised[0].id.slice('coder:'.length);
    expect(raised[0]).toMatchObject({ kind: 'approval', title: 'Allow the coder to run pnpm test?', cardId: 'coder-1' });
    await call(`/api/coder/coder-1/permission/${permission}`, 'POST', { reply: 'once' });
    expect(answered.at(-1)).toMatchObject({ status: 200 });
    await until(() => heard.some((one) => one.data.state === 'idle'));
    const lines = heard.flatMap((one) => (one.data.line ? [one.data.line.text] : []));
    expect(lines).toContain('allowed · bash pnpm test');
    expect(lines).toContain('bash pnpm test');
    // A window opening now gets the whole log at once.
    const opened = await Promise.all(hub.opening.map((open) => open()));
    expect(opened.flat().find((one) => one.channel === 'coder:coder-1')?.data).toMatchObject({ state: 'idle', permission: null });

    await call('/api/coder/coder-1/undo');
    expect(answered.at(-1)).toMatchObject({ status: 200 });
    expect(heard.findLast((one) => one.data.line)?.data.line?.text).toBe('undone · "Run the tests please"');
    await call('/api/coder/nobody/stop');
    expect(answered.at(-1)).toMatchObject({ status: 404 });
  });

  // On a machine without opencode the task cannot start, so the founder is not asked to approve it and the safety net
  // does not copy the whole folder first: the refusal comes before both.
  it('refuses to start work where opencode is missing, before any question and before any checkpoint', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'coder-missing-'));
    const folder = await mkdtemp(join(tmpdir(), 'coder-folder-'));
    await writeFile(join(folder, 'a.ts'), 'export const a = 1;\n');
    const store = createStore(workspace);
    const stage = await store.loadStage();
    stage.cards = [{ id: 'coder-1', kind: 'project', path: folder, x: 0, y: 0, w: 1, h: 1 }];
    stage.wires.push({ id: 'w', from: 'build', fromHandle: 'r', to: 'coder-1', toHandle: 'l' });
    await store.saveStage(stage);
    const seams = createSeams();
    await safety.install({ workspace, root: workspace, store, seams, approvals: createApprovals(), attention: { list: async () => [] } } as unknown as Deps);
    const prompted: string[] = [];
    const coder = { prompt: async () => { prompted.push('prompt'); } } as unknown as Coder;
    const asked: ToolEvent[] = [];
    const events: ToolEvent[] = [];
    const reply = await runTurn({
      messages: [{ role: 'user', content: 'go' }], tools: coderTools(coder, [workspace], () => NOT_INSTALLED), clients: [client('code_task', { brief: 'Add a test' })], usage: createUsage(null), seams,
      approve: async (event) => { asked.push(event); return { ok: true }; },
      context: { stage: await store.loadStage(), roomId: 'build', store, granted: new Map() }, events: { token: () => {}, tool: (event) => events.push(event) },
    });
    expect(reply.tools[0]).toMatchObject({ ok: false });
    expect(reply.tools[0].result).toContain('opencode is not installed');
    expect(asked).toEqual([]);
    expect(events.some((one) => one.waiting)).toBe(false);
    expect(prompted).toEqual([]);
    expect(await readdir(join(workspace, '.index', 'checkpoints')).catch(() => [])).toEqual([]);
  });
});
