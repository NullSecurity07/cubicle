import { describe, it, expect } from 'vitest';
import { pantryOpened, pantryTurn, pantryClosed, pantryStale, PANTRY_SESSION_MAX_MS, PANTRY_SHOWN_MS, type PantryState } from './pantry.js';

const T0 = '2026-09-12T15:00:00.000Z';
const open = () => pantryOpened({ id: 'meet_1', room: 'pantry', participants: ['clo', 'cmo'] }, T0)!;

describe('the pantry panel is fed by events, never by the snapshot (spec §8)', () => {
  it('opens only on a pantry meeting', () => {
    expect(open()).toMatchObject({ id: 'meet_1', participants: ['clo', 'cmo'], turns: [], idea: null, note: null, open: true });
    expect(pantryOpened({ id: 'b', room: 'board', participants: ['advisor_skeptic'] }, T0)).toBeNull();
    expect(pantryOpened({ id: 'm', room: 'meeting', participants: ['coo'] }, T0)).toBeNull();
  });

  it('collects the turns of its own chat, and no other', () => {
    let st: PantryState | null = open();
    st = pantryTurn(st, 'clo', { id: 'meet_1', round: 1, text: 'Nurseries keep asking for a weekly box.' }, '2026-09-12T15:00:10.000Z');
    st = pantryTurn(st, 'cmo', { id: 'meet_1', round: 2, text: 'IDEA: Weekly meal kits for nurseries' }, '2026-09-12T15:00:20.000Z');
    st = pantryTurn(st, 'advisor_skeptic', { id: 'board_9', round: 1, text: 'not our chat' }, '2026-09-12T15:00:25.000Z');
    st = pantryTurn(st, 'cmo', { id: 'meet_1', round: 3, text: '   ' }, '2026-09-12T15:00:30.000Z');
    expect(st!.turns).toEqual([
      { role: 'clo', text: 'Nurseries keep asking for a weekly box.' },
      { role: 'cmo', text: 'IDEA: Weekly meal kits for nurseries' },
    ]);
  });

  it('never grows past the six turns the chat can have', () => {
    let st: PantryState | null = open();
    for (let i = 0; i < 9; i++) st = pantryTurn(st, i % 2 ? 'cmo' : 'clo', { id: 'meet_1', round: i + 1, text: `turn ${i}` }, T0);
    expect(st!.turns).toHaveLength(6);
    expect(st!.turns[0].text).toBe('turn 3');
  });

  it('takes the idea and the note path off the close, and a close with neither leaves them null', () => {
    const closed = pantryClosed(open(), { id: 'meet_1', room: 'pantry', turns: 6, path: 'Pantry/2026-09-12-clo-and-cmo.md', decision: 'IDEA: Weekly meal kits for nurseries' }, T0)!;
    expect(closed).toMatchObject({ open: false, idea: 'Weekly meal kits for nurseries', notFiled: null, note: 'Pantry/2026-09-12-clo-and-cmo.md' });
    expect(pantryClosed(open(), { id: 'meet_1', room: 'pantry', turns: 2, decision: 'no idea' }, T0)!.idea).toBeNull();
  });

  it('an idea the rule refused keeps its reason rather than reading as an idea (ruling Q12)', () => {
    const closed = pantryClosed(open(), { id: 'meet_1', room: 'pantry', turns: 6, path: 'Pantry/p.md', decision: 'IDEA not filed: too close to Ideas/meal-kits.md ("Meal kits")' }, T0)!;
    expect(closed.idea).toBeNull();
    expect(closed.notFiled).toBe('too close to Ideas/meal-kits.md ("Meal kits")');
  });

  it('a close for a different pantry chat clears the panel; one in another room leaves it alone', () => {
    expect(pantryClosed(open(), { id: 'meet_2', room: 'pantry', decision: 'x' }, T0)).toBeNull();
    expect(pantryClosed(open(), { id: 'board_9', room: 'board', decision: 'VERDICT: pass' }, T0)).toMatchObject({ id: 'meet_1', open: true });
    expect(pantryClosed(null, { id: 'meet_1', room: 'pantry', decision: 'x' }, T0)).toBeNull();
  });

  it('two clocks: a lost close after ten minutes, a finished chat after half an hour (Decision 21)', () => {
    const t = Date.parse(T0);
    expect(pantryStale(null, t)).toBe(true);
    expect(pantryStale(open(), t + 60_000)).toBe(false);
    expect(pantryStale(open(), t + PANTRY_SESSION_MAX_MS + 1)).toBe(true);
    const closed = pantryClosed(open(), { id: 'meet_1', room: 'pantry', decision: 'IDEA: a new one for the board' }, T0)!;
    expect(pantryStale(closed, t + PANTRY_SESSION_MAX_MS + 1)).toBe(false);
    expect(pantryStale(closed, t + PANTRY_SHOWN_MS + 1)).toBe(true);
  });
});
