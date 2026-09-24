import { describe, expect, it } from 'vitest';
import type { CoderEvent } from '../../shared/coder.ts';
import type { Attention } from '../../shared/model.ts';
import { createApprovals } from '../approvals.ts';
import { fakeEngine } from './fake.ts';
import type { Engine } from './server.ts';
import { GONE } from './server.ts';
import { createCoder } from './session.ts';

const card = { id: 'coder-1', dir: '/code/shop', name: 'shop' };

// The engine the card drives, the book the founder answers in and the list of what waits for them — all of them
// watched, so a test can say what went where.
function setup(engine: Engine & Partial<ReturnType<typeof fakeEngine>> = fakeEngine({ step: 2 }), extra: { now?: () => number } = {}) {
  const said: CoderEvent[] = [];
  const raised: Attention[] = [];
  const cleared: string[] = [];
  const remembered: [string, string][] = [];
  const calls: { method: string; path: string; body?: any }[] = [];
  const approvals = createApprovals();
  const watched: Engine = { ...engine, call: (method, path, options) => { calls.push({ method, path, body: options?.body }); return engine.call(method, path, options); } };
  const coder = createCoder({
    engine: watched, approvals,
    say: (_cardId, event) => said.push(event),
    attention: { raise: async (entry) => { raised.push(entry); }, clear: async (id) => { cleared.push(id); } },
    remember: async (cardId, session) => { remembered.push([cardId, session]); },
    env: {}, ...extra,
  });
  const lines = () => coder.snapshot(card.id).lines.map((one) => `${one.kind}: ${one.text}`);
  return { coder, said, raised, cleared, remembered, calls, approvals, lines, engine };
}
const until = async (check: () => boolean) => { for (let tries = 0; tries < 200 && !check(); tries += 1) await new Promise((settle) => setTimeout(settle, 5)); expect(check()).toBe(true); };

describe('a coder card', () => {
  it('starts a session in the folder, streams every step and hands back the reply with what changed', async () => {
    const { coder, remembered, lines, calls, said } = setup();
    await coder.prompt(card, 'Add a health check', { by: 'Dev' });
    expect(remembered).toEqual([['coder-1', 'ses_fake0001']]);
    expect(calls.find((one) => one.path.endsWith('/prompt_async'))?.body).toEqual({ model: { providerID: 'opencode', modelID: 'fake-free' }, parts: [{ type: 'text', text: 'Add a health check' }] });
    expect(coder.snapshot(card.id).state).toBe('working');
    expect(await coder.wait(card.id)).toBe('done');
    expect(lines()).toEqual(['ask: Add a health check', 'tool: edit src/example.ts', 'reply: Did: Add a health check', 'diff: +12 −3 in 1 file']);
    expect(coder.snapshot(card.id).state).toBe('idle');
    expect(said.some((one) => one.state === 'working')).toBe(true);
    expect(await coder.result(card.id)).toBe('Did: Add a health check\n\nChanged: +12 −3 in 1 file (src/example.ts)');
    // The next prompt goes into the same session.
    await coder.prompt(card, 'And a readme', {});
    await coder.wait(card.id);
    expect(remembered).toHaveLength(1);
  });

  it('asks the founder before a command, and carries "always" and a reason back to the coder', async () => {
    const { coder, raised, cleared, calls, approvals, lines } = setup();
    await coder.prompt(card, 'Run the test suite', {});
    await until(() => coder.snapshot(card.id).state === 'waiting');
    const asked = coder.snapshot(card.id).permission!;
    expect(asked).toMatchObject({ tool: 'bash', what: 'pnpm test', always: ['pnpm *'] });
    expect(raised[0]).toMatchObject({ id: `coder:${asked.id}`, kind: 'approval', title: 'Allow the coder to run pnpm test?', cardId: 'coder-1', who: 'shop' });
    expect(raised[0].event).toMatchObject({ id: `coder:${asked.id}`, name: 'coder_permission', args: { command: 'pnpm test' } });
    approvals.answer(`coder:${asked.id}`, { ok: true, args: { reply: 'always' } });
    expect(await coder.wait(card.id)).toBe('done');
    expect(calls.find((one) => one.path.startsWith('/permission/'))).toMatchObject({ path: `/permission/${asked.id}/reply`, body: { reply: 'always' } });
    expect(cleared).toContain(`coder:${asked.id}`);
    expect(lines()).toContain('note: allowed for good · pnpm *');
    expect(lines()).toContain('tool: bash pnpm test');

    await coder.prompt(card, 'Run the tests again', {});
    await until(() => coder.snapshot(card.id).state === 'waiting');
    const second = coder.snapshot(card.id).permission!;
    await coder.answer(card.id, second.id, 'reject', 'not on this machine');
    await coder.wait(card.id);
    expect(calls.filter((one) => one.path.startsWith('/permission/')).at(-1)?.body).toEqual({ reply: 'reject', message: 'not on this machine' });
    expect(lines()).toContain('note: said no · bash pnpm test — not on this machine');
    expect(coder.snapshot(card.id).permission).toBeUndefined();
  });

  it('says no for the founder when nobody answered in time', async () => {
    const { coder, approvals, calls } = setup();
    await coder.prompt(card, 'Run the test suite', {});
    await until(() => coder.snapshot(card.id).state === 'waiting');
    approvals.answer(`coder:${coder.snapshot(card.id).permission!.id}`, { ok: false, args: { message: 'no answer in time' } });
    await coder.wait(card.id);
    expect(calls.filter((one) => one.path.startsWith('/permission/')).at(-1)?.body).toEqual({ reply: 'reject', message: 'no answer in time' });
  });

  it('stops a session that has gone quiet for 90 seconds', async () => {
    let now = 1_000_000;
    const { coder, calls, lines } = setup(fakeEngine({ step: 60_000, now: () => now }), { now: () => now });
    await coder.prompt(card, 'Slow work', {});
    const waited = coder.wait(card.id);
    now += 60_000;
    await coder.tick();
    expect(calls.some((one) => one.path.endsWith('/abort'))).toBe(false);
    now += 31_000;
    await coder.tick();
    expect(calls.some((one) => one.path.endsWith('/abort'))).toBe(true);
    expect(await waited).toBe('stopped');
    expect(lines().at(-1)).toBe('note: stopped · no progress for 90 s (the free model went quiet)');
    expect(coder.snapshot(card.id).state).toBe('stopped');
  });

  it('restarts a server that grew too big, but never under somebody\'s work', async () => {
    let restarts = 0;
    const fake = fakeEngine({ step: 60_000 });
    const engine = { ...fake, health: () => ({ running: true, pid: 1, rss: 3 * 1024 ** 3 }), restart: async () => { restarts += 1; } };
    const { coder } = setup(engine);
    await coder.tick();
    expect(restarts).toBe(1);
    await coder.prompt(card, 'Busy', {});
    await coder.tick();
    expect(restarts).toBe(1);
    await coder.stop(card.id);
  });

  it('tells a working card when the server went away, so the next task starts it afresh', async () => {
    const fake = fakeEngine({ step: 60_000 });
    let hear: (event: { type: string; properties: Record<string, unknown> }) => void = () => {};
    const { coder, lines } = setup({ ...fake, listen: (heard) => { hear = heard; return () => {}; } });
    await coder.prompt(card, 'Work', {});
    const waited = coder.wait(card.id);
    hear({ type: GONE, properties: {} });
    expect(await waited).toBe('stopped');
    expect(lines().at(-1)).toBe('error: the coder\'s server stopped; the next task starts it again');
  });

  it('undoes the last thing it was asked, starts a new session on request, and one for a new folder', async () => {
    const { coder, calls, lines, remembered } = setup();
    await coder.prompt(card, 'First', {});
    await coder.wait(card.id);
    await coder.prompt(card, 'Second', {});
    await coder.wait(card.id);
    await coder.undo(card.id);
    const revert = calls.find((one) => one.path.endsWith('/revert'))!;
    expect(revert.body.messageID).toBe('msg_fake0003');
    expect(lines().at(-1)).toBe('note: undone · "Second"');
    await coder.undo(card.id);
    expect(calls.filter((one) => one.path.endsWith('/revert')).at(-1)?.body.messageID).toBe('msg_fake0001');

    await coder.fresh(card.id);
    expect(remembered.at(-1)).toEqual(['coder-1', '']);
    expect(lines().at(-1)).toBe('note: new session · the coder starts from a clean slate');
    await coder.prompt(card, 'Third', {});
    await coder.wait(card.id);
    expect(remembered.at(-1)?.[1]).toMatch(/^ses_/);
    const before = remembered.length;
    await coder.prompt({ ...card, dir: '/code/other' }, 'Elsewhere', {});
    await coder.wait(card.id);
    expect(remembered.length).toBe(before + 1);
  });

  it('lists the models in the order the founder picks from, the free ones first', async () => {
    const { coder } = setup();
    expect(await coder.models()).toEqual({
      default: 'opencode/fake-free',
      groups: [
        { name: 'Free (OpenCode Zen)', models: [{ id: 'opencode/fake-free', name: 'Fake Free' }, { id: 'opencode/other-free', name: 'Other Free' }] },
        { name: 'Your keys', models: [] },
        { name: 'Local', models: [{ id: 'ollama/qwen2.5-coder:7b', name: 'qwen2.5-coder:7b' }] },
      ],
    });
  });

  it('says so on the first step when the local model server is not answering, and starts nothing', async () => {
    const { coder, lines, calls } = setup(undefined);
    const quiet = createCoder({
      engine: { ...fakeEngine({ step: 2 }), call: async (method, path, options) => { calls.push({ method, path }); return fakeEngine().call(method, path, options); } },
      approvals: createApprovals(), say: () => {}, attention: { raise: async () => {}, clear: async () => {} }, remember: async () => {}, env: {},
      reachable: async () => false,
    });
    await quiet.prompt({ ...card, model: 'ollama/qwen2.5-coder:7b' }, 'Local work', {});
    expect(quiet.snapshot(card.id).lines.at(-1)?.text).toBe('the local model server at 127.0.0.1:11434 is not answering. Start it, or pick another model.');
    expect(quiet.snapshot(card.id).state).toBe('stopped');
    expect(calls.some((one) => one.path.endsWith('/prompt_async'))).toBe(false);
    void coder; void lines;
  });
});
