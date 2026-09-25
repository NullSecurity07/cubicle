import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Lead } from '../../shared/leads.ts';
import type { Metrics } from '../../shared/metrics.ts';
import type { Decision, Stage, Task } from '../../shared/model.ts';
import { createBoards } from '../boards.ts';
import { writeBook, emptyBook } from '../leads/moves.ts';
import type { Deps } from '../install.ts';
import { createStore } from '../store.ts';
import { checkFields } from '../skills.ts';
import month, { addMonthlyUpdate, gatherMonth, lastMonthStart, metricLine, MONTH_TOOLS, updateTitle } from './month.ts';

const NOW = new Date('2026-10-01T09:00').getTime();
const at = (day: string) => new Date(`${day}T12:00`).getTime();

// A workspace with one of everything the update reads, wired to Maya, and a Runway card left unwired.
async function seeded() {
  const workspace = await mkdtemp(join(tmpdir(), 'month-'));
  const stage: Stage = {
    rooms: [{ id: 'marketing', name: 'Maya', role: 'x', accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1 }, { id: 'build', name: 'Dev', role: 'x', accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1 }],
    docs: [],
    cards: [
      { id: 'board-1', kind: 'board', x: 0, y: 0, w: 1, h: 1 }, { id: 'leads-1', kind: 'leads', x: 0, y: 0, w: 1, h: 1 },
      { id: 'metrics-1', kind: 'metrics', title: 'Traction', x: 0, y: 0, w: 1, h: 1 }, { id: 'runway-1', kind: 'runway', x: 0, y: 0, w: 1, h: 1 },
    ],
    wires: ['board-1', 'leads-1', 'metrics-1'].map((id) => ({ id: `w-${id}`, from: 'marketing', fromHandle: 'r', to: id, toHandle: 'l' })),
  };
  const metrics: Metrics = { updatedAt: 0, metrics: [
    { key: 'mrr', label: 'MRR', unit: '$', better: 'up', northStar: true, points: [{ at: '2026-08-31', value: 2880, from: 'founder' }, { at: '2026-09-15', value: 3000, from: 'founder' }, { at: '2026-09-29', value: 3120, from: 'stripe' }] },
    { key: 'churn', label: 'Churn', unit: '%', better: 'down', points: [{ at: '2026-07-01', value: 4, from: 'founder' }] },
  ] };
  await mkdir(join(workspace, 'metrics'), { recursive: true });
  await writeFile(join(workspace, 'metrics', 'metrics-1.json'), JSON.stringify(metrics));
  const leads: Lead[] = [
    { id: 'lead-a', person: { name: 'Ana' }, company: { name: 'Acme' }, stage: 'replied', notes: [], source: 'founder', addedAt: at('2026-09-03'), updatedAt: at('2026-09-18') },
    { id: 'lead-b', person: { name: 'Bo' }, company: { name: 'Beta' }, stage: 'fit', notes: [], source: 'founder', addedAt: at('2026-08-03'), updatedAt: at('2026-08-03') },
  ];
  await mkdir(join(workspace, 'leads'), { recursive: true });
  await writeFile(join(workspace, 'leads', 'leads-1.json'), JSON.stringify(leads));
  await writeBook(workspace, { ...emptyBook(), moves: [
    { at: at('2026-08-20'), cardId: 'leads-1', leadId: 'lead-b', name: 'Bo at Beta', from: 'new', to: 'fit' },
    { at: at('2026-09-18'), cardId: 'leads-1', leadId: 'lead-a', name: 'Ana at Acme', from: 'contacted', to: 'replied' },
  ] });
  const tasks: Task[] = [
    { id: 't1', title: 'Ship onboarding', detail: '', column: 'done', createdAt: at('2026-08-01'), assignee: 'build', run: { state: 'done', startedAt: at('2026-09-20'), finishedAt: at('2026-09-20'), log: [] } },
    { id: 't2', title: 'Old thing', detail: '', column: 'done', createdAt: at('2026-07-01') },
    { id: 't3', title: 'Pricing page', detail: '', column: 'done', createdAt: at('2026-09-10') },
  ];
  const decisions = [
    { id: 'd1', title: 'Price at $29', status: 'decided', at: at('2026-09-01'), decidedAt: at('2026-09-12'), context: '', options: [], chosen: 'One plan, monthly' },
    { id: 'd2', title: 'Hire later', status: 'decided', at: at('2026-08-01'), decidedAt: at('2026-08-10'), context: '', options: [] },
    { id: 'd3', title: 'Open question', status: 'proposed', at: at('2026-09-20'), context: '', options: [] },
  ] as Decision[];
  const sources = (roomId = 'marketing') => ({
    workspace, stage, roomId, now: NOW, decisions: async () => decisions, boards: async () => tasks,
    leads: async () => leads,
  });
  return { workspace, stage, sources };
}

describe('gather_month', () => {
  it('returns dated lines for the month, each naming its card, from the stores themselves', async () => {
    const { sources } = await seeded();
    const said = await gatherMonth(sources(), '2026-09-01');
    expect(said.split('\n')).toEqual([
      'What changed from 2026-09-01 to 2026-10-01. Each line names the card it came from in brackets. Use only these numbers; anything not here is not tracked.',
      'Decisions decided [Decisions]:',
      '- 2026-09-12 Price at $29: One plan, monthly',
      'Tasks done [Board]:',
      '- 2026-09-10 Pricing page',
      '- 2026-09-20 Ship onboarding, by Dev',
      'Leads [Leads]: 1 added, 1 stage move. Now: 1 Fit, 1 Replied.',
      '- 2026-09-18 Ana at Acme: Contacted to Replied',
      'Numbers [Metrics "Traction"]:',
      '- MRR (north star): $3,120 on 2026-09-29, from $2,880 on 2026-08-31: +$240 (+8%)',
      '- Churn: no reading since 2026-09-01; the last was 4% on 2026-07-01',
      'Not wired to you: Runway. Say so in the update rather than guessing.',
    ]);
  });

  it('reads nothing from a card not wired to the person asking', async () => {
    const { sources } = await seeded();
    const said = await gatherMonth(sources('build'), '2026-09-01');
    expect(said).not.toMatch(/MRR|Ana at Acme|Ship onboarding/);
    expect(said).toContain('Not wired to you: Metrics, Runway, Leads, Board.');
  });

  it('reads the runway once it is wired: cash, burn and months left', async () => {
    const { sources, workspace } = await seeded();
    await mkdir(join(workspace, 'runway'), { recursive: true });
    await writeFile(join(workspace, 'runway', 'runway-1.json'), JSON.stringify({ cash: { amount: 120000, asOf: '2026-10-01' }, flows: [{ id: 'f1', label: 'Team', monthly: -20000, from: '2026-10', category: 'people' }], scenarios: [] }));
    const one = sources();
    one.stage.wires.push({ id: 'w-runway', from: 'marketing', fromHandle: 'r', to: 'runway-1', toHandle: 'l' });
    const said = await gatherMonth(one, '2026-09-01');
    expect(said).toMatch(/^Runway \[Runway\]: cash \$120,000 on 2026-10-01; burn \$20,000 a month; \d\.\d months left, cash out 2027-0\d\.$/m);
    expect(said).not.toContain('Not wired');
  });

  it('says a number with no earlier reading as it is, and moves nothing it cannot compute', () => {
    expect(metricLine({ key: 'x', label: 'Signups', better: 'up', points: [{ at: '2026-09-02', value: 5, from: 'f' }, { at: '2026-09-20', value: 9, from: 'f' }] }, '2026-09-01'))
      .toBe('Signups: 9 on 2026-09-20, first reading 5 on 2026-09-02');
    expect(metricLine({ key: 'x', label: 'Signups', better: 'up', points: [] }, '2026-09-01')).toBeNull();
  });

  it('is offered only with a card it reads wired, and refuses a day it cannot read', async () => {
    const { workspace, stage } = await seeded();
    const store = createStore(workspace);
    await store.saveStage(stage);
    const part = await month.install({ workspace, root: workspace, fake: true, store, boards: createBoards(workspace), decisions: { list: async () => [] } } as unknown as Deps);
    const names = (roomId: string) => part.offer!(part.tools!, stage, roomId).map((tool) => tool.name);
    expect(names('marketing')).toEqual(MONTH_TOOLS);
    expect(names('build')).toEqual([]);
    const tool = part.tools![0];
    await expect(tool.run({ since: 'last month' }, { stage, roomId: 'marketing', store, granted: new Map() })).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe('the monthly update task', () => {
  it('names the month a run reports, which is the one before it', () => {
    expect(updateTitle(NOW)).toBe('Draft the September update');
    expect(updateTitle(new Date('2027-01-04T09:00').getTime())).toBe('Draft the December update');
    expect(lastMonthStart(NOW)).toBe('2026-09-01');
  });

  it('lands once on the first board, repeating on the first weekday of every month with the skill, given to the wired person', async () => {
    const { workspace, stage } = await seeded();
    const store = createStore(workspace);
    await store.saveStage(stage);
    const boards = createBoards(workspace);
    const made = await addMonthlyUpdate({ boards, store });
    expect(made.added).toBe(true);
    expect(made.task).toMatchObject({ repeat: { every: 'month', time: '09:00' }, skill: 'monthly-update', assignee: 'marketing', column: 'todo' });
    expect(made.task.title).toBe(updateTitle(made.task.nextRun!));
    expect((await addMonthlyUpdate({ boards, store })).added).toBe(false);
    expect(await boards.list('board-1')).toHaveLength(1);
  });

  it('refuses without a board, through its route', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'month-empty-'));
    const store = createStore(workspace);
    const answered: { status: number; body: any }[] = [];
    const part = await month.install({ workspace, store, boards: createBoards(workspace), body: async () => ({}), json: (_r: ServerResponse, status: number, body: unknown) => answered.push({ status, body }) } as unknown as Deps);
    await part.route!({ method: 'POST' } as IncomingMessage, {} as ServerResponse, '/api/month/template');
    expect(answered[0]).toEqual({ status: 400, body: { error: 'Add a task board first, then ask for the monthly update again.' } });
  });

  it('ships the monthly-update skill, which forbids made-up numbers', async () => {
    const shipped = resolve(import.meta.dirname, '../../skills');
    expect(await readdir(shipped)).toContain('monthly-update.json');
    const skill = checkFields(JSON.parse(await readFile(join(shipped, 'monthly-update.json'), 'utf8')));
    expect(skill.procedure.join(' ')).toContain('gather_month');
    expect(skill.pitfalls.join(' ')).toMatch(/Never invent traction/);
  });
});
