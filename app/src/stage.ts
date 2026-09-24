import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { AppPreset } from '../shared/apps';
import type { Box, Card, Doc, Room, Shape, Stage, Switch, VideoLook } from '../shared/model';

export type RoomData = Omit<Room, keyof Box | 'id'>;
export type DocData = Omit<Doc, keyof Box | 'id'>;
export type RoomNodeType = Node<RoomData, 'room'>;
export type DocNodeType = Node<DocData, 'doc'>;
export type BrowserNodeType = Node<{ headed?: boolean; app?: AppPreset }, 'browser'>;
export type ProjectNodeType = Node<{ path: string; model?: string; session?: string }, 'project'>;
export type BoardNodeType = Node<Record<string, never>, 'board'>;
export type NoteNodeType = Node<{ text: string; color?: string }, 'note'>;
export type ImageNodeType = Node<{ path: string }, 'image'>;
export type LinkNodeType = Node<{ url: string; title?: string }, 'link'>;
export type SourceNodeType = Node<{ url: string; about: string; title?: string }, 'source'>;
// A note out of the founder's library. The card carries which note it is; the words stay in the library.
export type LibraryNodeType = Node<{ noteId: string }, 'library'>;
export type ImageGenNodeType = Node<{ prompt?: string; shape?: Shape }, 'imagegen'>;
export type VoiceGenNodeType = Node<{ text?: string; voice?: string }, 'voicegen'>;
export type VideoGenNodeType = Node<{ brief?: string; format?: Shape; look?: VideoLook; silent?: boolean; purpose?: string; length?: number; pace?: 'calm' | 'punchy'; music?: string; voice?: string; captions?: Switch; sfx?: Switch; ai?: Switch; address?: string; person?: Switch; speed?: 'draft' }, 'videogen'>;
export type CardNodeType = BrowserNodeType | ProjectNodeType | BoardNodeType | NoteNodeType | ImageNodeType | LinkNodeType | SourceNodeType | LibraryNodeType | ImageGenNodeType | VoiceGenNodeType | VideoGenNodeType;
export type StageNode = RoomNodeType | DocNodeType | CardNodeType;

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
    // Every other card: the node type is the card kind, the node data is whatever the card carries beyond its box.
    ...(stage.cards ?? []).map(({ id, x, y, w, h, kind, ...data }) => ({ id, type: kind, position: { x, y }, width: w, height: h, data, ...CARD }) as CardNodeType),
  ];
  const edges = stage.wires.map((wire): Edge => ({ id: wire.id, source: wire.from, sourceHandle: wire.fromHandle, target: wire.to, targetHandle: wire.toHandle, ...WIRE }));
  return { nodes, edges };
}

// Unset and false fields stay out of the saved stage, so a card reads back exactly as it was written.
const clean = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== false && value !== ''));

export function fromFlow(nodes: StageNode[], edges: Edge[]): Stage {
  const box = (node: StageNode): Box => ({
    x: Math.round(node.position.x), y: Math.round(node.position.y),
    w: Math.round(node.width ?? node.measured?.width ?? 0), h: Math.round(node.height ?? node.measured?.height ?? 0),
  });
  return {
    rooms: nodes.filter((node): node is RoomNodeType => node.type === 'room').map((node) => ({ id: node.id, ...node.data, ...box(node) })),
    docs: nodes.filter((node): node is DocNodeType => node.type === 'doc').map(({ id, data: { pinned, ...data }, ...node }) => ({ id, ...data, ...(pinned ? { pinned: true } : {}), ...box({ ...node, id } as StageNode) })),
    cards: nodes.filter((node): node is CardNodeType => node.type !== 'room' && node.type !== 'doc').map((node) => ({ id: node.id, kind: node.type, ...clean(node.data), ...box(node) }) as Card),
    wires: edges.map((edge) => ({ id: edge.id, from: edge.source, fromHandle: edge.sourceHandle ?? 'r', to: edge.target, toHandle: edge.targetHandle ?? 'l' })),
  };
}
