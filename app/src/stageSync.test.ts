import { describe, expect, it } from 'vitest';
import { seedStage, type Stage } from '../shared/model';
import { mergeStage, saveOver, type PutAnswer } from './stageSync';

const base: Stage = { ...structuredClone(seedStage), cards: [], rev: 3 };
const room = (id: string, x = 0) => ({ ...seedStage.rooms[0], id, x });

describe('a stage taken in from another window', () => {
  it('keeps what this window changed and what the other one added, and lets each take away its own', () => {
    // This window moved the first person and added one; the other window added a note and took the brand doc away.
    const mine: Stage = { ...structuredClone(base), rooms: [{ ...base.rooms[0], x: 999 }, base.rooms[1], room('sales')] };
    const theirs: Stage = { ...structuredClone(base), docs: base.docs.slice(1), cards: [{ id: 'note-1', kind: 'note', text: 'hi', x: 0, y: 0, w: 200, h: 200 }], wires: [], rev: 4 };
    const merged = mergeStage(base, mine, theirs);
    expect(merged.rooms.map((one) => [one.id, one.x])).toEqual([[base.rooms[0].id, 999], [base.rooms[1].id, base.rooms[1].x], ['sales', 0]]);
    expect(merged.docs.map((one) => one.id)).toEqual(base.docs.slice(1).map((one) => one.id));
    expect(merged.cards!.map((one) => one.id)).toEqual(['note-1']);
    expect(merged.rev).toBe(4);
  });

  it('takes a card this window left alone as the other window has it, and drops a wire whose end is gone', () => {
    const theirs: Stage = { ...structuredClone(base), rooms: [{ ...base.rooms[0], x: 5 }, base.rooms[1]], rev: 4 };
    const mine: Stage = { ...structuredClone(base), rooms: [base.rooms[0]] };
    const merged = mergeStage(base, mine, theirs);
    expect(merged.rooms.map((one) => [one.id, one.x])).toEqual([[base.rooms[0].id, 5]]);
    expect(merged.wires.every((wire) => wire.from !== base.rooms[1].id && wire.to !== base.rooms[1].id)).toBe(true);
  });
});

describe('a save over a stage that moved on', () => {
  it('takes in the newer stage and saves again once, on its revision', async () => {
    const theirs: Stage = { ...structuredClone(base), cards: [{ id: 'note-1', kind: 'note', text: 'hi', x: 0, y: 0, w: 200, h: 200 }], rev: 7 };
    const mine: Stage = { ...structuredClone(base), rooms: [...base.rooms, room('sales')] };
    const sent: Stage[] = [];
    const put = async (stage: Stage): Promise<PutAnswer> => { sent.push(stage); return sent.length === 1 ? { stale: theirs } : { rev: 8 }; };
    const out = await saveOver(base, mine, put);
    expect(sent.map((one) => one.rev)).toEqual([3, 7]);
    expect(sent[1].rooms.map((one) => one.id)).toContain('sales');
    expect(sent[1].cards!.map((one) => one.id)).toEqual(['note-1']);
    expect(out.saved).toBe(true);
    expect(out.base.rev).toBe(8);
    expect(out.merged?.cards!.map((one) => one.id)).toEqual(['note-1']);
  });

  it('gives up after the second refusal, holding the newest stage it was shown', async () => {
    let rev = 10;
    const put = async (): Promise<PutAnswer> => ({ stale: { ...structuredClone(base), rev: rev++ } });
    const out = await saveOver(base, { ...structuredClone(base), rooms: [...base.rooms, room('sales')] }, put);
    expect(out.saved).toBe(false);
    expect(out.base.rev).toBe(11);
    expect(out.merged!.rooms.map((one) => one.id)).toContain('sales');
  });

  it('saves straight through when nothing moved on', async () => {
    const out = await saveOver(base, base, async (stage) => ({ rev: (stage.rev ?? 0) + 1 }));
    expect(out).toMatchObject({ saved: true, base: { rev: 4 } });
    expect(out.merged).toBeUndefined();
  });
});
