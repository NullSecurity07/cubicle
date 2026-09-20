import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecisions, decidedLines, decisionAttention, parseDecision, writeDecision } from './decisions.ts';

const day = (text: string) => new Date(`${text}T09:00:00`).getTime();

describe('decisions', () => {
  it('a proposal is a readable markdown file with the six sections, and reads back the same', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'decisions-'));
    const decisions = createDecisions(dir, () => day('2026-09-19'));
    const made = await decisions.propose({ title: 'Pricing model: seats or usage?', context: 'Two pilots asked for usage pricing.', options: ['Per seat', 'Per usage', 'Hybrid'], recommendation: 'Per seat: simplest to explain.', proposedBy: 'Maya' });
    expect(made.id).toBe('2026-09-19-pricing-model-seats-or-usage');
    const file = await readFile(join(dir, 'decisions', `${made.id}.md`), 'utf8');
    for (const heading of ['# Pricing model: seats or usage?', '## Context', '## Options', '## Chosen', '## Why', '## Expected effect', '## Review date']) expect(file).toContain(heading);
    expect(file).toContain('2. Per usage');
    expect(parseDecision(made.id, file)).toEqual(made);
    expect(parseDecision(made.id, writeDecision(made))).toEqual(made);
  });

  it('only the founder decides: the choice, the reason and a review date are recorded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'decisions-'));
    let now = day('2026-09-19');
    const decisions = createDecisions(dir, () => now);
    const made = await decisions.propose({ title: 'Launch channel', context: 'One channel first.', options: ['Product Hunt', 'Hacker News'], proposedBy: 'Maya' });
    await expect(decisions.decide(made.id, { chosen: '', why: 'x' })).rejects.toThrow('chosen');
    now = day('2026-09-20');
    const decided = await decisions.decide(made.id, { chosen: 'Hacker News', why: 'Our users are there.', effect: '200 signups in a week.', review: '2026-10-20' });
    expect(decided).toMatchObject({ status: 'decided', chosen: 'Hacker News', why: 'Our users are there.', review: '2026-10-20', decidedAt: now });
    expect((await createDecisions(dir).list())[0]).toEqual(decided);
    await expect(decisions.decide(made.id, { chosen: 'x', why: 'y', review: 'next month' })).rejects.toThrow('date');
  });

  it('the founder can record a decision directly, and two with the same title on one day get their own files', async () => {
    const decisions = createDecisions(await mkdtemp(join(tmpdir(), 'decisions-')), () => day('2026-09-19'));
    const first = await decisions.record({ title: 'No free tier', context: '', options: [], chosen: 'No free tier', why: 'Support cost.' });
    const second = await decisions.record({ title: 'No free tier', context: '', options: [], chosen: 'Trial only', why: 'Changed my mind.' });
    expect(first.status).toBe('decided');
    expect(second.id).toBe('2026-09-19-no-free-tier-2');
    expect((await decisions.list()).map((one) => one.id)).toEqual([second.id, first.id]);
  });

  it('a declined proposal and a removed decision go to the trash, never away', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'decisions-'));
    const decisions = createDecisions(dir, () => day('2026-09-19'));
    const made = await decisions.propose({ title: 'Rename the product', context: 'c', options: ['a', 'b'], proposedBy: 'Dev' });
    await decisions.remove(made.id);
    expect(await decisions.list()).toEqual([]);
    expect((await readdir(join(dir, 'trash'))).some((name) => name.endsWith(`${made.id}.md`))).toBe(true);
  });

  it('a file the founder edited by hand still reads, and a broken one is skipped without losing the rest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'decisions-'));
    const decisions = createDecisions(dir, () => day('2026-09-19'));
    const made = await decisions.record({ title: 'Ship weekly', context: 'c', options: [], chosen: 'Weekly', why: 'Rhythm.' });
    const path = join(dir, 'decisions', `${made.id}.md`);
    await writeFile(path, (await readFile(path, 'utf8')).replace('Rhythm.', 'Rhythm, and customers notice.\n\nSecond paragraph.'));
    await writeFile(join(dir, 'decisions', 'junk.md'), 'not a decision');
    const list = await createDecisions(dir).list();
    expect(list).toHaveLength(1);
    expect(list[0].why).toBe('Rhythm, and customers notice.\n\nSecond paragraph.');
  });

  // Newest first with nothing to date it is how a decision made in the spring gets worked from as if it were today's.
  it('puts the day it was decided on every line a person reads', async () => {
    let now = day('2026-03-02');
    const decisions = createDecisions(await mkdtemp(join(tmpdir(), 'decisions-')), () => now);
    await decisions.record({ title: 'Charge per seat', context: '', options: [], chosen: 'Per seat, $20.', why: 'Simple.' });
    now = day('2026-09-19');
    await decisions.record({ title: 'Launch channel', context: '', options: [], chosen: 'Hacker News.', why: 'Our users are there.' });
    await decisions.propose({ title: 'Pick a CRM', context: 'c', options: ['a', 'b'], proposedBy: 'Maya' });
    expect(decidedLines(await decisions.list())).toEqual([
      '- 19 Sept 2026 — Launch channel: Hacker News.',
      '- 2 Mar 2026 — Charge per seat: Per seat, $20.',
    ]);
    expect(decidedLines(await decisions.list(), 1)).toHaveLength(1);
  });

  it('reports proposals and due reviews to the founder\'s list', async () => {
    let now = day('2026-09-19');
    const decisions = createDecisions(await mkdtemp(join(tmpdir(), 'decisions-')), () => now);
    const proposed = await decisions.propose({ title: 'Pick a CRM', context: 'c', options: ['a', 'b'], proposedBy: 'Maya' });
    const decided = await decisions.record({ title: 'Ship weekly', context: '', options: [], chosen: 'Weekly', why: 'Rhythm.', review: '2026-10-01' });
    const source = decisionAttention(decisions, () => now);
    expect((await source()).map((one) => one.kind)).toEqual(['proposed-decision']);
    expect((await source())[0]).toMatchObject({ who: 'Maya', decisionId: proposed.id, title: 'Pick a CRM' });
    now = day('2026-10-01');
    expect((await source()).map((one) => one.id).sort()).toEqual([`proposed-decision:${proposed.id}`, `review-due:${decided.id}:2026-10-01`]);
  });
});
