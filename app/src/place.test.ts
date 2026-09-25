import { describe, expect, it } from 'vitest';
import { newCard } from './addCard';
import { freeSpot } from './place';
import type { StageNode } from './stage';

const card = (id: string, x: number, y: number, width = 300, height = 200, type = 'note') =>
  ({ id, type, position: { x, y }, width, height, data: {} }) as unknown as StageNode;

describe('freeSpot', () => {
  it('keeps the place asked for when nothing is there', () => {
    expect(freeSpot([card('a', 1000, 1000)], { x: 0, y: 0 }, 200, 100)).toEqual({ x: 0, y: 0 });
  });

  it('moves to the nearest free place beside a card in the way, never on top of it or touching it', () => {
    const at = freeSpot([card('a', 0, 0)], { x: 0, y: 0 }, 200, 100);
    expect(at).not.toEqual({ x: 0, y: 0 });
    // One step of the widening ring: the card's own width or height plus the gap.
    expect([Math.abs(at.x), Math.abs(at.y)].some((step) => step === 240 || step === 140)).toBe(true);
    expect(freeSpot([card('a', 0, 0)], at, 200, 100)).toEqual(at);
  });

  it('reads a card measured by the canvas when it has no size of its own', () => {
    const measured = { ...card('a', 0, 0), width: undefined, height: undefined, measured: { width: 300, height: 200 } } as unknown as StageNode;
    expect(freeSpot([measured], { x: 100, y: 50 }, 100, 100)).not.toEqual({ x: 100, y: 50 });
  });
});

describe('a new card', () => {
  it('lands centred where it was asked for, at its kind\'s size, selected', () => {
    const made = newCard([], 'note', { x: 500, y: 400 }, { text: 'hi' });
    expect(made).toMatchObject({ type: 'note', position: { x: 390, y: 310 }, width: 220, height: 180, selected: true, data: { text: 'hi' } });
  });

  it('steps aside for a card already there', () => {
    const made = newCard([card('a', 390, 310, 220, 180)], 'note', { x: 500, y: 400 });
    expect(made.position).not.toEqual({ x: 390, y: 310 });
  });

  it('gives each new person the next colour', () => {
    const first = newCard([], 'room', { x: 0, y: 0 });
    const second = newCard([first], 'room', { x: 0, y: 0 });
    expect((first.data as { accent: string }).accent).not.toBe((second.data as { accent: string }).accent);
  });
});
