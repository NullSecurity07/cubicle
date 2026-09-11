import { describe, it, expect } from 'vitest';
import { boardOpened, boardClosed, boardHeadline, BOARD_HEADLINE_MS, BOARD_SESSION_MAX_MS } from './board.js';

const T0 = '2026-09-11T10:00:00.000Z';
const now = Date.parse(T0);

describe('the board room and the whiteboard (spec §6)', () => {
  it('only a board-room meeting touches the board state', () => {
    expect(boardOpened({ id: 'm1', room: 'meeting', agenda: 'standup' }, T0)).toBeNull();
    expect(boardOpened({ id: 'm1', room: 'board', subject: 'idea', title: 'Meal kits' }, T0))
      .toEqual({ id: 'm1', subject: 'idea', title: 'Meal kits', verdict: null, findings: [], at: T0 });
    expect(boardOpened({ id: 'm1', room: 'board', agenda: "Pre-mortem: this cycle's plan" }, T0)!.subject).toBe('plan');
  });

  it('closes only the session it opened, and keeps at most three findings', () => {
    const open = boardOpened({ id: 'm1', room: 'board', subject: 'plan' }, T0)!;
    expect(boardClosed(open, { id: 'other', verdict: 'return' }, T0)).toBe(open);
    expect(boardClosed(null, { id: 'm1', verdict: 'pass' }, T0)).toBeNull();
    const closed = boardClosed(open, { id: 'm1', verdict: 'return', findings: ['a', 'b', 'c', 'd'] }, T0)!;
    expect(closed.verdict).toBe('return');
    expect(closed.findings).toEqual(['a', 'b', 'c']);
    expect(boardClosed(open, { id: 'm1' }, T0)!.verdict).toBe('pass');   // a missing verdict fails open, as the board always does
  });

  it('says the board is sitting, then shows the verdict, then gives the wall back to the plan', () => {
    const open = boardOpened({ id: 'm1', room: 'board', subject: 'idea', title: 'Meal kits for nurseries' }, T0)!;
    expect(boardHeadline(open, now)!.head).toBe('The board is sitting');
    expect(boardHeadline(open, now)!.lines).toEqual(['Meal kits for nurseries']);
    const closed = boardClosed(open, { id: 'm1', verdict: 'pass', findings: ['nobody has priced delivery'] }, T0)!;
    const h = boardHeadline(closed, now)!;
    expect(h.head).toBe('The board passed: Meal kits for nurseries');
    expect(h.head.length).toBeLessThanOrEqual(44);
    expect(h.lines).toEqual(['• nobody has priced delivery']);
    expect(boardHeadline(closed, now + BOARD_HEADLINE_MS + 1)).toBeNull();
    expect(boardHeadline(null, now)).toBeNull();
  });

  // I4: `runBoardSession` emits `meeting.opened`, awaits up to four model calls, then emits `meeting.closed`.
  // A kill in that window left the whiteboard — the owner's main surface — claiming a meeting was in progress
  // for ever, hiding the plan headline, which is the same failure §6.2 rules out for the snapshot.
  it('gives the wall back when a session opens and never closes', () => {
    const open = boardOpened({ id: 'm1', room: 'board', subject: 'idea', title: 'Meal kits' }, T0)!;
    expect(boardHeadline(open, now + BOARD_SESSION_MAX_MS - 1)!.head).toBe('The board is sitting');
    expect(boardHeadline(open, now + BOARD_SESSION_MAX_MS + 1)).toBeNull();
    // Four model calls fit inside the budget with room to spare.
    expect(BOARD_SESSION_MAX_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it('lets the next board meeting clear a session whose close was lost', () => {
    const open = boardOpened({ id: 'm1', room: 'board', subject: 'idea', title: 'Meal kits' }, T0)!;
    // A close for another session in the board room: the one on the wall demonstrably never closed.
    expect(boardClosed(open, { id: 'm2', room: 'board', verdict: 'pass' }, T0)).toBeNull();
    // A close in any other room still leaves the board alone.
    expect(boardClosed(open, { id: 'm2', room: 'meeting', verdict: 'pass' }, T0)).toBe(open);
  });

  it('trims a long idea title to the in-world text budget', () => {
    const open = boardOpened({ id: 'm1', room: 'board', subject: 'idea', title: 'A very long idea title that no in-world surface could ever hope to show in full' }, T0)!;
    const closed = boardClosed(open, { id: 'm1', verdict: 'return' }, T0)!;
    expect(boardHeadline(closed, now)!.head.length).toBeLessThanOrEqual(44);
    expect(boardHeadline(closed, now)!.head).toMatch(/…$/);
  });
});
