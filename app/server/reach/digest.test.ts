import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Attention, Stage, Task } from '../../shared/model.ts';
import type { Boards } from '../boards.ts';
import type { Skills } from '../skills.ts';
import { createDigest, dailyDue, digestText, dueAt } from './digest.ts';

const NOON = new Date(2026, 8, 20, 12, 0, 0).getTime();
const stage: Stage = {
  rooms: [{ id: 'marketing', name: 'Maya', role: 'x', accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1 }],
  docs: [], wires: [], cards: [{ kind: 'board', id: 'board', x: 0, y: 0, w: 1, h: 1 }],
};
const task = (over: Partial<Task>): Task => ({ id: 't1', title: 'the weekly numbers', detail: '', column: 'done', createdAt: 0, assignee: 'marketing', ...over });

const make = (tasks: Task[], waiting: Attention[] = []) => createDigest({
  boards: { list: async () => tasks } as unknown as Boards,
  stage: async () => stage,
  skills: { list: async () => [] } as unknown as Skills,
  attention: async () => waiting,
  workspace: mkdtempSync(join(tmpdir(), 'reach-dig-')),
  now: () => NOON,
});

describe('the morning note', () => {
  it('is one screen: what is done, what waits, what is coming, what was learned', () => {
    const said = digestText(NOON, { done: ['Maya finished the launch note'], waiting: ['Maya needs your OK: send an email'], today: ['14:00 the weekly numbers — Maya'], learned: ['Maya: how to price a plan'] });
    expect(said).toContain('**Today** · Sunday 20 September');
    expect(said).toContain('• Maya finished the launch note');
    expect(said).toContain('**Waiting for you**');
    expect(said).toContain('• 14:00 the weekly numbers — Maya');
    expect(said.length).toBeLessThan(700);
  });

  it('opens on Today\'s five, the same ranked list the dashboard shows, when there is one', async () => {
    const said = await createDigest({
      boards: { list: async () => [] } as unknown as Boards, stage: async () => stage, skills: { list: async () => [] } as unknown as Skills,
      attention: async () => [], workspace: mkdtempSync(join(tmpdir(), 'reach-dig-')), now: () => NOON,
      five: async () => ['Ana at Acme replied 4 days ago. Draft a reply? — A lead is waiting on you · 4 days'],
    })(NOON - 86_400_000);
    expect(said).toMatch(/\*\*Today\*\* · Sunday 20 September\n\n\*\*Five for today\*\*\n• Ana at Acme replied/);
  });

  it('cuts a long list short rather than filling the screen with it', () => {
    const said = digestText(NOON, { done: Array.from({ length: 9 }, (_, at) => `thing ${at}`), waiting: [], today: [], learned: [] });
    expect(said).toContain('• thing 4');
    expect(said).not.toContain('• thing 5');
    expect(said).toContain('…and 4 more');
  });

  it('says something when there is nothing, so a quiet day is not a broken one', () => {
    expect(digestText(NOON, { done: [], waiting: [], today: [], learned: [] })).toContain('Everything is quiet, and I am here.');
  });

  it('is made of what finished since last time, and what is still to come today', async () => {
    const said = await make([
      task({ run: { state: 'done', startedAt: 0, finishedAt: NOON - 3600_000, log: [] } }),
      task({ id: 'old', title: 'last week\'s numbers', run: { state: 'done', startedAt: 0, finishedAt: NOON - 86_400_000 * 3, log: [] } }),
      task({ id: 'later', title: 'the evening post', column: 'todo', nextRun: NOON + 7200_000 }),
      task({ id: 'gone', title: 'yesterday\'s post', column: 'todo', nextRun: NOON - 7200_000 }),
    ], [{ id: 'a1', kind: 'approval', title: 'send an email', at: NOON, who: 'Maya' }])(NOON - 86_400_000);
    // An hour ago is an hour ago, not "just now": a note read after two days away has to sort itself out by time.
    expect(said).toContain('Maya finished the weekly numbers at 11:00');
    expect(said).not.toContain('last week');
    expect(said).toContain('the evening post');
    expect(said).not.toContain('yesterday');
    expect(said).toContain('Maya needs your OK: send an email');
  });
});

describe('when the morning note is due', () => {
  it('is the time of day the founder chose, in their own clock', () => {
    expect(new Date(dueAt('09:00', NOON)).getHours()).toBe(9);
    expect(new Date(dueAt('18:30', NOON)).getMinutes()).toBe(30);
  });

  it('falls back to nine in the morning for anything it cannot read', () => {
    expect(new Date(dueAt('not a time', NOON)).getHours()).toBe(9);
  });
});

describe('what goes out each day', () => {
  const due = dueAt('09:00', NOON);
  const base = { at: NOON, due, digestOn: true, lastDigest: 0, today: '2026-09-20' };

  it('sends the partner\'s morning note in the same message as the digest, at the time the founder chose', () => {
    expect(dailyDue({ ...base, noteDay: '2026-09-20' })).toEqual({ digest: true, note: true });
  });

  it('holds a note written early until that time, so the founder gets one message and not two', () => {
    expect(dailyDue({ ...base, at: due - 60_000, noteDay: '2026-09-20' })).toEqual({ digest: false, note: false });
  });

  it('holds the digest up to ten minutes for a note the partner has not written yet, then sends it alone', () => {
    expect(dailyDue({ ...base, at: due + 5 * 60_000, noteExpected: true })).toEqual({ digest: false, note: false });
    expect(dailyDue({ ...base, at: due + 10 * 60_000, noteExpected: true })).toEqual({ digest: true, note: false });
    // Written within the ten minutes, it goes in the digest's message.
    expect(dailyDue({ ...base, at: due + 5 * 60_000, noteDay: '2026-09-20' })).toEqual({ digest: true, note: true });
    // With no partner there is nothing to wait for.
    expect(dailyDue({ ...base, at: due + 60_000 })).toEqual({ digest: true, note: false });
  });

  it('sends a note the digest did not mark as sent on its own, once', () => {
    expect(dailyDue({ ...base, lastDigest: due + 1, noteDay: '2026-09-20' })).toEqual({ digest: false, note: true });
    expect(dailyDue({ ...base, lastDigest: due + 1, noteDay: '2026-09-20', noteSent: '2026-09-20' })).toEqual({ digest: false, note: false });
  });

  it('sends the note alone when the founder switched the digest off, and never yesterday\'s note', () => {
    expect(dailyDue({ ...base, digestOn: false, noteDay: '2026-09-20' })).toEqual({ digest: false, note: true });
    expect(dailyDue({ ...base, noteDay: '2026-09-19' })).toEqual({ digest: true, note: false });
  });
});
