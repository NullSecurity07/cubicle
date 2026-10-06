import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Lead } from '../../shared/leads.ts';
import type { Metric } from '../../shared/metrics.ts';
import type { Attention, Stage } from '../../shared/model.ts';
import type { FounderPromise } from './promises.ts';
import { budgetUsed, createWatch, dailyBudget, fakeWatchReply, killLineOf, metricSparks, proposalOf, towardLine, trending, type Acts, type Budget, type Proposal, type WatchDeps } from './watch.ts';

const NOON = new Date('2026-10-06T12:00:00').getTime();
const DAY = 86_400_000;
const signups = (...values: [string, number][]): Metric => ({ key: 'signups', label: 'Signups', better: 'up', points: values.map(([at, value]) => ({ at, value, from: 'founder' })) });
const killCheck = (what = 'weekly signups below 5'): FounderPromise => ({ id: 'promise-kill', what, due: '2026-10-30', said: '2026-10-01', at: NOON - 5 * DAY, status: 'open', check: true });

describe('the kill-signal trend', () => {
  it('is raised past half the distance from the verdict-time value to the line, and not before', () => {
    expect(trending(towardLine(6, 5.5, 5))).toBe(true);
    expect(trending(towardLine(6, 5.8, 5))).toBe(false);
    expect(towardLine(6, 4, 5)).toMatchObject({ crossed: true });
    // A line above, for a number that should stay low.
    expect(trending(towardLine(2, 5, 8))).toBe(true);
    expect(towardLine(5, 5, 5)).toBeNull();
  });

  it('reads the row and the line out of the kill signal\'s words', () => {
    const churn: Metric = { key: 'churn', label: 'Churn', better: 'down', unit: '%', points: [] };
    expect(killLineOf('weekly signups below 5', [churn, signups()])).toMatchObject({ metric: { key: 'signups' }, line: 5 });
    expect(killLineOf('churn above 8% for two weeks', [churn, signups()])).toMatchObject({ metric: { key: 'churn' }, line: 8 });
    expect(killLineOf('fewer than 3 paying offices', [signups()])).toBeNull();
    expect(killLineOf('signups stay low', [signups()])).toBeNull();
  });

  it('fixture: kill line 5, 6 at the verdict, 5.5 now: raised once; 5.8: not', () => {
    const raised = metricSparks([{ cardId: 'm1', metrics: [signups(['2026-09-30', 6], ['2026-10-05', 5.5])] }], killCheck(), [], NOON);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ kind: 'metric', why: 'Signups is trending to the kill line', key: 'kill:promise-kill:signups' });
    expect(raised[0].number).toBe('Signups: 5.5 on 2026-10-05, from 6 on 2026-09-30; the kill line is 5 (weekly signups below 5, checked on 2026-10-30).');
    expect(metricSparks([{ cardId: 'm1', metrics: [signups(['2026-09-30', 6], ['2026-10-05', 5.8])] }], killCheck(), [], NOON)).toHaveLength(0);
    // No reading since the verdict: nothing has moved.
    expect(metricSparks([{ cardId: 'm1', metrics: [signups(['2026-09-30', 6])] }], killCheck(), [], NOON)).toHaveLength(0);
  });

  it('wakes on an open bet half-way to its target from the day it was taken', () => {
    const bet = { id: 'bet-1', made: '2026-10-01', what: 'Founder calls', hypothesis: 'calls lift signups', metric: 'signups', target: 10, checkDate: '2026-10-20', status: 'open' as const, at: 0 };
    expect(metricSparks([{ cardId: 'm1', metrics: [signups(['2026-10-01', 4], ['2026-10-05', 7])] }], undefined, [bet], NOON)[0]).toMatchObject({ key: 'bet:bet-1', why: 'the bet "Founder calls" is half-way to its target' });
    expect(metricSparks([{ cardId: 'm1', metrics: [signups(['2026-10-01', 4], ['2026-10-05', 6])] }], undefined, [bet], NOON)).toHaveLength(0);
  });
});

describe('the partner\'s answer, read into something ready to run', () => {
  const spark = metricSparks([{ cardId: 'm1', metrics: [signups(['2026-09-30', 6], ['2026-10-05', 4])] }], killCheck(), [], NOON)[0];
  it('takes a task with a day this week, or a decision, and fills a missing day', () => {
    expect(proposalOf(spark, 'Move: Call five lapsed signups.\nTask: Call five lapsed signups\nDue: 2026-10-08', '2026-10-06')).toMatchObject({ move: 'Call five lapsed signups.', draft: { kind: 'task', title: 'Call five lapsed signups', due: '2026-10-08' } });
    expect(proposalOf(spark, 'Move: Pause paid ads.\nDecision: Pause paid ads until signups recover', '2026-10-06').draft).toEqual({ kind: 'decision', title: 'Pause paid ads until signups recover' });
    expect(proposalOf(spark, 'Move: Call them.\nTask: Call them\nDue: 2027-01-01', '2026-10-06').draft).toMatchObject({ due: '2026-10-07' });
    // Nothing usable came back: still a task the founder can run.
    expect(proposalOf(spark, '', '2026-10-06')).toMatchObject({ draft: { kind: 'task', due: '2026-10-07' } });
  });
});

// ---------------------------------------------------------------- the watch end to end, on fixtures

async function rig(over: { budget?: Budget; reply?: (asked: string) => string; vet?: WatchDeps['vet'] } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'watch-'));
  let clock = NOON;
  const stage: Stage = { rooms: [{ id: 'sam', name: 'Sam', role: 'partner', accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1, partner: true }], docs: [], wires: [], cards: [{ id: 'm1', kind: 'metrics', x: 0, y: 0, w: 1, h: 1 }, { id: 'l1', kind: 'leads', x: 0, y: 0, w: 1, h: 1 }] } as unknown as Stage;
  const world = { metrics: [signups(['2026-09-30', 6])], leads: [] as Lead[], promises: [killCheck()] as FounderPromise[], rows: [] as Attention[] };
  const writeMetrics = async () => { await mkdir(join(workspace, 'metrics'), { recursive: true }); await writeFile(join(workspace, 'metrics', 'm1.json'), JSON.stringify({ metrics: world.metrics, updatedAt: 0 })); };
  await writeMetrics();
  const asked: string[] = [];
  const ran: string[] = [];
  const acts: Acts = {
    async email(draft) { ran.push(`email ${draft.to}`); },
    async task(draft) { ran.push(`task ${draft.title} ${draft.due}`); },
    async decision(draft) { ran.push(`decision ${draft.title}`); },
    async drop(draft) { ran.push(`drop ${draft.promiseId}`); },
  };
  const watch = createWatch({
    workspace, now: () => clock, busy: new Set(), budget: over.budget ?? dailyBudget(workspace, () => clock),
    stage: async () => stage, attention: async () => world.rows, promises: async () => world.promises, bets: async () => [], leads: async () => world.leads,
    promptFor: async () => [{ role: 'system', content: 'You are Sam, the partner.' }],
    ask: async (messages) => { const text = messages.at(-1)!.content; asked.push(text); return { text: over.reply ? over.reply(text) : fakeWatchReply(messages), provider: 'cheap' }; },
    acts, changed: async () => {}, ...(over.vet ? { vet: over.vet } : {}),
  });
  return { watch, world, writeMetrics, asked, ran, workspace, at: (time: number) => { clock = time; } };
}
const lead = (stage: Lead['stage'], email?: string): Lead => ({ id: 'lead-ana', person: { name: 'Ana Ruiz', title: 'Office manager', ...(email ? { email } : {}) }, company: { name: 'Kontor' }, stage, notes: [], source: 'founder', addedAt: 0, updatedAt: stage === 'replied' ? 2 : 1 });

describe('the partner watch', () => {
  it('(a) a reading past the kill line: one Sam proposes row with the number, the draft and Unasked, never twice', async () => {
    const { watch, world, writeMetrics, asked, ran } = await rig();
    expect((await watch.look()).made).toHaveLength(0);
    world.metrics = [signups(['2026-09-30', 6], ['2026-10-06', 4])];
    await writeMetrics();
    const { made } = await watch.look();
    expect(made).toHaveLength(1);
    expect(asked[0]).toContain('Nobody asked you');
    expect(asked[0]).toContain('Signups: 4 on 2026-10-06, from 6 on 2026-09-30; the kill line is 5');
    const [row] = await watch.rows();
    expect(row).toMatchObject({ kind: 'partner-proposal', who: 'Sam', roomId: 'sam', title: 'Sam proposes: Call five lapsed signups this week and ask what stopped them.' });
    expect(row.detail).toContain('Unasked · Signups crossed the kill line.');
    expect(row.detail).toContain('Signups: 4 on 2026-10-06');
    expect(row.detail).toContain('Ready: the task "Call five lapsed signups this week and ask what stopped them", due 2026-10-07');
    // The same signal on the next tick: no second row, no second turn.
    await watch.look();
    expect(await watch.rows()).toHaveLength(1);
    expect(asked).toHaveLength(1);
    // Run puts the task on the board; the row goes, and does not come back.
    await watch.answer(made[0].id, true);
    expect(ran).toEqual(['task Call five lapsed signups this week and ask what stopped them 2026-10-07']);
    await watch.look();
    expect(await watch.rows()).toHaveLength(0);
    expect(asked).toHaveLength(1);
  });

  it('(b) a lead moved to Replied: a reply draft to the address on record; with no address, a task', async () => {
    const { watch, world, ran } = await rig();
    world.promises = [];
    world.leads = [lead('contacted', 'ana@kontor.de')];
    await watch.look();
    expect(await watch.rows()).toHaveLength(0);
    world.leads = [lead('replied', 'ana@kontor.de')];
    await watch.look();
    const [row] = await watch.rows();
    expect(row.title).toBe('Sam proposes: Reply today and offer a 20-minute call.');
    expect(row.detail).toContain('Unasked · Ana Ruiz moved to Replied.');
    expect(row.detail).toContain('Ana Ruiz (Kontor) moved from Contacted to Replied.');
    expect(row.detail).toContain('Ready: an email to ana@kontor.de, "Thanks for your reply"');
    await watch.answer(row.id.split(':')[1], true);
    expect(ran).toEqual(['email ana@kontor.de']);

    // A model that writes another address is not listened to: the address is the lead's own.
    const other = await rig({ reply: () => 'Move: Reply.\nSubject: Hello\nBody: To: boss@kontor.de\nHi Ana' });
    other.world.promises = [];
    other.world.leads = [lead('contacted', 'ana@kontor.de')];
    await other.watch.look();
    other.world.leads = [lead('replied', 'ana@kontor.de')];
    const { made } = await other.watch.look();
    expect(made[0].draft).toMatchObject({ kind: 'email', to: 'ana@kontor.de', subject: 'Hello' });

    const none = await rig();
    none.world.promises = [];
    none.world.leads = [lead('contacted')];
    await none.watch.look();
    none.world.leads = [lead('replied')];
    expect((await none.watch.look()).made[0].draft.kind).toBe('task');
  });

  it('(c) a watched page changed: a paragraph on what it means for us, and one move', async () => {
    const { watch, world } = await rig();
    world.promises = [];
    world.rows = [{ id: 'page-changed:w1:1700', kind: 'page-changed', title: 'The page Rival pricing changed', detail: 'https://rival.example/pricing\n- €49\n+ €29', at: NOON, who: 'Tom' }];
    await watch.look();
    const [row] = await watch.rows();
    expect(row.title).toBe('Sam proposes: Check whether their change undercuts our price.');
    expect(row.detail).toContain('Unasked · the page Rival pricing changed.');
    expect(row.detail).toContain('The page changed its offer; it matters if it now competes with our price.');
    expect(row.detail).toContain('Ready: the task');
  });

  it('(d) a promise two days late: a dated task, or a drop-it decision the founder runs', async () => {
    const late = (days: number): FounderPromise => ({ id: 'promise-calls', what: 'call 5 beta users', due: new Date(NOON - days * DAY).toISOString().slice(0, 10), said: '2026-09-28', at: 0, status: 'open' });
    const one = await rig();
    one.world.promises = [late(1)];
    expect((await one.watch.look()).made).toHaveLength(0);
    one.world.promises = [late(2)];
    const [proposal] = (await one.watch.look()).made;
    expect(proposal.why).toBe('"call 5 beta users" is 2 days late');
    expect(proposal.draft).toMatchObject({ kind: 'task' });

    const drop = await rig({ reply: () => 'Move: Let it go; the survey answered the question.\nDrop: the survey already answered it' });
    drop.world.promises = [late(3)];
    const [dropped] = (await drop.watch.look()).made;
    expect(dropped.draft).toEqual({ kind: 'drop', promiseId: 'promise-calls', what: 'call 5 beta users' });
    expect((await drop.watch.rows())[0].detail).toContain('Ready: drop the promise "call 5 beta users"');
    await drop.watch.answer(dropped.id, true);
    expect(drop.ran).toEqual(['drop promise-calls']);
    // Don't: the row goes and nothing runs.
    const no = await rig();
    no.world.promises = [late(3)];
    const [kept] = (await no.watch.look()).made;
    await no.watch.answer(kept.id, false);
    expect(no.ran).toEqual([]);
    expect(await no.watch.rows()).toHaveLength(0);
  });

  it('caps unasked turns at three a day, most money at risk first; the rest wait with the budget\'s words, kept across a restart', async () => {
    const { watch, world, writeMetrics, asked, workspace, at } = await rig();
    world.metrics = [signups(['2026-09-30', 6], ['2026-10-06', 4])];
    await writeMetrics();
    world.promises = [killCheck(), { id: 'promise-a', what: 'send the deck', due: '2026-10-01', said: '2026-09-28', at: 0, status: 'open' }];
    world.rows = [1, 2, 3].map((n) => ({ id: `page-changed:w${n}:${n}`, kind: 'page-changed' as const, title: `The page P${n} changed`, at: NOON }));
    const { made, waiting } = await watch.look();
    expect(made.map((one) => one.sparkKind)).toEqual(['metric', 'promise', 'page']);
    expect(asked).toHaveLength(3);
    expect(waiting).toHaveLength(2);
    expect(waiting[0].why).toBe(budgetUsed(3, 3));
    expect(waiting[0].why).toBe('budget used today: 3 of 3 unasked turns');
    // A restart keeps the count.
    expect(await dailyBudget(workspace, () => NOON).take('again')).toEqual({ ok: false, left: 0, why: 'budget used today: 3 of 3 unasked turns' });
    // The next day the two that waited are taken.
    at(NOON + DAY);
    expect((await watch.look()).made).toHaveLength(2);
    expect(await watch.rows()).toHaveLength(5);
  });

  it('takes whatever budget it is handed, and a said-no check may hold a proposal back', async () => {
    const refusing: Budget = { take: () => ({ ok: false, why: 'unasked budget used today' }) };
    const { watch, world, writeMetrics, asked } = await rig({ budget: refusing });
    world.metrics = [signups(['2026-09-30', 6], ['2026-10-06', 4])];
    await writeMetrics();
    expect((await watch.look()).waiting).toEqual([expect.objectContaining({ why: 'unasked budget used today' })]);
    expect(asked).toHaveLength(0);
    const vetted: Proposal[] = [];
    const held = await rig({ vet: async (proposal) => { vetted.push(proposal); return null; } });
    held.world.metrics = world.metrics;
    await held.writeMetrics();
    await held.watch.look();
    expect(vetted).toHaveLength(1);
    expect(await held.watch.rows()).toHaveLength(0);
  });
});
