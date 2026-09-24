import { useStore, type Edge } from '@xyflow/react';
import { useMemo } from 'react';
import type { StageNode } from './stage';

type Flow = { nodes: StageNode[]; edges: Edge[] };

// A narrow read of the canvas. `useNodes()` re-renders its reader on every drag frame, because every frame is a new
// list of nodes; this re-renders only when what `pick` returns has changed, compared as text. `pick` must return plain
// data (no functions), and should leave positions out unless it means to follow a drag.
export function useFlowPick<T>(pick: (flow: Flow) => T): T {
  const text = useStore((state) => JSON.stringify(pick({ nodes: state.nodes as StageNode[], edges: state.edges })) ?? 'null');
  return useMemo(() => JSON.parse(text) as T, [text]);
}

// The ids at the other end of every wire that touches `id`, whichever way it was drawn.
export const endsOf = (edges: Pick<Edge, 'source' | 'target'>[], id: string) =>
  new Set(edges.flatMap((edge) => (edge.source === id ? [edge.target] : edge.target === id ? [edge.source] : [])));

export type WiredCard = { id: string; type: string; data: Record<string, unknown> };

// The cards wired to this one, in the order the wires were drawn, as they are now: drawing or removing a wire, or
// renaming a person, shows at once. `kind` keeps only cards of that type.
export function wiredIn({ nodes, edges }: Flow, id: string, kind?: string): WiredCard[] {
  const found = new Map<string, WiredCard>();
  for (const edge of edges) {
    const other = edge.source === id ? edge.target : edge.target === id ? edge.source : null;
    const node = other === null || found.has(other) ? undefined : nodes.find((one) => one.id === other);
    if (node && (!kind || node.type === kind)) found.set(node.id, { id: node.id, type: node.type ?? '', data: node.data as Record<string, unknown> });
  }
  return [...found.values()];
}
export const useWired = (id: string, kind?: string) => useFlowPick((flow) => wiredIn(flow, id, kind));

// Everybody on the stage, as voice casting reads them: who they are and how they sound.
export const everyoneIn = (nodes: StageNode[]) => nodes.flatMap((node) => (node.type === 'room'
  ? [{ id: node.id, name: node.data.name, gender: node.data.gender, voice: node.data.voice }] : []));
