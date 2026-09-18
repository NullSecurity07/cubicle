import { MarkerType, type Edge, type Node } from '@xyflow/react';

export type RoomData = { role: string; accent: string };
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

const ROOM = { width: 280, height: 260, deletable: false } as const;

export const stageNodes: StageNode[] = [
  { id: 'founder', type: 'room', position: { x: 0, y: 0 }, data: { role: 'Founder', accent: '#f0b35a' }, ...ROOM },
  { id: 'marketing', type: 'room', position: { x: 460, y: -180 }, data: { role: 'Marketing', accent: '#ee8a72' }, ...ROOM },
  { id: 'build', type: 'room', position: { x: 460, y: 180 }, data: { role: 'Build', accent: '#4e8cff' }, ...ROOM },
  { id: 'brand-doc', type: 'resource', position: { x: 920, y: -110 }, data: { title: 'Brand doc' }, width: 240, height: 120, deletable: false },
];

export const stageEdges: Edge[] = [
  { id: 'founder-marketing', source: 'founder', sourceHandle: 'r', target: 'marketing', targetHandle: 'l', ...WIRE },
  { id: 'marketing-brand-doc', source: 'marketing', sourceHandle: 'r', target: 'brand-doc', targetHandle: 'l', ...WIRE },
];
