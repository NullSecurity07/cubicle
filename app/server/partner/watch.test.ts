import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Lead } from '../../shared/leads.ts';
import type { Metric } from '../../shared/metrics.ts';
import type { Attention, Stage } from '../../shared/model.ts';
import type { FounderPromise } from './promises.ts';
import { unaskedRow } from '../openends/health.ts';
import type { ModelClient } from '../providers.ts';
import { createUnasked } from '../usage.ts';
import { saidNoFor } from './saidno.ts';
import { budgetUsed, createWatch, emailBody, fakeWatchReply, guardProposal, leadTwins, killLineOf, killToward, leadSparks, metricSparks, proposalOf, towardLine, trending, watchAsk, type Acts, type Budget, type Proposal, type WatchDeps, watchBudget } from './watch.ts';

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

  // Journey 15: kill signal "fewer than 10 print jobs done", readings 7 then 9, and Needs you said the number was
  // trending to the kill line. Progress toward the goal is never danger; only a move to the losing side is.
  it('fixture table: only a move toward the losing side of the kill line is raised, in both directions', () => {
    const jobs = (...values: [string, number][]): Metric => ({ key: 'print-jobs-done', label: 'Print jobs done', better: 'up', points: values.map(([at, value]) => ({ at, value, from: 'founder' })) });
    const churn = (...values: [string, number][]): Metric => ({ key: 'churn', label: 'Churn', better: 'down', unit: '%', points: values.map(([at, value]) => ({ at, value, from: 'founder' })) });
    const kill = killCheck('fewer than 10 print jobs done');
    const killed = { ...kill, said: '2026-10-07' };
    const above = killCheck('churn above 8%');
    const table: [string, Metric, FounderPromise, string | null][] = [
      ['7 to 9 under "fewer than 10": progress', jobs(['2026-10-07', 7], ['2026-10-08', 9]), killed, null],
      ['9 to 8 under "fewer than 10": the wrong way', jobs(['2026-10-07', 9], ['2026-10-08', 8]), killed, 'Print jobs done is moving away from the kill line it has to clear'],
      ['9 to 9: nothing moved', jobs(['2026-10-07', 9], ['2026-10-08', 9]), killed, null],
      ['14 to 11 over "fewer than 10": past half-way down', jobs(['2026-10-07', 14], ['2026-10-08', 11]), killed, 'Print jobs done is trending to the kill line'],
      ['14 to 9 over "fewer than 10": crossed', jobs(['2026-10-07', 14], ['2026-10-08', 9]), killed, 'Print jobs done crossed the kill line'],
      ['14 to 16: away from the line', jobs(['2026-10-07', 14], ['2026-10-08', 16]), killed, null],
      ['churn 4% to 7% under "above 8%": trending up to it', churn(['2026-09-30', 4], ['2026-10-05', 7]), above, 'Churn is trending to the kill line'],
      ['churn 7% to 4% under "above 8%": better', churn(['2026-09-30', 7], ['2026-10-05', 4]), above, null],
      ['churn 9% to 10% already over "above 8%": worse', churn(['2026-09-30', 9], ['2026-10-05', 10]), above, 'Churn is moving away from the kill line it has to clear'],
    ];
    for (const [name, metric, check, why] of table) {
      const found = metricSparks([{ cardId: 'm1', metrics: [metric] }], check, [], NOON);
      expect(found.map((one) => one.why), name).toEqual(why ? [why] : []);
    }
    expect(killToward(7, 9, 10, true)).toBeNull();
    expect(killToward(9, 8, 10, true)).toMatchObject({ away: true, crossed: false });
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

// The day's shared budget for unasked work, as usage.ts keeps it, over one model that may take unasked turns.
const sharedBudget = (workspace: string, now: () => number, cap?: number) => createUnasked({
  path: join(workspace, 'unasked.json'), usage: { left: () => 1, spent: () => false, blocked: () => false }, clients: () => [{ name: 'cheap' } as ModelClient], now, ...(cap === undefined ? {} : { cap }),
});

async function rig(over: { budget?: Budget; reply?: (asked: string) => string; vet?: WatchDeps['vet']; cap?: number } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'watch-'));
  let clock = NOON;
  const unasked = sharedBudget(workspace, () => clock, over.cap);
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
    workspace, now: () => clock, busy: new Set(), budget: over.budget ?? watchBudget(unasked),
    stage: async () => stage, attention: async () => world.rows, promises: async () => world.promises, bets: async () => [], leads: async () => world.leads,
    promptFor: async () => [{ role: 'system', content: 'You are Sam, the partner.' }],
    ask: async (messages) => { const text = messages.at(-1)!.content; asked.push(text); return { text: over.reply ? over.reply(text) : fakeWatchReply(messages), provider: 'cheap' }; },
    acts, changed: async () => {}, ...(over.vet ? { vet: over.vet } : {}),
  });
  return { watch, world, writeMetrics, asked, ran, workspace, unasked, now: () => clock, at: (time: number) => { clock = time; } };
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
    const { watch, world, writeMetrics, asked, workspace, unasked, at } = await rig();
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
    // The turns are the shared budget's, each under the watch's reason, as Health's "Unasked work today" row says them.
    expect(unasked.left()).toBe(9);
    expect(unaskedRow({ cap: unasked.cap, used: unasked.used() }).detail).toBe('3 of 12 used: watch: kill:signups, watch: promise:promise-a, watch: page:w1');
    // A restart keeps the count: the shared book is on disk.
    await unasked.settled();
    const again = sharedBudget(workspace, () => NOON);
    await again.load();
    expect(watchBudget(again).take('page:w2')).toEqual({ ok: false, left: 0, why: 'budget used today: 3 of 3 unasked turns' });
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

  it('never goes past the day\'s shared budget, and a turn that said nothing goes back to it', async () => {
    const { watch, world, writeMetrics, asked, unasked } = await rig({ cap: 1, reply: () => '' });
    world.metrics = [signups(['2026-09-30', 6], ['2026-10-06', 4])];
    world.promises = [killCheck(), { id: 'promise-a', what: 'send the deck', due: '2026-10-01', said: '2026-09-28', at: 0, status: 'open' }];
    await writeMetrics();
    // An empty answer is released at once, so the one shared turn is there for the next trigger too.
    const { made, waiting } = await watch.look();
    expect(asked).toHaveLength(2);
    expect(made).toHaveLength(2);
    expect(waiting).toHaveLength(0);
    expect(unasked.used()).toEqual([]);
    // With the shared day used up by other work, the watch waits with the shared budget's words.
    const busy = await rig({ cap: 1 });
    expect(busy.unasked.take('morning digest').ok).toBe(true);
    busy.world.metrics = world.metrics;
    await busy.writeMetrics();
    expect((await busy.watch.look()).waiting).toEqual([expect.objectContaining({ why: 'budget used today: 1 of 1 unasked turns' })]);
    expect(busy.asked).toHaveLength(0);
  });

  it('puts a move the founder said no to once more with their words quoted, then not at all', async () => {
    const { watch, world, writeMetrics, workspace, now, at } = await rig();
    // The founder turned the same task down in chat two days ago.
    at(NOON - 2 * DAY);
    await saidNoFor(workspace, now).record({ tool: 'propose_task', subject: 'Call five lapsed signups this week and ask what stopped them', reason: 'we called them in September' });
    at(NOON);
    world.metrics = [signups(['2026-09-30', 6], ['2026-10-06', 4])];
    await writeMetrics();
    const { made } = await watch.look();
    expect(made).toHaveLength(1);
    expect(made[0].saidNo).toMatch(/^You said no to this on 4 Oct: 'we called them in September'\. Ask again\?$/);
    const [row] = await watch.rows();
    expect(row.detail?.split('\n')[0]).toBe(made[0].saidNo);
    // Don't again: the no is kept, and the next time the number moves the same move is not raised.
    await watch.answer(made[0].id, false);
    world.metrics = [signups(['2026-09-30', 6], ['2026-10-06', 4], ['2026-10-07', 3])];
    world.promises = [{ ...killCheck(), id: 'promise-kill-2' }];
    await writeMetrics();
    at(NOON + DAY);
    const logged: string[] = [];
    const log = console.log;
    console.log = (line: string) => { logged.push(line); };
    try { expect((await watch.look()).made).toHaveLength(0); } finally { console.log = log; }
    expect(logged.some((line) => line.startsWith('partner watch: not raised. Already declined'))).toBe(true);
    expect(await watch.rows()).toHaveLength(0);
  });
});

// Journey 15: Mira asked how pickup works and whether one trial job was possible; the unasked draft proposed a call
// and ended "My call: Send the reply to Mira today ...".
// Journey 16: 11 paying went to 9.5 and the watch proposed "Call the three nurses who cancelled this week".
it('takes a count nothing on record gives out of the move, and the row says so', () => {
  const metric: Metric = { key: 'paying', label: 'Paying subscribers', better: 'up', points: [{ at: '2026-10-01', value: 11, from: 'founder' }, { at: '2026-10-06', value: 9.5, from: 'founder' }] };
  const [spark] = metricSparks([{ cardId: 'm1', metrics: [metric] }], killCheck('Paying subscribers drop below 8'), [], NOON);
  const held = guardProposal(spark, proposalOf(spark, 'Move: Call the three nurses who cancelled this week.\nTask: Call the three nurses who cancelled', '2026-10-06'), ['- Paying subscribers: 11']);
  expect(held.move).toBe('Find out this week what is moving the number, before the check day.');
  expect(held.draft).toMatchObject({ kind: 'task', title: 'Find out this week what is moving the number, before the check day' });
  expect(held.left).toEqual(['3 nurses who']);
});

// Journey 16: two Needs you rows per lead reply, the plain ask and Sam's ready answer.
it('settles the plain reply ask while the partner\'s answer to that lead waits, and only that lead\'s', () => {
  const rows = [
    { id: 'partner-proposal:lead-x-0', kind: 'partner-proposal', title: 'Sam proposes: answer Anna', at: 2, cardId: 'leads1', leadId: 'lead-anna' },
    { id: 'lead-replied:leads1:lead-anna:5', kind: 'lead-replied', title: 'Anna replied. Draft an answer?', at: 1, cardId: 'leads1' },
    { id: 'lead-replied:leads1:lead-ben:6', kind: 'lead-replied', title: 'Ben replied. Draft an answer?', at: 1, cardId: 'leads1' },
  ] as Attention[];
  expect([...leadTwins(rows)]).toEqual(['lead-replied:leads1:lead-anna:5']);
  expect([...leadTwins(rows.slice(1))]).toEqual([]);
});

it('signs the ready reply with the founder\'s name from the brief, and never with a placeholder', () => {
  const anna: Lead & { cardId: string } = { id: 'lead-anna', cardId: 'leads1', person: { name: 'Anna Kowalski', email: 'anna@marien.example' }, company: { name: 'St. Marien' }, stage: 'replied', notes: [], source: 'founder', addedAt: 0, updatedAt: 3, thread: [{ kind: 'replied', at: 2, text: 'Thanks, how does it work?' }] };
  const [spark] = leadSparks([anna], { 'lead-anna': 'contacted' }, NOON);
  const reply = 'Move: Answer Anna.\nSubject: How it works\nBody: Hi Anna,\n\nYou order by Friday.\n\nBest,\n[Founder Name]\n[Company]';
  expect(guardProposal(spark, proposalOf(spark, reply, '2026-10-07'), ['# Company\n- Founder: Mara Lind']).draft).toMatchObject({ body: 'Hi Anna,\n\nYou order by Friday.\n\nBest,\nMara Lind' });
  expect(guardProposal(spark, proposalOf(spark, reply, '2026-10-07'), ['# Company']).draft).toMatchObject({ body: 'Hi Anna,\n\nYou order by Friday.\n\nBest,' });
});

describe('the reply to a lead who wrote back', () => {
  const MIRA = 'Hi, thanks for reaching out. A few of our members need small brackets printed next week. How does pickup work and could we try one job first? Mira';
  const mira: Lead & { cardId: string } = {
    id: 'lead-mira', cardId: 'leads1', person: { name: 'Mira Hoffmann', email: 'mira@fablab.example' }, company: { name: 'FabLab Kreuzberg' }, stage: 'replied', notes: [], source: 'founder', addedAt: 0, updatedAt: 3,
    thread: [{ kind: 'drafted', at: 1, subject: 'Try PrintNear' }, { kind: 'replied', at: 2, text: MIRA }],
  };
  it('quotes their words to the partner and asks for answers to them, never a call they did not ask for or the verdict\'s lines', () => {
    const [spark] = leadSparks([mira], { 'lead-mira': 'contacted' }, NOON);
    const asked = watchAsk(spark, '2026-10-07');
    expect(asked).toContain(`What Mira Hoffmann wrote, word for word:\n"${MIRA}"`);
    expect(asked).toContain('each question they asked in turn');
    expect(asked).toContain('proposes a call only if they asked for one');
    expect(asked).toContain('no "My call", "Why", "Kill signal" or "This week" lines');
    expect(asked).not.toContain('proposing a 20-minute call');
  });

  // Journey 16: the ready reply promised Thursday delivery and nut-free meals; nobody had said either.
  it('takes out of the ready reply what nothing on record says, and the row says what was left out', async () => {
    const anna: Lead & { cardId: string } = { ...mira, id: 'lead-anna', person: { name: 'Anna Kowalski', email: 'anna@marien.example' }, company: { name: 'St. Marien Hospital' }, thread: [{ kind: 'replied', at: 2, text: 'Three of us on the night ward would try it. Can you deliver on Thursday instead of Sunday? And are the meals nut-free? Anna' }] };
    const [spark] = leadSparks([anna], { 'lead-anna': 'contacted' }, NOON);
    const reply = 'Move: Answer Anna today.\nSubject: Thursday and nut-free\nBody: Hi Anna,\n\nYes, we can definitely deliver on Thursday instead of Sunday, and all our meals are completely nut-free, so you can eat safely.\n\nBest,';
    const held = guardProposal(spark, proposalOf(spark, reply, '2026-10-07'), ['Meals are delivered on Sunday.']);
    expect(held.draft).toMatchObject({ kind: 'email', body: 'Hi Anna,\n\nBest,' });
    expect([...held.left!].sort()).toEqual(['allergen safety', 'delivery on Thursday', 'nut-free']);

    // On the row: the fake partner says yes to both questions, and Needs you shows neither, with the left-out line.
    const { watch, world } = await rig();
    world.promises = [];
    world.leads = [{ ...anna, stage: 'contacted' }];
    await watch.look();
    world.leads = [anna];
    await watch.look();
    const [row] = await watch.rows();
    expect(row.detail).toContain('(left out: nothing on record about delivery on Thursday, nut-free)');
    expect(row.detail).not.toMatch(/deliver on Thursday|are nut-free/);
  });

  it('keeps the partner\'s own lines out of the email', () => {
    const [spark] = leadSparks([mira], { 'lead-mira': 'contacted' }, NOON);
    const reply = 'Move: Answer Mira today.\nSubject: Pickup and a first job\nBody: Hi Mira,\n\nPickup is from the host nearest you; one trial job is fine.\n\nBest,\nFounder\n\nMy call: Send the reply to Mira today to turn her weekend queue into our next host.';
    const { draft } = proposalOf(spark, reply, '2026-10-07');
    expect(draft).toEqual({ kind: 'email', to: 'mira@fablab.example', subject: 'Pickup and a first job', body: 'Hi Mira,\n\nPickup is from the host nearest you; one trial job is fine.\n\nBest,\nFounder' });
    expect(emailBody('Hi\n**Kill signal:** x\nBye')).toBe('Hi\nBye');
  });
});
