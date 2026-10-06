import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Lead } from '../../shared/leads.ts';
import type { Stage, Task } from '../../shared/model.ts';
import type { FounderPromise } from './promises.ts';
import { gatherSince, metricsOnDisk, NOTHING_CHANGED, sinceHeadline, sinceText, sinceYesterday } from './since.ts';

const at = (text: string) => new Date(text).getTime();
const DAY2 = at('2026-10-07T06:30');
const promise = (extra: Partial<FounderPromise>): FounderPromise => ({ id: 'promise-1', what: 'call 5 beta users', due: '2026-10-06', said: '2026-10-06', at: at('2026-10-04T10:00'), status: 'open', ...extra });
const task = (extra: Partial<Task>): Task => ({ id: 't1', title: 'Ship the waitlist page', detail: '', column: 'todo', createdAt: 1, ...extra } as Task);

describe('what changed since yesterday', () => {
  it('names a slip, a late task, a moved number and a near check, most pressing first', () => {
    const lines = sinceYesterday({
      now: DAY2,
      promises: [promise({}), promise({ id: 'promise-2', what: 'reach 10 signups', due: '2026-10-09', check: true }), promise({ id: 'promise-3', what: 'done already', status: 'done' })],
      tasks: [task({ due: '2026-10-05' }), task({ id: 't2', title: 'Finished one', due: '2026-10-01', column: 'done' }), task({ id: 't3', title: 'Not yet', due: '2026-10-07' })],
      metrics: [
        { label: 'Signups', better: 'up', points: [{ at: '2026-10-01', value: 4, from: 'founder' }, { at: '2026-10-06', value: 9, from: 'founder' }] },
        { label: 'Churn', unit: '%', better: 'down', points: [{ at: '2026-09-30', value: 3, from: 'founder' }, { at: '2026-10-07', value: 5, from: 'founder' }] },
        { label: 'Old news', better: 'up', points: [{ at: '2026-09-01', value: 1, from: 'founder' }, { at: '2026-09-02', value: 2, from: 'founder' }] },
      ],
    });
    expect(lines).toEqual([
      'Slipped: you said you would call 5 beta users (due 2026-10-06), now 1 day late.',
      'Late on the board: Ship the waitlist page (due 2026-10-05, 2 days late).',
      'Moved: Signups went from 4 to 9 (better).',
      'Moved: Churn went from 3% to 5% (worse).',
      'Kill-signal check in 2 days: reach 10 signups (on 2026-10-09).',
    ]);
    expect(sinceHeadline(lines)).toBe(lines[0]);
    expect(sinceText(lines).split('\n')[0]).toBe('**Since yesterday**');
  });

  it('is empty on a quiet day, and the note says so in one line', () => {
    const lines = sinceYesterday({ now: DAY2, promises: [promise({ due: '2026-10-08' }), promise({ id: 'c', what: 'x', due: '2026-10-20', check: true })], tasks: [task({ due: '2026-10-07' })], metrics: [] });
    expect(lines).toEqual([]);
    expect(sinceText(lines)).toBe(NOTHING_CHANGED);
    expect(sinceHeadline(lines)).toBeUndefined();
  });

  it('follows the clock it is given: day 1 has no slip, day 2 has', () => {
    const input = { promises: [promise({})], tasks: [], metrics: [] };
    expect(sinceYesterday({ ...input, now: at('2026-10-06T18:00') })).toEqual([]);
    expect(sinceYesterday({ ...input, now: DAY2 })).toHaveLength(1);
  });

  it('a kill-signal check whose day has passed is overdue, never a slip of the founder\'s word', () => {
    expect(sinceYesterday({ now: DAY2, promises: [promise({ check: true })], tasks: [], metrics: [] })).toEqual(['Kill-signal check overdue: call 5 beta users (was due 2026-10-06).']);
  });

  it('reads boards, promises and Metrics cards from the stores, and a store that fails says nothing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'since-'));
    await mkdir(join(workspace, 'metrics'), { recursive: true });
    await writeFile(join(workspace, 'metrics', 'metrics-1.json'), JSON.stringify({ metrics: [{ key: 's', label: 'Signups', better: 'up', points: [{ at: '2026-10-01', value: 2, from: 'f' }, { at: '2026-10-07', value: 3, from: 'f' }] }] }));
    const stage = { rooms: [], docs: [], wires: [], cards: [{ id: 'board-1', kind: 'board' }, { id: 'metrics-1', kind: 'metrics' }, { id: 'board-2', kind: 'board' }] } as unknown as Stage;
    const lines = await gatherSince({
      stage, now: DAY2,
      boards: async (id) => { if (id === 'board-2') throw new Error('gone'); return [task({ due: '2026-10-06' })]; },
      promises: async () => { throw new Error('unreadable'); },
      metrics: (id) => metricsOnDisk(workspace, id),
    });
    expect(lines).toEqual(['Late on the board: Ship the waitlist page (due 2026-10-06, 1 day late).', 'Moved: Signups went from 2 to 3 (better).']);
    expect(await metricsOnDisk(workspace, '../etc')).toEqual([]);
  });

  // Journey 15, day 2: the note said "Nothing changed since yesterday" though a lead was written to and replied, a
  // reading was logged, a kill signal was set and five docs were written on day 1.
  it('counts what happened: a lead\'s thread, a reading logged, a check set or moved, and the docs written', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'since-'));
    await mkdir(join(workspace, 'docs'), { recursive: true });
    const written = at('2026-10-06T19:30') / 1000;
    for (const id of ['runway', 'spec', 'brief']) await writeFile(join(workspace, 'docs', `${id}.md`), `# ${id}`);
    for (const id of ['runway', 'spec']) await utimes(join(workspace, 'docs', `${id}.md`), written, written);
    await utimes(join(workspace, 'docs', 'brief.md'), at('2026-09-30T10:00') / 1000, at('2026-09-30T10:00') / 1000);
    const mira: Lead = { id: 'lead-mira', person: { name: 'Mira Hoffmann' }, company: { name: 'FabLab' }, stage: 'replied', notes: [], source: 'founder', addedAt: 0, updatedAt: 0,
      thread: [{ kind: 'drafted', at: at('2026-10-06T19:20'), subject: 'Try PrintNear' }, { kind: 'replied', at: at('2026-10-06T19:40'), text: 'How does pickup work?' }, { kind: 'drafted', at: at('2026-09-30T10:00') }] };
    const stage = { rooms: [], wires: [], docs: [{ id: 'runway', title: 'Runway' }, { id: 'spec', title: 'MVP Spec' }, { id: 'brief', title: 'Company brief' }], cards: [{ id: 'leads-1', kind: 'leads' }, { id: 'm1', kind: 'metrics' }] } as unknown as Stage;
    const lines = await gatherSince({
      stage, now: DAY2, workspace, boards: async () => [],
      leads: async () => [mira],
      metrics: async () => [{ label: 'Print jobs done', better: 'up', points: [{ at: '2026-10-06', value: 4, from: 'founder' }] }],
      promises: async () => [promise({ id: 'kill', what: 'fewer than 10 print jobs done', due: '2026-10-19', check: true, at: at('2026-10-06T19:25') })],
    });
    expect(lines).toEqual([
      'Lead: Mira Hoffmann replied: "How does pickup work?".',
      'Lead: an email to Mira Hoffmann was drafted ("Try PrintNear").',
      'Logged: Print jobs done 4 on 2026-10-06.',
      'Kill-signal check set: fewer than 10 print jobs done (on 2026-10-19).',
      'Written: "Runway", "MVP Spec".',
    ]);
    expect(sinceText(lines)).not.toBe(NOTHING_CHANGED);
    // What simply happened never heads the row: the day's first move does.
    expect(sinceHeadline(lines)).toBeUndefined();
    // A promise made yesterday and already late is said once, as the slip.
    const slipped = sinceYesterday({ now: DAY2, promises: [promise({ at: at('2026-10-06T09:00'), due: '2026-10-06' })], tasks: [], metrics: [] });
    expect(slipped).toEqual(['Slipped: you said you would call 5 beta users (due 2026-10-06), now 1 day late.']);
  });
});
