import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { Box, Card, Doc, Room, Stage } from '../shared/model';

export type RoomData = Omit<Room, keyof Box | 'id'>;
export type DocData = Omit<Doc, keyof Box | 'id'>;
export type RoomNodeType = Node<RoomData, 'room'>;
export type DocNodeType = Node<DocData, 'doc'>;
export type BrowserNodeType = Node<{ headed?: boolean }, 'browser'>;
export type ProjectNodeType = Node<{ path: string }, 'project'>;
export type StageNode = RoomNodeType | DocNodeType | BrowserNodeType | ProjectNodeType;

export const HANDLE_IDS = ['l', 'r', 't', 'b'] as const;
export const ACCENT = '#4e8cff';

// Spread into every edge, loaded or drawn, so all wires look the same.
export const WIRE = {
  type: 'wire',
  markerEnd: { type: MarkerType.ArrowClosed, color: ACCENT, width: 16, height: 16 },
} satisfies Pick<Edge, 'type' | 'markerEnd'>;

// Cards move by their header only, so text inside a card can be selected and scrolled.
export const CARD = { dragHandle: '.card__header', deletable: false } as const;

export function toFlow(stage: Stage): { nodes: StageNode[]; edges: Edge[] } {
  const nodes: StageNode[] = [
    ...stage.rooms.map(({ id, x, y, w, h, ...data }): RoomNodeType => ({ id, type: 'room', position: { x, y }, width: w, height: h, data, ...CARD })),
    ...stage.docs.map(({ id, x, y, w, h, ...data }): DocNodeType => ({ id, type: 'doc', position: { x, y }, width: w, height: h, data, ...CARD })),
    ...(stage.cards ?? []).map((card): BrowserNodeType | ProjectNodeType => {
      const place = { id: card.id, position: { x: card.x, y: card.y }, width: card.w, height: card.h, ...CARD };
      return card.kind === 'project' ? { ...place, type: 'project', data: { path: card.path } } : { ...place, type: 'browser', data: card.headed ? { headed: true } : {} };
    }),
  ];
  const edges = stage.wires.map((wire): Edge => ({ id: wire.id, source: wire.from, sourceHandle: wire.fromHandle, target: wire.to, targetHandle: wire.toHandle, ...WIRE }));
  return { nodes, edges };
}

export function fromFlow(nodes: StageNode[], edges: Edge[]): Stage {
  const box = (node: StageNode): Box => ({
    x: Math.round(node.position.x), y: Math.round(node.position.y),
    w: Math.round(node.width ?? node.measured?.width ?? 0), h: Math.round(node.height ?? node.measured?.height ?? 0),
  });
  return {
    rooms: nodes.filter((node): node is RoomNodeType => node.type === 'room').map((node) => ({ id: node.id, ...node.data, ...box(node) })),
    docs: nodes.filter((node): node is DocNodeType => node.type === 'doc').map((node) => ({ id: node.id, ...node.data, ...box(node) })),
    cards: nodes.flatMap((node): Card[] => (node.type === 'browser' ? [{ id: node.id, kind: 'browser', ...(node.data.headed ? { headed: true } : {}), ...box(node) }]
      : node.type === 'project' ? [{ id: node.id, kind: 'project', path: node.data.path, ...box(node) }] : [])),
    wires: edges.map((edge) => ({ id: edge.id, from: edge.source, fromHandle: edge.sourceHandle ?? 'r', to: edge.target, toHandle: edge.targetHandle ?? 'l' })),
  };
}
