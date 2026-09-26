import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Lead } from '../../shared/leads.ts';
import type { Metrics } from '../../shared/metrics.ts';
import type { Stage } from '../../shared/model.ts';
import { betDue, betsAttention, betsBook, metricChoices, missingMetric, readMetric } from './bets.ts';

const card = (id: string, kind: 'metrics' | 'leads' | 'survey') => ({ id, kind, x: 0, y: 0, w: 1, h: 1, ...(kind === 'survey' ? { title: 'PMF', questions: [] } : {}) }) as NonNullable<Stage['cards']>[number];

async function seeded() {
  const workspace = await mkdtemp(join(tmpdir(), 'bets-'));
  const stage: Stage = { rooms: [], docs: [], wires: [], cards: [card('metrics-1', 'metrics'), card('leads-1', 'leads')] };
  const metrics: Metrics = { updatedAt: 0, metrics: [{ key: 'signups', label: 'Signups', unit: '', better: 'up', points: [{ at: '2026-09-20', value: 4, from: 'founder' }, { at: '2026-10-02', value: 13, from: 'founder' }] }] };
  await mkdir(join(workspace, 'metrics'), { recursive: true });
  await writeFile(join(workspace, 'metrics', 'metrics-1.json'), JSON.stringify(metrics));
  const lead = (id: string, stage: Lead['stage']): Lead => ({ id, person: { name: id }, company: { name: 'x' }, stage, notes: [], source: 'founder', addedAt: 1, updatedAt: 1 });
  await mkdir(join(workspace, 'leads'), { recursive: true });
  await writeFile(join(workspace, 'leads', 'leads-1.json'), JSON.stringify([lead('a', 'replied'), lead('b', 'replied'), lead('c', 'new')]));
  return { workspace, stage };
}

describe('the number a bet is measured by', () => {
  it('is read in code from the Metrics card, the Leads card or the Survey card', async () => {
    const { workspace, stage } = await seeded();
    expect(await readMetric(workspace, stage, 'signups')).toEqual({ value: 13, said: 'Signups is 13 (2026-10-02), read from the Metrics card' });
    expect(await readMetric(workspace, stage, 'Signups')).toMatchObject({ value: 13 });
    expect(await readMetric(workspace, stage, 'leads')).toMatchObject({ value: 3 });
    expect(await readMetric(workspace, stage, 'leads:replied')).toEqual({ value: 2, said: '2 leads in Replied, read from the Leads card' });
    expect(await readMetric(workspace, stage, 'leads:nowhere')).toMatchObject({ value: null });
    expect(await readMetric(workspace, stage, 'survey')).toEqual({ value: null, said: 'no Survey card is on the stage' });
    expect(await readMetric(workspace, stage, 'mrr')).toEqual({ value: null, said: 'no number called "mrr" is on a Metrics card' });
    expect(await readMetric(workspace, { ...stage, cards: [...stage.cards!, card('s1', 'survey')] }, 'survey')).toMatchObject({ value: 0 });
    expect(await metricChoices(workspace, stage)).toEqual(['signups', 'leads', 'leads:new', 'leads:fit', 'leads:contacted', 'leads:replied', 'leads:meeting', 'leads:customer', 'leads:passed']);
  });
});

describe('what to add when a bet cannot be measured', () => {
  it('names the card and the row the founder has to add, then what is already there', () => {
    const cards = (...kinds: string[]) => ({ rooms: [], docs: [], wires: [], cards: kinds.map((kind, index) => ({ id: `c${index}`, kind, x: 0, y: 0, w: 1, h: 1 })) }) as unknown as Stage;
    expect(missingMetric(cards(), 'signups', [])).toBe('there is no Metrics card with a "signups" row. Ask the founder to add a Metrics card and paste a CSV with a date,signups header onto it. Tell the founder exactly which card and row to add.');
    expect(missingMetric(cards('metrics'), 'signups', ['mrr'])).toBe('the Metrics card has no "signups" row. Ask the founder to add one: paste a CSV with a date,signups header onto the Metrics card. Or measure it by one of what is already there: mrr. Tell the founder exactly which card and row to add.');
    // The journey's case: "leads" with a Metrics card and no Leads card.
    expect(missingMetric(cards('metrics'), 'leads', ['signups'])).toBe('there is no Leads card to count "leads" on. Ask the founder to add a Leads card from the dock. Or measure it by one of what is already there: signups. Tell the founder exactly which card and row to add.');
    expect(missingMetric(cards(), 'survey', [])).toContain('add a Survey card');
  });
});

describe('the ledger', () => {
  it('holds a proposal until the founder takes it, then closes it once with a result', async () => {
    const { workspace } = await seeded();
    let clock = new Date('2026-09-26T10:00').getTime();
    const book = betsBook(workspace, () => clock);
    const bet = await book.propose({ what: 'Post in r/SaaS', hypothesis: 'founders sign up', metric: 'signups', target: 20, checkDate: '2026-10-03', proposedBy: 'Sam' });
    expect(bet).toMatchObject({ status: 'proposed', made: '2026-09-26' });
    await expect(book.close(bet.id, { verdict: 'worked', value: 1, note: '', by: 'Founder' })).rejects.toThrow('has not been taken yet');
    clock = new Date('2026-09-27T10:00').getTime();
    expect(await book.answer(bet.id, true)).toMatchObject({ status: 'open', made: '2026-09-27' });
    await expect(book.answer(bet.id, true)).rejects.toThrow('not waiting');
    const closed = await book.close(bet.id, { verdict: 'did-not', value: 13, note: '', by: 'Founder' });
    expect(closed.result).toEqual({ at: clock, verdict: 'did-not', value: 13, note: '', by: 'Founder' });
    await expect(book.close(bet.id, { verdict: 'worked', value: 1, note: '', by: 'Founder' })).rejects.toThrow('already closed');
    const declined = await book.propose({ what: 'No', hypothesis: '', metric: 'leads', target: 1, checkDate: '2026-10-01' });
    await book.answer(declined.id, false);
    expect((await book.list()).map((one) => one.id)).toEqual([bet.id]);
  });

  it('asks the founder about proposals, and about open bets once their day comes, with the number as it is now', async () => {
    const { workspace, stage } = await seeded();
    const book = betsBook(workspace, () => new Date('2026-09-26T10:00').getTime());
    const proposed = await book.propose({ what: 'Cold email 30', hypothesis: 'five reply', metric: 'leads:replied', target: 5, checkDate: '2026-10-01', proposedBy: 'Sam', roomId: 'p1' });
    const open = await book.propose({ what: 'Post in r/SaaS', hypothesis: '', metric: 'signups', target: 20, checkDate: '2026-10-03' });
    await book.answer(open.id, true);
    const before = await betsAttention(await book.list(), stage, workspace, '2026-10-02');
    expect(before).toEqual([{ id: `proposed-bet:${proposed.id}`, kind: 'proposed-bet', title: 'Cold email 30', at: proposed.at, who: 'Sam', roomId: 'p1', detail: 'five reply. Measured by leads:replied: 5 by 2026-10-01.' }]);
    const due = (await betsAttention(await book.list(), stage, workspace, '2026-10-03')).find((one) => one.kind === 'bet-check')!;
    expect(due).toMatchObject({ id: `bet-check:${open.id}`, title: 'Check the bet: Post in r/SaaS', detail: 'The target was 20 by 2026-10-03. Now: Signups is 13 (2026-10-02), read from the Metrics card.' });
    expect(betDue({ ...open, status: 'open' }, '2026-10-02')).toBe(false);
  });
});
