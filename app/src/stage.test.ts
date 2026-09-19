import { describe, expect, it } from 'vitest';
import { seedStage, type Stage } from '../shared/model';
import { edgeTypes } from './edges';
import { nodeTypes } from './nodes';
import { HANDLE_IDS, fromFlow, toFlow } from './stage';

describe('seed stage', () => {
  it('has two rooms, a brand doc, a pinned company brief and no founder card', () => {
    expect(seedStage.rooms.map((room) => room.id)).toEqual(['marketing', 'build']);
    expect(seedStage.docs).toHaveLength(2);
  });

  it('has unique ids and wires only existing cards through known handles', () => {
    const ids = [...seedStage.rooms, ...seedStage.docs].map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const wire of seedStage.wires) {
      expect(ids).toContain(wire.from);
      expect(ids).toContain(wire.to);
      expect(HANDLE_IDS).toContain(wire.fromHandle);
      expect(HANDLE_IDS).toContain(wire.toHandle);
    }
  });
});

describe('flow mapping', () => {
  it('round-trips the stage through React Flow nodes and edges', () => {
    const { nodes, edges } = toFlow(seedStage);
    expect(fromFlow(nodes, edges)).toEqual(seedStage);
  });

  it('uses registered node and edge types, fixed sizes, header-only dragging', () => {
    const { nodes, edges } = toFlow(seedStage);
    for (const node of nodes) {
      expect(nodeTypes).toHaveProperty(node.type);
      expect(node.width).toBeGreaterThan(0);
      expect(node.dragHandle).toBe('.card__header');
      expect(node.deletable).toBe(false);
    }
    for (const edge of edges) expect(edgeTypes).toHaveProperty(edge.type!);
  });

  it('round-trips every kind of card with exactly the fields it carries', () => {
    const stage: Stage = { ...seedStage, cards: [
      { id: 'b', kind: 'browser', headed: true, x: 1, y: 2, w: 3, h: 4 }, { id: 'b2', kind: 'browser', x: 1, y: 2, w: 3, h: 4 },
      { id: 'p', kind: 'project', path: '/code/app', x: 1, y: 2, w: 3, h: 4 }, { id: 'k', kind: 'board', x: 1, y: 2, w: 3, h: 4 },
      { id: 'n', kind: 'note', text: 'Ship weekly', color: '#6fcf97', x: 1, y: 2, w: 3, h: 4 }, { id: 'i', kind: 'image', path: 'uploads/a.png', x: 1, y: 2, w: 3, h: 4 },
      { id: 'l', kind: 'link', url: 'https://example.com', title: 'Example', x: 1, y: 2, w: 3, h: 4 },
    ] };
    const { nodes, edges } = toFlow(stage);
    expect(fromFlow(nodes, edges).cards).toEqual(stage.cards);
  });
});

