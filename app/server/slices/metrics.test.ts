import { mkdtemp, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localDay, type MetricsEvent } from '../../shared/metrics.ts';
import type { Attention } from '../../shared/model.ts';
import { createAttention } from '../attention.ts';
import { hub } from '../events.ts';
import type { Deps } from '../install.ts';
import { createMetrics } from '../metrics/store.ts';
import { createSeams } from '../seams.ts';
import { createStore } from '../store.ts';
import type { Tool, ToolContext } from '../tools/registry.ts';
import metrics, { METRIC_TOOLS } from './metrics.ts';

const CSV = 'date,Weekly active teams,MRR\n2026-09-07,30,"$2,880"\n2026-09-14,34,$3000\n2026-09-21,42,$3120\nnot a day,1,2';

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'metrics-slice-'));
  const store = createStore(workspace);
  const stage = await store.loadStage();
  stage.cards = [{ id: 'metrics-1', kind: 'metrics', title: 'Traction', x: 0, y: 0, w: 1, h: 1 }];
  stage.wires.push({ id: 'w', from: 'marketing', fromHandle: 'r', to: 'metrics-1', toHandle: 'l' });
  await store.saveStage(stage);
  const seams = createSeams();
  const attention = createAttention(workspace);
  const answered: { status: number; body: any }[] = [];
  const told: string[] = [];
  let sent: unknown = {};
  const deps = {
    workspace, root: workspace, fake: true, store, seams, attention, notify: (title: string) => told.push(title),
    json: (_res: ServerResponse, status: number, body: unknown) => { answered.push({ status, body }); },
    body: async () => sent,
  } as unknown as Deps;
  const heard: { channel: string; data: MetricsEvent }[] = [];
  hub.say = (channel, data) => heard.push({ channel, data: data as MetricsEvent });
  const part = await metrics.install(deps);
  const tool = (name: string) => part.tools!.find((one) => one.name === name)!;
  const context = async (roomId = 'marketing'): Promise<ToolContext> => ({ stage: await store.loadStage(), roomId, store, granted: new Map() });
  const use = async (name: string, args: Record<string, unknown>, roomId?: string) => tool(name).run(args, await context(roomId));
  const call = async (path: string, method = 'GET', body: unknown = {}) => { sent = body; await part.route!({ method } as IncomingMessage, {} as ServerResponse, path); return answered.at(-1)!; };
  const read = async () => ((await call('/api/metrics/metrics-1')).body as MetricsEvent).data;
  return { part, store, seams, attention, heard, told, tool, context, use, call, read, workspace };
}

let closing: (() => Promise<void>) | undefined;
afterEach(async () => { await closing?.(); closing = undefined; });

describe('the Metrics card', () => {
  it('is offered only to a person wired to one', async () => {
    const { part, store } = await setup();
    closing = part.close;
    const stage = await store.loadStage();
    const names = (roomId: string) => part.offer!(part.tools!, stage, roomId).map((one: Tool) => one.name);
    expect(names('marketing')).toEqual(METRIC_TOOLS);
    expect(names('build')).toEqual([]);
  });

  it('reads a pasted table, names the rows it skipped, and tells the card', async () => {
    const { part, call, read, heard, workspace } = await setup();
    closing = part.close;
    const result = await call('/api/metrics/metrics-1/import', 'POST', { text: CSV, name: 'sales.csv' });
    expect(result.body).toEqual({ added: 6, replaced: 0, skipped: ['row 5: "not a day" is not a date'] });
    const data = await read();
    expect(data.metrics.map((one) => [one.label, one.unit ?? '', one.northStar ?? false])).toEqual([['Weekly active teams', '', true], ['MRR', '$', false]]);
    expect(data.metrics[0].points.at(-1)).toEqual({ at: '2026-09-21', value: 42, from: 'sales.csv, row 4' });
    expect(heard.at(-1)!.channel).toBe('metrics:metrics-1');
    await part.close!();
    closing = undefined;
    const saved = JSON.parse(await readFile(join(workspace, 'metrics', 'metrics-1.json'), 'utf8'));
    expect(saved.metrics).toHaveLength(2);
  });

  it('puts the compact block in a wired person\'s prompt, and nobody else\'s', async () => {
    const { part, call, seams } = await setup();
    closing = part.close;
    await call('/api/metrics/metrics-1/import', 'POST', { text: CSV, name: 'sales.csv' });
    const turn = async (roomId: string) => (await seams.run('turn:before', { roomId, source: 'chat', query: 'how are we doing?', messages: [{ role: 'system', content: 'You are Maya.' }, { role: 'user', content: 'hi' }] })).messages[0].content;
    expect(await turn('marketing')).toBe([
      'You are Maya.',
      '',
      '- A Metrics card, "Traction". Read more with read_metrics.',
      '  North star: Weekly active teams 42 (+8, +24% vs last week; 2 weeks up).',
      '  MRR $3,120 (+$120). Last entry 2026-09-21.',
    ].join('\n'));
    expect(await turn('build')).toBe('You are Maya.');
    // The fake model's view of the last step is kept for the browser test.
    await seams.run('step:before', { roomId: 'marketing', step: 0, messages: [{ role: 'system', content: await turn('marketing') }] });
    expect((await call('/api/metrics/metrics-1/heard/marketing')).body.text).toContain('North star: Weekly active teams 42');
  });

  it('reads the readings back with where each came from', async () => {
    const { part, call, use } = await setup();
    closing = part.close;
    await call('/api/metrics/metrics-1/import', 'POST', { text: CSV, name: 'sales.csv' });
    const all = (await use('read_metrics', {})).text;
    expect(all).toContain('"Traction", weekly card; today is');
    expect(all).toContain('Weekly active teams (key weekly-active-teams, better up, north star)\n- 2026-09-07: 30 · sales.csv, row 2');
    expect((await use('read_metrics', { key: 'mrr', since: '2026-09-20' })).text).toContain('MRR (key mrr, better up)\n- 2026-09-21: $3,120 · sales.csv, row 4');
    await expect(use('read_metrics', {}, 'build')).rejects.toThrow('no Metrics card is connected');
  });

  it('always asks the founder before a person writes a number, and says who wrote it', async () => {
    const { part, tool, context, use, read, call } = await setup();
    closing = part.close;
    await call('/api/metrics/metrics-1/import', 'POST', { text: CSV, name: 'sales.csv' });
    const log = tool('log_metric');
    expect(typeof log.approval).toBe('function');
    const question = await (log.approval as (args: Record<string, unknown>, context: ToolContext) => Promise<string | null>)({ key: 'MRR', value: 3300, at: '2026-09-28', source: 'founder in chat' }, await context());
    expect(question).toBe('Write $3,300 for MRR on 2026-09-28?');
    expect((await use('log_metric', { key: 'MRR', value: 3300, at: '2026-09-28', source: 'founder in chat' })).text).toBe('Wrote $3,300 for MRR on 2026-09-28.');
    expect((await read()).metrics[1].points.at(-1)).toEqual({ at: '2026-09-28', value: 3300, from: 'founder in chat, logged by Maya' });
    await expect(use('log_metric', { key: 'MRR', value: 1, at: 'Monday', source: 'x' })).rejects.toThrow('YYYY-MM-DD');
  });

  it('puts a suggested target in Needs you, and the founder\'s yes sets it', async () => {
    const { part, call, use, attention, read } = await setup();
    closing = part.close;
    await call('/api/metrics/metrics-1/import', 'POST', { text: CSV, name: 'sales.csv' });
    expect((await use('propose_target', { key: 'weekly active teams', value: 100, by: '2026-12-31', why: 'Seed round needs it' })).text)
      .toBe('Suggested 100 by 2026-12-31 for Weekly active teams. It waits in Needs you for the founder.');
    const waiting = (await attention.list()).filter((one: Attention) => one.kind === 'proposed-target');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ title: 'Weekly active teams: 100 by 2026-12-31', who: 'Maya', cardId: 'metrics-1', detail: 'Seed round needs it Now 42.' });
    const proposalId = waiting[0].id.split(':')[2];
    expect((await call(`/api/metrics/metrics-1/proposals/${proposalId}`, 'POST', { accept: true })).status).toBe(200);
    expect((await read()).metrics[0].target).toEqual({ value: 100, by: '2026-12-31' });
    expect((await attention.list()).filter((one: Attention) => one.kind === 'proposed-target')).toEqual([]);
    expect((await call(`/api/metrics/metrics-1/proposals/${proposalId}`, 'POST', { accept: true })).status).toBe(400);
    await expect(use('propose_target', { key: 'MRR', value: 5000, by: 'soon' })).rejects.toThrow('YYYY-MM-DD');
  });

  it('raises alerts from the tick, only new ones notify, and a dismissed one stays gone', async () => {
    const { part, call, attention, told } = await setup();
    closing = part.close;
    await part.tick!();
    // Three weeks worse in a row, long ago: both falling and quiet.
    await call('/api/metrics/metrics-1/import', 'POST', { text: 'date,Signups\n2026-01-05,9\n2026-01-12,8\n2026-01-19,7\n2026-01-26,6', name: 'old.csv' });
    await part.tick!();
    const raised = (await attention.list()).filter((one: Attention) => one.kind === 'metric-alert');
    expect(raised.map((one) => one.title)).toEqual(expect.arrayContaining(['Signups got worse 3 weeks in a row', expect.stringMatching(/^No entry for Signups in \d+ days$/)]));
    expect(told).toHaveLength(1);
    await part.tick!();
    expect(told).toHaveLength(1);
    const falling = raised.find((one) => one.title.includes('worse'))!;
    expect((await call('/api/metrics/metrics-1/dismiss', 'POST', { id: falling.id })).status).toBe(200);
    expect((await attention.list()).some((one: Attention) => one.id === falling.id)).toBe(false);
    expect((await call('/api/metrics/metrics-1/dismiss', 'POST', { id: 'proposed-source:x' })).status).toBe(400);
  });

  it('lets the founder type today\'s value, pick the north star, and remove a number', async () => {
    const { part, call, read } = await setup();
    closing = part.close;
    await call('/api/metrics/metrics-1/import', 'POST', { text: CSV, name: 'sales.csv' });
    await call('/api/metrics/metrics-1/log', 'POST', { key: 'MRR', value: 3200 });
    expect((await read()).metrics[1].points.at(-1)).toEqual({ at: localDay(Date.now()), value: 3200, from: 'founder, typed' });
    await call('/api/metrics/metrics-1/numbers/mrr', 'PATCH', { northStar: true });
    expect((await read()).metrics.map((one) => one.northStar ?? false)).toEqual([false, true]);
    await call('/api/metrics/metrics-1/numbers/mrr', 'DELETE');
    expect((await read()).metrics.map((one) => [one.label, one.northStar])).toEqual([['Weekly active teams', true]]);
    expect((await call('/api/metrics/nope')).status).toBe(404);
  });
});

describe('the store', () => {
  it('keeps one card\'s numbers across a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'metrics-store-'));
    const one = createMetrics(dir);
    await one.log('c1', { ref: 'Signups', value: 5, at: '2026-09-01', from: 'founder' });
    await one.settled();
    const two = createMetrics(dir);
    expect((await two.load('c1')).metrics[0]).toMatchObject({ key: 'signups', label: 'Signups', better: 'up', northStar: true, points: [{ at: '2026-09-01', value: 5, from: 'founder' }] });
    await expect(two.load('../x')).rejects.toThrow('bad id');
  });
});
