import { describe, it, expect } from 'vitest';
import { boardSessionOpen } from './owner.js';
import { BOARD_SESSION_MAX_MS } from '../ui/board.js';

const T0 = '2026-09-11T10:00:00.000Z';
const now = Date.parse(T0);

describe('owner presence', () => {
  it('is true only while a board meeting is open', () => {
    expect(boardSessionOpen({}, now)).toBe(false);
    expect(boardSessionOpen({ m1: { room: 'meeting', participants: [], open: true, at: T0 } }, now)).toBe(false);
    expect(boardSessionOpen({ m1: { room: 'board', participants: [], open: false, at: T0 } }, now)).toBe(false);
    expect(boardSessionOpen({ m1: { room: 'board', participants: ['ceo'], open: true, at: T0 }, m2: { room: 'meeting', participants: [], open: true, at: T0 } }, now)).toBe(true);
  });

  // The whiteboard recovering from a lost `meeting.closed` is only half of it: the owner used to stay in the
  // chair at the head of the table until the next session opened, which is the office claiming a meeting is in
  // progress (§6.2) on the board-room floor rather than on the wall.
  it('gives up on a session whose close never arrived', () => {
    const sitting = { m1: { room: 'board', participants: ['ceo'], open: true, at: T0 } };
    expect(boardSessionOpen(sitting, now + BOARD_SESSION_MAX_MS - 1)).toBe(true);
    expect(boardSessionOpen(sitting, now + BOARD_SESSION_MAX_MS + 1)).toBe(false);
  });
});
