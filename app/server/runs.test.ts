import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApprovals } from './approvals.ts';
import { createBoards } from './boards.ts';
import { createMail } from './mail.ts';
import { buildMessages } from './prompt.ts';
import type { ModelClient } from './providers.ts';
import { createRuns } from './runs.ts';
import { createStore } from './store.ts';
import { docTools } from './tools/docs.ts';
import { outwardTools } from './tools/outward.ts';
import { createUsage } from './usage.ts';

const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 200; i += 1) { if (await check()) return; await new Promise((r) => setTimeout(r, 10)); } throw new Error('timed out'); };

async function setup(script: (string | { name: string; args: unknown })[]) {
  const dir = await mkdtemp(join(tmpdir(), 'runs-'));
  const store = createStore(dir); const boards = createBoards(dir); const approvals = createApprovals();
  const stage = await store.loadStage();
  const seen: string[] = []; const notes: string[] = [];
  const client: ModelClient = { name: 's', model: 's-1', maxPromptChars: Infinity, tools: true, limits: {}, async step(messages, { onToken }) {
    seen.push(String(messages.at(-1)?.content ?? ''));
    const next = script.shift() ?? 'done';
    if (typeof next === 'string') { onToken(next); return { text: '', calls: [], usage: { input: 5, output: 5 } }; }
    return { text: '', calls: [{ id: `call-${script.length}`, name: next.name, args: JSON.stringify(next.args) }] };
  } };
  const sent: unknown[] = [];
  const mail = createMail({ AGENTMAIL_API_KEY: 'k' }, (async (url: string, init?: RequestInit) => { sent.push(init?.body); return new Response(JSON.stringify(String(url).endsWith('/inboxes') ? { inbox_id: 'i', email: 'maya@x' } : {})); }) as typeof fetch);
  const busy = new Set<string>();
  const runs = createRuns({ boards, store, approvals, busy, clients: [client], usage: createUsage(null), tools: [...docTools, ...outwardTools(mail, store.filesDir)], notify: (title, body) => notes.push(`${title} | ${body}`),
    promptFor: async (current, roomId, names, fresh) => buildMessages(current, roomId, {}, fresh ? [] : [{ id: 'old', role: 'user', text: 'OLD CHAT', at: 1 }], names) });
  const task = await boards.add('b1', { title: 'Tighten the brand doc', detail: 'One paragraph.' });
  const state = async () => (await boards.list('b1'))[0];
  return { store, boards, approvals, runs, task, state, seen, notes, sent, busy, stage };
}

describe('runs', () => {
  it('does the task in the background, from a clean slate, and lands the result in Review', async () => {
    const { runs, boards, task, state, seen, notes, store } = await setup([{ name: 'write_doc', args: { doc: 'Brand doc', text: 'Calm tools.' } }, 'Tightened it to one paragraph.']);
    await expect(runs.start('b1', task.id)).rejects.toThrow(/give the task to a person/);
    await boards.change('b1', task.id, { assignee: 'marketing' });
    await runs.start('b1', task.id);
    expect((await state()).column).toBe('doing');
    await until(async () => (await state()).run?.state === 'done');
    const done = await state();
    expect(done).toMatchObject({ column: 'review', run: { result: 'Tightened it to one paragraph.', provider: 's', model: 's-1' } });
    expect(done.run!.log).toEqual(['Maya started', '✓ write_doc Brand doc']);
    expect(await store.readDoc('brand-doc')).toBe('Calm tools.');
    expect(seen[0]).toContain('Task: Tighten the brand doc');
    expect(seen.join('\n')).not.toContain('OLD CHAT');
    expect(notes).toEqual(['Maya finished | Tighten the brand doc']);
  });

  it('parks an outward step on the task, notifies the founder, and goes on only after a yes', async () => {
    const { runs, boards, approvals, task, state, notes, sent } = await setup([{ name: 'send_email', args: { to: 'lead@example.com', subject: 'Hi', body: 'Hello' } }, 'Sent.']);
    await boards.change('b1', task.id, { assignee: 'marketing' });
    await runs.start('b1', task.id);
    await until(async () => (await state()).run?.state === 'waiting');
    const waiting = await state();
    expect(waiting.run!.approval).toMatchObject({ name: 'send_email', waiting: true });
    expect(notes[0]).toBe('Maya needs your OK | Tighten the brand doc: send email');
    expect(sent).toEqual([]);
    await expect(runs.start('b1', task.id)).rejects.toThrow(/already running/);
    approvals.answer(waiting.run!.approval!.id, { ok: true });
    await until(async () => (await state()).run?.state === 'done');
    expect(sent).toHaveLength(2);
    expect((await state()).run!.approval).toBeUndefined();
  });

  it('will not start on a person who is busy, and stops when the founder says stop', async () => {
    const { runs, boards, task, state, busy } = await setup([{ name: 'send_email', args: { to: 'a@b.co', subject: 's', body: 'b' } }, 'never']);
    await boards.change('b1', task.id, { assignee: 'marketing' });
    busy.add('marketing');
    await expect(runs.start('b1', task.id)).rejects.toThrow(/in the middle of something/);
    busy.delete('marketing');
    await runs.start('b1', task.id);
    await until(async () => (await state()).run?.state === 'waiting');
    runs.stop(task.id);
    await until(async () => ['stopped', 'done'].includes((await state()).run?.state ?? ''));
    expect((await state()).column).toBe('review');
    expect(busy.has('marketing')).toBe(false);
  });
});

describe('who set the work going', () => {
  it('is told truthfully to the person doing it', async () => {
    // Pressed by the founder, and then started by something else: the opening sentence says which, every time.
    const told: Record<string, string> = {};
    for (const by of ['founder', 'schedule', 'chain', 'call'] as const) {
      const { runs, boards, task, state, seen } = await setup(['Done.']);
      await boards.change('b1', task.id, { assignee: 'marketing' });
      await runs.start('b1', task.id, by);
      await until(async () => (await state()).run?.state === 'done');
      told[by] = seen[0];
    }
    expect(told.founder).toContain('The founder started this task from the board.');
    expect(told.schedule).toContain('started by itself, on the schedule');
    expect(told.chain).toContain('because the task before it finished');
    expect(told.call).toContain('Another program');
    for (const by of ['schedule', 'chain', 'call']) expect(told[by]).not.toContain('The founder started this task');
  });
});
