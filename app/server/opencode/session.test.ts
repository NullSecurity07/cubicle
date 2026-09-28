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
function setup(engine: Engine & Partial<ReturnType<typeof fakeEngine>> = fakeEngine({ step: 2 }), extra: { now?: () => number; reachable?: (url: string) => Promise<boolean>; map?: Parameters<typeof createCoder>[0]['map'] } = {}) {
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

  it('shows what the coder does as it happens, counts each answer\'s tokens once and lets it go at the end', async () => {
    const { coder, said } = setup();
    await coder.prompt(card, 'Add a health check', {});
    expect(await coder.wait(card.id)).toBe('done');
    const live = said.filter((one) => one.live !== undefined).map((one) => one.live);
    const at = (check: (one: NonNullable<CoderEvent['live']>) => boolean) => live.findIndex((one) => !!one && check(one));
    const thinking = at((one) => one.thinking);
    const editing = at((one) => one.tools.some((tool) => tool.tool === 'edit' && tool.what === 'src/example.ts'));
    const writing = at((one) => one.text.startsWith('Did:'));
    expect(thinking).toBeGreaterThan(-1);
    expect(editing).toBeGreaterThan(thinking);
    expect(writing).toBeGreaterThan(editing);
    expect(live[thinking]).toMatchObject({ step: 1, tokens: { input: 1200 } });
    // The answer is said three times over its life; its tokens count once, the latest word.
    const last = live.at(-2)!;
    expect(last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache).toBe(1300);
    expect(last.text).toBe('');
    expect(live.at(-1)).toBeNull();
    expect(coder.snapshot(card.id).live).toBeNull();
  });

  it('never shows the founder\'s own words as the reply being written', async () => {
    // The real opencode echoes the prompt as a text part of the founder's message before the coder's first step.
    const fake = fakeEngine({ step: 30 });
    let ear: ((event: any) => void) | undefined;
    const engine: Engine = { ...fake, listen: (hear) => { ear = hear; return fake.listen(hear); } };
    const { coder, said } = setup(engine);
    await coder.prompt(card, 'Tidy the readme', {});
    const session = [...fake.sessions.keys()][0];
    ear!({ type: 'message.updated', properties: { info: { id: 'msg_user', sessionID: session, role: 'user' } } });
    ear!({ type: 'message.part.updated', properties: { sessionID: session, part: { id: 'prt_user', sessionID: session, messageID: 'msg_user', type: 'text', text: 'Tidy the readme' } } });
    ear!({ type: 'message.part.delta', properties: { sessionID: session, messageID: 'msg_user', partID: 'prt_user', field: 'text', delta: ' please' } });
    await coder.wait(card.id);
    const texts = said.filter((one) => one.live).map((one) => one.live!.text);
    expect(texts.some((text) => text.includes('Tidy the readme'))).toBe(false);
    expect(texts.some((text) => text.startsWith('Did:'))).toBe(true);
  });

  it('says what runs now while a question waits, and lets the live view go on Stop', async () => {
    const { coder, said } = setup();
    await coder.prompt(card, 'Run the test suite', {});
    await until(() => coder.snapshot(card.id).state === 'waiting');
    expect(coder.snapshot(card.id).live?.tools).toEqual([expect.objectContaining({ tool: 'bash', what: 'pnpm test' })]);
    expect(await coder.status(card.id)).toMatch(/^Now: running bash pnpm test \(\d+ s\)$/m);
    const before = said.length;
    await coder.stop(card.id);
    expect(said.slice(before).filter((one) => one.live !== undefined).map((one) => one.live)).toEqual([null]);
    expect(coder.snapshot(card.id).live).toBeNull();
    expect(await coder.status(card.id)).not.toContain('Now:');
  });

  it('asks the founder before a command, and carries "always" and a reason back to the coder', async () => {
    const { coder, raised, cleared, calls, approvals, lines } = setup();
    await coder.prompt(card, 'Run the test suite', {});
    await until(() => coder.snapshot(card.id).state === 'waiting');
    const asked = coder.snapshot(card.id).permission!;
    expect(asked).toMatchObject({ tool: 'bash', what: 'pnpm test', always: ['pnpm *'] });
    expect(raised[0]).toMatchObject({ id: `coder:${asked.id}`, kind: 'approval', title: 'Allow the coder to run pnpm test?', cardId: 'coder-1', who: 'The shop coder' });
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

  it('holds two questions asked together, shows them one after another, and stays waiting until both are answered', async () => {
    let now = 1_000_000;
    const { coder, said, raised, calls, approvals, lines } = setup(fakeEngine({ step: 2, gap: 200 }), { now: () => now });
    await coder.prompt(card, 'Change the file and run the tests, both', {});
    await until(() => raised.length === 2);
    const [edit, bash] = raised.map((one) => one.coder!);
    expect([edit.tool, bash.tool]).toEqual(['edit', 'bash']);
    // The first waits at the foot of the log, the second behind it.
    expect(coder.snapshot(card.id)).toMatchObject({ state: 'waiting', permission: { id: edit.id }, waiting: 1 });
    expect(said.at(-1)).toMatchObject({ waiting: 1 });
    // Time spent waiting for the founder is never the coder going quiet.
    now += 5 * 60_000;
    await coder.tick();
    expect(calls.some((one) => one.path.endsWith('/abort'))).toBe(false);
    approvals.answer(`coder:${edit.id}`, { ok: true, args: { reply: 'once' } });
    await until(() => coder.snapshot(card.id).permission?.id === bash.id);
    expect(coder.snapshot(card.id)).toMatchObject({ state: 'waiting', waiting: 0 });
    approvals.answer(`coder:${bash.id}`, { ok: true, args: { reply: 'once' } });
    expect(await coder.wait(card.id)).toBe('done');
    expect(calls.filter((one) => one.path.startsWith('/permission/')).map((one) => one.path)).toEqual([`/permission/${edit.id}/reply`, `/permission/${bash.id}/reply`]);
    expect(lines()).toEqual(expect.arrayContaining(['note: allowed · edit src/example.ts', 'note: allowed · bash pnpm test', 'tool: bash pnpm test']));
    expect(coder.snapshot(card.id)).toMatchObject({ state: 'idle', permission: undefined, waiting: 0 });
  });

  it('settles every waiting question by its own id when the coder is stopped or answers them itself', async () => {
    const { coder, raised, approvals, lines } = setup(fakeEngine({ step: 2, gap: 5 }));
    await coder.prompt(card, 'Both at once', {});
    await until(() => raised.length === 2);
    await coder.stop(card.id);
    expect(coder.snapshot(card.id)).toMatchObject({ state: 'stopped', permission: undefined, waiting: 0 });
    expect(lines().filter((one) => one.startsWith('note: said no'))).toHaveLength(2);
    // Nothing is left in the book for anybody to answer.
    expect(approvals.answer(`coder:${raised[0].coder!.id}`, { ok: true })).toBe(false);
    expect(approvals.answer(`coder:${raised[1].coder!.id}`, { ok: true })).toBe(false);
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
    expect(lines().at(-1)).toBe('note: stopped · no progress for 90 s (the model went quiet)');
    expect(coder.snapshot(card.id).state).toBe('stopped');
  });

  it('gives a model on this machine ten minutes of quiet, since a slow CPU reads the prompt for that long', async () => {
    let now = 1_000_000;
    const { coder, calls, lines } = setup(fakeEngine({ step: 60_000 * 20, now: () => now }), { now: () => now, reachable: async () => true });
    await coder.prompt({ ...card, model: 'ollama/qwen3:30b-a3b' }, 'Slow local work', {});
    const waited = coder.wait(card.id);
    now += 9 * 60_000;
    await coder.tick();
    expect(calls.some((one) => one.path.endsWith('/abort'))).toBe(false);
    now += 2 * 60_000;
    await coder.tick();
    expect(await waited).toBe('stopped');
    expect(lines().at(-1)).toBe('note: stopped · no progress for 10 minutes (the local model is stuck, or too slow for this machine)');
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
    // The diff opencode says after the undo is not a line: nothing changed that the founder should be told of.
    await new Promise((settle) => setTimeout(settle, 5));
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

  it('never counts changes already in the folder as the coder\'s work', async () => {
    // A session diff that is empty (a command changed nothing, or nothing was asked to change) and a folder with an
    // old uncommitted change in it: the coder did not do that, and the card does not say it did.
    const fake = fakeEngine({ step: 2 });
    const theirs = [{ file: 'README.md', patch: '', additions: 1, deletions: 1 }];
    const engine = { ...fake, call: async (method: string, path: string, options?: any) => (path.endsWith('/diff') && path.startsWith('/session/') ? [] : path.startsWith('/vcs/diff') ? theirs : fake.call(method, path, options)) };
    const { coder, lines } = setup(engine as never);
    await coder.prompt(card, 'Reply with ok', {});
    await coder.wait(card.id);
    expect(lines().filter((one) => one.startsWith('diff:'))).toEqual(['diff: +12 −3 in 1 file']);
    expect(await coder.result(card.id)).toContain('No files changed.');
  });

  it('lists the models in the order the founder picks from, the free ones first', async () => {
    const { coder } = setup();
    expect(await coder.models()).toEqual({
      default: 'opencode/fake-free',
      groups: [
        { name: 'Free (OpenCode Zen)', models: [{ id: 'opencode/fake-free', name: 'Fake Free' }, { id: 'opencode/other-free', name: 'Other Free' }] },
        { name: 'Your keys', models: [{ id: 'google/gemini-3-flash', name: 'Gemini 3 Flash' }, { id: 'groq/llama-3.3-70b-versatile', name: 'Llama 3.3 70B' }] },
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

  it('hands a mapped folder\'s map to the coder once, and tells it so in one sentence', async () => {
    const mcp = { type: 'local' as const, command: ['graphify-mcp', '/w/graphs/shop/graphify-out/graph.json'], enabled: true as const };
    const { coder, calls, engine } = setup(fakeEngine({ step: 2 }), { map: async (dir) => (dir === card.dir ? { mcp, hint: 'This folder has a knowledge graph.' } : null) });
    await coder.prompt(card, 'Where is checkout?', {});
    await coder.wait(card.id);
    expect(calls.filter((one) => one.method === 'POST' && one.path === '/mcp').map((one) => one.body)).toEqual([{ name: 'graphify', config: mcp }]);
    expect(calls.find((one) => one.path.endsWith('/prompt_async'))?.body.system).toBe('This folder has a knowledge graph.');
    expect(engine.mcp?.get(card.dir)?.has('graphify')).toBe(true);
    // Already running in that folder: not started twice.
    await coder.prompt(card, 'And the cart?', {});
    await coder.wait(card.id);
    expect(calls.filter((one) => one.method === 'POST' && one.path === '/mcp')).toHaveLength(1);
  });

  it('works without the map, and says so on the card, when its tool server will not start', async () => {
    const base = fakeEngine({ step: 2 });
    const failing: Engine = { ...base, call: async (method, path, options) => (path === '/mcp' && method === 'POST' ? { graphify: { status: 'failed', error: 'MCP error -32000: Connection closed' } } as never : base.call(method, path, options)) };
    const { coder, calls, lines } = setup(failing, { map: async () => ({ mcp: { type: 'local', command: ['graphify-mcp', 'x'], enabled: true }, hint: 'hint' }) });
    await coder.prompt(card, 'Go', {});
    await coder.wait(card.id);
    expect(calls.find((one) => one.path.endsWith('/prompt_async'))?.body).not.toHaveProperty('system');
    expect(lines()).toContain('note: the folder\'s map could not be handed to the coder (MCP error -32000: Connection closed); it reads the files instead');
  });
});
