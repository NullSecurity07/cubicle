import { describe, it, expect } from 'vitest';
import { boardOpened, boardClosed, boardHeadline, BOARD_HEADLINE_MS } from './board.js';

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

  it('trims a long idea title to the in-world text budget', () => {
    const open = boardOpened({ id: 'm1', room: 'board', subject: 'idea', title: 'A very long idea title that no in-world surface could ever hope to show in full' }, T0)!;
    const closed = boardClosed(open, { id: 'm1', verdict: 'return' }, T0)!;
    expect(boardHeadline(closed, now)!.head.length).toBeLessThanOrEqual(44);
    expect(boardHeadline(closed, now)!.head).toMatch(/…$/);
  });
});
