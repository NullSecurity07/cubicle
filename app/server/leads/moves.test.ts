import { describe, expect, it } from 'vitest';
import type { Lead, LeadStage } from '../../shared/leads.ts';
import { DAY, nudgeAsk, nudgeId, nudgeTitle, readNudgeId, staleDays } from '../../shared/leads-nudge.ts';
import { dismiss, emptyBook, enteredAt, observe } from './moves.ts';

const NOW = Date.UTC(2026, 8, 25, 12);
const lead = (id: string, stage: LeadStage, updatedAt: number, notes: number[] = []): Lead => ({
  id, person: { name: 'Ana' }, company: { name: 'Acme' }, stage, notes: notes.map((at) => ({ at, by: 'Founder', text: 'x' })),
  source: 'founder', addedAt: updatedAt - DAY, updatedAt,
});

describe('when a lead is owed a follow-up', () => {
  it('counts Contacted after five quiet days and Replied or Meeting after three, never New, Fit, Customer or Passed', () => {
    expect(staleDays(lead('a', 'contacted', 0), NOW - 4 * DAY, NOW)).toBeNull();
    expect(staleDays(lead('a', 'contacted', 0), NOW - 5 * DAY, NOW)).toBe(5);
    expect(staleDays(lead('a', 'replied', 0), NOW - 3 * DAY, NOW)).toBe(3);
    expect(staleDays(lead('a', 'meeting', 0), NOW - 2 * DAY - 1, NOW)).toBeNull();
    for (const stage of ['new', 'fit', 'customer', 'passed'] as const) expect(staleDays(lead('a', stage, 0), NOW - 90 * DAY, NOW)).toBeNull();
  });

  it('starts counting again from the newest note', () => {
    expect(staleDays(lead('a', 'replied', 0, [NOW - DAY]), NOW - 10 * DAY, NOW)).toBeNull();
  });

  it('says what happened and asks the person with the evidence-outreach skill', () => {
    const one = lead('a', 'replied', 0);
    expect(nudgeTitle(one, NOW - 4 * DAY, NOW)).toBe('Ana at Acme replied 4 days ago. Draft a reply?');
    expect(nudgeAsk(one, NOW - 4 * DAY, NOW)).toMatch(/evidence-outreach skill/);
    expect(readNudgeId(nudgeId('leads-1', 'lead-ab', 'replied'))).toEqual({ cardId: 'leads-1', leadId: 'lead-ab', stage: 'replied' });
    expect(readNudgeId('metric-alert:x:y:z')).toBeNull();
  });
});

describe('the book of lead moves and nudges', () => {
  it('writes down a stage move with its moment, and dates the new stage from it', () => {
    const book = emptyBook();
    observe(book, 'c', [lead('a', 'fit', NOW - 10 * DAY)], NOW - 9 * DAY);
    observe(book, 'c', [lead('a', 'contacted', NOW - 6 * DAY)], NOW - 5 * DAY);
    expect(book.moves).toEqual([{ at: NOW - 6 * DAY, cardId: 'c', leadId: 'a', name: 'Ana at Acme', from: 'fit', to: 'contacted' }]);
    expect(enteredAt(book, 'c', lead('a', 'contacted', NOW))).toBe(NOW - 6 * DAY);
  });

  it('raises one nudge per lead per stage, closes it when the lead is written about, and does not raise it again', () => {
    const book = emptyBook();
    const id = nudgeId('c', 'a', 'replied');
    expect(observe(book, 'c', [lead('a', 'replied', NOW - 4 * DAY)], NOW)).toBe(true);
    expect(Object.keys(book.raised)).toEqual([id]);
    // A note: no longer quiet, so it is over.
    observe(book, 'c', [lead('a', 'replied', NOW - 4 * DAY, [NOW])], NOW);
    expect(book.raised).toEqual({});
    expect(book.done).toEqual([id]);
    // Quiet again in the same stage: no second nudge.
    observe(book, 'c', [lead('a', 'replied', NOW - 4 * DAY, [NOW])], NOW + 5 * DAY);
    expect(book.raised).toEqual({});
    // A new stage may be nudged once.
    observe(book, 'c', [lead('a', 'meeting', NOW + 5 * DAY, [NOW])], NOW + 9 * DAY);
    expect(Object.keys(book.raised)).toEqual([nudgeId('c', 'a', 'meeting')]);
  });

  it('keeps a dismissed nudge dismissed', () => {
    const book = emptyBook();
    observe(book, 'c', [lead('a', 'contacted', NOW - 6 * DAY)], NOW);
    const id = nudgeId('c', 'a', 'contacted');
    expect(dismiss(book, id)).toBe(true);
    expect(dismiss(book, id)).toBe(false);
    observe(book, 'c', [lead('a', 'contacted', NOW - 6 * DAY)], NOW + DAY);
    expect(book.raised).toEqual({});
  });

  it('forgets a lead taken off the card but keeps the moves it made', () => {
    const book = emptyBook();
    observe(book, 'c', [lead('a', 'fit', NOW - 2 * DAY)], NOW - DAY);
    observe(book, 'c', [lead('a', 'contacted', NOW)], NOW);
    observe(book, 'c', [], NOW);
    expect(book.seen).toEqual({});
    expect(book.moves).toHaveLength(1);
  });
});
