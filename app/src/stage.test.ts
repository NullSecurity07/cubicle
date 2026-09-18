import { describe, expect, it } from 'vitest';
import { edgeTypes } from './edges';
import { nodeTypes } from './nodes';
import { HANDLE_IDS, WIRE, stageEdges, stageNodes } from './stage';

describe('stage data', () => {
  it('has three rooms and one resource card', () => {
    expect(stageNodes.filter((n) => n.type === 'room')).toHaveLength(3);
    expect(stageNodes.filter((n) => n.type === 'resource')).toHaveLength(1);
  });

  it('has unique node ids and unique edge ids', () => {
    expect(new Set(stageNodes.map((n) => n.id)).size).toBe(stageNodes.length);
    expect(new Set(stageEdges.map((e) => e.id)).size).toBe(stageEdges.length);
  });

  it('wires only existing nodes through known handles', () => {
    const ids = new Set(stageNodes.map((n) => n.id));
    expect(stageEdges).toHaveLength(2);
    for (const edge of stageEdges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
      expect(HANDLE_IDS).toContain(edge.sourceHandle);
      expect(HANDLE_IDS).toContain(edge.targetHandle);
      expect(edge.type).toBe(WIRE.type);
    }
  });

  it('gives every node a fixed size and keeps rooms undeletable', () => {
    for (const node of stageNodes) {
      expect(node.width).toBeGreaterThan(0);
      expect(node.height).toBeGreaterThan(0);
      expect(node.deletable).toBe(false);
    }
  });

  it('gives every room person an accent colour', () => {
    for (const node of stageNodes) {
      if (node.type === 'room') expect(node.data.accent).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('type registration', () => {
  it('registers every node type and edge type the stage uses', () => {
    for (const node of stageNodes) expect(nodeTypes).toHaveProperty(node.type);
    for (const edge of stageEdges) expect(edgeTypes).toHaveProperty(edge.type!);
  });
});
