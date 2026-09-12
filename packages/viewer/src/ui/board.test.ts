import { describe, it, expect } from 'vitest';
import { boardOpened, boardClosed, boardHeadline, BOARD_HEADLINE_MS, BOARD_SESSION_MAX_MS, BOARD_MAX_FINDINGS } from './board.js';

const T0 = '2026-09-11T10:00:00.000Z';
const now = Date.parse(T0);

describe('the board room and the whiteboard (spec §6)', () => {
  it('only a board-room meeting touches the board state', () => {
    expect(boardOpened({ id: 'm1', room: 'meeting', agenda: 'standup' }, T0)).toBeNull();
    expect(boardOpened({ id: 'm1', room: 'board', subject: 'idea', title: 'Meal kits' }, T0))
      .toEqual({ id: 'm1', subject: 'idea', title: 'Meal kits', verdict: null, findings: [], pressure: '', rubric: '', at: T0 });
    expect(boardOpened({ id: 'm1', room: 'board', agenda: "Pre-mortem: this cycle's plan" }, T0)!.subject).toBe('plan');
  });

  it('closes only the session it opened, and keeps at most three findings', () => {
    const open = boardOpened({ id: 'm1', room: 'board', subject: 'plan' }, T0)!;
    expect(boardClosed(open, { id: 'other', verdict: 'return' }, T0)).toBe(open);
    expect(boardClosed(null, { id: 'm1', verdict: 'pass' }, T0)).toBeNull();
    const closed = boardClosed(open, { id: 'm1', verdict: 'return', findings: ['a', 'b', 'c', 'd', 'e'] }, T0)!;
    expect(closed.verdict).toBe('return');
    // Four, which is what the board may raise: the wall shows three of them, the doc panel shows them all.
    expect(closed.findings).toEqual(['a', 'b', 'c', 'd']);
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

describe('the whiteboard says what the pressure test said (spec §6)', () => {
  const at = '2026-09-12T09:00:00.000Z';
  const now = Date.parse(at) + 1000;
  const open = boardOpened({ room: 'board', id: 'm1', subject: 'idea', title: 'Meal kits for nurseries' }, at)!;

  it('a closed idea session leads with the verdict word and the rubric\'s total, whole (ruling H6)', () => {
    const closed = boardClosed(open, { id: 'm1', room: 'board', verdict: 'return', findings: ['the payer is not the user', 'no van before 7am', 'third', 'fourth'], pressure: 'PIVOT REQUIRED', rubric: '7/10 — core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1' }, at)!;
    const h = boardHeadline(closed, now)!;
    expect(h.head).toBe('The board returned: Meal kits for nurseries');
    expect(h.lines).toHaveLength(3);
    // The whole line, asserted exactly: the wall cannot hold the five dimensions and used to print them
    // amputated after one and a bit — `PIVOT REQUIRED · 7/10 — core…`, with a dangling comma.
    expect(h.lines[0]).toBe('PIVOT REQUIRED · 7/10');
    expect(h.lines[0]).not.toContain('…');
    expect(h.lines[1]).toBe('• the payer is not the user');
    expect(h.head.length).toBeLessThanOrEqual(44);
    for (const l of h.lines) expect(l.length, l).toBeLessThanOrEqual(42);
    expect(h.short).toBe('PIVOT…');
    // The wall keeps three lines; the state keeps the fourth finding for the panel, which has room for it.
    expect(closed.findings).toHaveLength(BOARD_MAX_FINDINGS);
  });

  it('a verdict with no rubric shows the word alone, and a rubric with no dimensions shows its total', () => {
    const bare = boardClosed(open, { id: 'm1', room: 'board', verdict: 'pass', findings: [], pressure: 'STRONG', rubric: '' }, at)!;
    expect(boardHeadline(bare, now)!.lines).toEqual(['STRONG']);
    const total = boardClosed(open, { id: 'm1', room: 'board', verdict: 'pass', findings: [], pressure: 'STRONG', rubric: '9/10' }, at)!;
    expect(boardHeadline(total, now)!.lines).toEqual(['STRONG · 9/10']);
  });

  it('a plan session, and a board that ran before the pressure test, read exactly as they did', () => {
    const planOpen = boardOpened({ room: 'board', id: 'm2', subject: 'plan', title: "this cycle's plan" }, at)!;
    const planClosed = boardClosed(planOpen, { id: 'm2', room: 'board', verdict: 'pass', findings: ['watch the free tier'] }, at)!;
    const h = boardHeadline(planClosed, now)!;
    expect(h.head).toBe('The board passed the plan');
    expect(h.lines).toEqual(['• watch the free tier']);
    expect(h.short).toBe('pass');
    expect(planClosed.pressure).toBe('');
  });

  it('an open session is untouched, and a closed one still ages off the wall', () => {
    expect(boardHeadline(open, now)).toEqual({ head: 'The board is sitting', lines: ['Meal kits for nurseries'], short: 'Board' });
    const closed = boardClosed(open, { id: 'm1', room: 'board', verdict: 'pass', findings: [], pressure: 'STRONG', rubric: '9/10' }, at)!;
    expect(boardHeadline(closed, Date.parse(at) + BOARD_HEADLINE_MS + 1)).toBeNull();
  });
});
