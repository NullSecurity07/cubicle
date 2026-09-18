import { MarkerType, type Edge, type Node } from '@xyflow/react';

export type RoomData = { role: string; image: string };
export type ResourceData = { title: string };
export type RoomNodeType = Node<RoomData, 'room'>;
export type ResourceNodeType = Node<ResourceData, 'resource'>;
export type StageNode = RoomNodeType | ResourceNodeType;

export const HANDLE_IDS = ['l', 'r', 't', 'b'] as const;
export const ACCENT = '#4e8cff';

// Spread into every edge, hardcoded or drawn, so all wires look the same.
export const WIRE = {
  type: 'wire',
  markerEnd: { type: MarkerType.ArrowClosed, color: ACCENT, width: 16, height: 16 },
} satisfies Pick<Edge, 'type' | 'markerEnd'>;

const ROOM = { width: 360, height: 300, deletable: false } as const;

export const stageNodes: StageNode[] = [
  { id: 'founder', type: 'room', position: { x: 0, y: 0 }, data: { role: 'Founder', image: '/rooms/founder.webp' }, ...ROOM },
  { id: 'marketing', type: 'room', position: { x: 540, y: -200 }, data: { role: 'Marketing', image: '/rooms/marketing.webp' }, ...ROOM },
  { id: 'build', type: 'room', position: { x: 540, y: 200 }, data: { role: 'Build', image: '/rooms/build.webp' }, ...ROOM },
  { id: 'brand-doc', type: 'resource', position: { x: 1080, y: -110 }, data: { title: 'Brand doc' }, width: 240, height: 120, deletable: false },
];

export const stageEdges: Edge[] = [
  { id: 'founder-marketing', source: 'founder', sourceHandle: 'r', target: 'marketing', targetHandle: 'l', ...WIRE },
  { id: 'marketing-brand-doc', source: 'marketing', sourceHandle: 'r', target: 'brand-doc', targetHandle: 'l', ...WIRE },
];
