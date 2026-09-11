import { describe, it, expect } from 'vitest';
import { boardSessionOpen } from './owner.js';

describe('owner presence', () => {
  it('is true only while a board meeting is open', () => {
    expect(boardSessionOpen({})).toBe(false);
    expect(boardSessionOpen({ m1: { room: 'meeting', participants: [], open: true } })).toBe(false);
    expect(boardSessionOpen({ m1: { room: 'board', participants: [], open: false } })).toBe(false);
    expect(boardSessionOpen({ m1: { room: 'board', participants: ['ceo'], open: true }, m2: { room: 'meeting', participants: [], open: true } })).toBe(true);
  });
});
