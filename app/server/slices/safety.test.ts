import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { Attention } from '../../shared/model.ts';
import { createApprovals } from '../approvals.ts';
import type { Deps } from '../install.ts';
import { createSeams } from '../seams.ts';
import { UNANSWERED, WAITED_TOO_LONG } from '../safety/waiting.ts';
import safety from './safety.ts';

const stage = { rooms: [{ id: 'marketing', name: 'Maya', role: 'Marketing', accent: '#ee8a72', brief: '', x: 0, y: 0, w: 1, h: 1 }], docs: [], wires: [], cards: [] };
const email = { to: 'alex@example.com', subject: 'Hello', body: 'Hi there' };

// Everything the safety extra really reaches for, and nothing else: a workspace, the stage, the seams, the answers
// waiting for the founder and the two http helpers.
async function setup(said: unknown = {}) {
  let asked = said;
  const workspace = await mkdtemp(join(tmpdir(), 'workspace-'));
  const seams = createSeams();
  const approvals = createApprovals();
  const raised: Attention[] = [];
  let waiting: Attention[] = [];
  const answered: unknown[] = [];
  const deps = {
    workspace, root: workspace, store: { loadStage: async () => stage, readChat: async () => [], cutChat: async () => [] },
    seams, approvals, attention: { list: async () => waiting, raise: async (one: Attention) => { raised.push(one); } },
    json: (_res: ServerResponse, status: number, body: unknown) => { answered.push({ status, body }); },
    body: async () => asked,
  } as unknown as Deps;
  const part = await safety.install(deps);
  const call = (path: string, method = 'POST') => part.route!({ method } as IncomingMessage, {} as ServerResponse, path);
  return { seams, approvals, part, call, answered, raised, say: (next: unknown) => { asked = next; }, wait: (list: Attention[]) => { waiting = list; } };
}

const asking = (name: string, args: Record<string, unknown>, id = 'call-1') => ({ roomId: 'marketing', call: { id, name, args } });

describe('the safety extra', () => {
  it('stops what must not happen, and leaves a refusal that was already there alone', async () => {
    const { seams } = await setup();
    expect((await seams.run('tool:before', asking('run_code', { language: 'python', code: 'os.system("rm -rf /")' }))).refusal).toContain('erased a whole disk');
    const ready = await seams.run('tool:before', { ...asking('send_email', email), refusal: 'Your own mailbox is not set up yet.' });
    expect(ready.refusal).toBe('Your own mailbox is not set up yet.');
  });

  it('remembers a standing yes from the call itself, and skips only that question afterwards', async () => {
    const { seams, call, answered, say } = await setup({ id: 'call-1', args: { to: 'alex@example.com' } });
    expect((await seams.run('tool:before', asking('send_email', email))).approved).toBeUndefined();
    expect(await call('/api/safety/rules')).toBe(true);
    expect(answered.at(-1)).toMatchObject({ status: 200, body: { who: 'Maya', tool: 'send_email', reach: 'alex@example.com' } });

    expect((await seams.run('tool:before', asking('send_email', email, 'call-2'))).approved).toBe(true);
    expect((await seams.run('tool:before', asking('send_email', { ...email, to: 'sam@example.com' }, 'call-3'))).approved).toBeUndefined();
    // Once a step is over it cannot be turned into a rule any more, whatever a page says.
    await seams.run('tool:after', { roomId: 'marketing', event: { id: 'call-1', name: 'send_email', args: email, ok: true, result: 'Sent.' } });
    say({ id: 'call-1', args: { to: 'anybody@example.com' } });
    expect(await call('/api/safety/rules')).toBe(true);
    expect(answered.at(-1)).toMatchObject({ status: 404 });
  });

  it('takes a key out of what comes back before anybody reads it', async () => {
    const { seams } = await setup();
    const after = await seams.run('tool:after', { roomId: 'marketing', event: { id: 'call-1', name: 'read_file', args: {}, ok: true, result: 'the deploy key is ghp_abcdefghijklmnopqrstuvwxyz0123' } });
    expect(after.event.result).toBe('the deploy key is [key hidden]');
  });

  it('turns a question nobody answered in half a day into a no, and says so where the founder looks', async () => {
    const { approvals, part, wait, raised } = await setup();
    const event = { id: 'call-1', name: 'send_email', args: email, waiting: true };
    wait([{ id: 'approval:call-1', kind: 'run-approval', title: 'Send this email?', at: Date.now() - WAITED_TOO_LONG - 1000, who: 'Maya', roomId: 'marketing', cardId: 'board', taskId: 'task-1', event }]);
    const answer = approvals.ask('call-1');
    await part.tick!();
    expect(await answer).toEqual({ ok: false, args: { message: 'no answer in time' } });
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ kind: 'run-failed', title: 'Send this email?', detail: UNANSWERED, taskId: 'task-1' });
  });

  it('says no to a coder\'s question nobody answered, and leaves a fresh one waiting', async () => {
    const { approvals, part, wait } = await setup();
    const asked = (id: string, at: number): Attention => ({ id: `coder:${id}`, kind: 'approval', title: 'Allow the coder to run pnpm test?', at, cardId: 'coder-1', event: { id: `coder:${id}`, name: 'coder_permission', args: { command: 'pnpm test' }, waiting: true } });
    wait([asked('per_old', Date.now() - WAITED_TOO_LONG - 1000), asked('per_new', Date.now())]);
    const old = approvals.ask('coder:per_old');
    let fresh = false;
    void approvals.ask('coder:per_new').then(() => { fresh = true; });
    await part.tick!();
    expect(await old).toEqual({ ok: false, args: { message: 'no answer in time' } });
    expect(fresh).toBe(false);
  });
});
