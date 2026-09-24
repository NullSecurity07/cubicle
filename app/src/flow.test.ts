import { describe, expect, it } from 'vitest';
import { grown, wiredIn } from './flow';
import type { StageNode } from './stage';

describe('a card saved too small', () => {
  const least = { width: 360, height: 300 };
  const to = { width: 360, height: 320 };
  it('grows each short side, once, to the size it needs', () => {
    expect(grown({ width: 300, height: 200 }, least, to)).toEqual({ width: 360, height: 320 });
    expect(grown({ width: 500, height: 200 }, least, to)).toEqual({ width: 500, height: 320 });
  });
  it('leaves a card that is big enough as the founder sized it', () => {
    expect(grown({ width: 400, height: 300 }, least, to)).toEqual({});
  });
});

describe('the cards wired to one', () => {
  const node = (id: string, type: string, data: object = {}) => ({ id, type, position: { x: 0, y: 0 }, data }) as unknown as StageNode;
  const nodes = [node('board', 'board'), node('maya', 'room', { name: 'Maya' }), node('doc', 'doc'), node('sam', 'room', { name: 'Sam' })];
  const edges = [{ id: 'a', source: 'maya', target: 'board' }, { id: 'b', source: 'board', target: 'doc' }, { id: 'c', source: 'board', target: 'sam' }, { id: 'd', source: 'sam', target: 'board' }];
  it('are found whichever way the wire was drawn, once each, and only of the kind asked for', () => {
    expect(wiredIn({ nodes, edges }, 'board').map((one) => one.id)).toEqual(['maya', 'doc', 'sam']);
    expect(wiredIn({ nodes, edges }, 'board', 'room').map((one) => one.data.name)).toEqual(['Maya', 'Sam']);
  });
});
