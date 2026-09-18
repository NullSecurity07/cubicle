/**
 * `Office/campus.md`, applied to the campus — and the office's own helpers on top of it.
 *
 * The template campus (`config/world/office.json`) is the base and never changes. The note is what the owner did
 * on top of it: desks and zones they moved, props they took away, things they added, and the lines they drew
 * between them. One pure function turns the two into the campus the renderer draws, so "the office moved" and
 * "the note changed" are the same event arriving by two routes.
 *
 * That function, the shape of the note and what a connection means are **core's** (`@cubicle/core/campus`),
 * re-exported through `campus.ts`: the daemon validates every write against the same rules and the tools are
 * gated by the same lines, and a second copy here would be the office and the company disagreeing the first time
 * either was changed. What is below is the part only a pointer needs — where a thing is on screen, what is in the
 * way of a drop, snapping, and the ids the selection works in.
 */
import type { Rect } from './iso.js';
import type { AccentName } from './materials.js';
import {
  type CampusLayout, type CampusMap, type LayoutConnection, type LayoutNode, type Pt, type ResourceKind,
  type StationFamily, EMPTY_LAYOUT, RESOURCE_SIZE, STATION_FAMILIES, connected, inRect, resourceRect, zoneAt,
} from './campus.js';

export {
  applyLayout, connected, connectionsOf, labelOfNode, resourceRect, RESOURCE_KINDS, RESOURCE_LABEL, RESOURCE_SIZE,
  STATION_FAMILIES, STATION_LABEL,
} from './campus.js';
export type { CampusLayout, LayoutNode, LayoutConnection, ResourceNode, ResourceKind, StationFamily } from './campus.js';

/** The four the dock's Tool menu offers: the browser has a dock glyph of its own, so it is not on this menu. */
export const TOOLS: StationFamily[] = STATION_FAMILIES.filter((f) => f !== 'browser');

export const emptyLayout = (): CampusLayout => ({ ...EMPTY_LAYOUT, nodes: {}, connections: [] });

/** A layout off the wire, made safe to work with: anything that is not the shape above is dropped, never thrown. */
export function asLayout(raw: unknown): CampusLayout {
  const o = (raw ?? {}) as Partial<CampusLayout>;
  const nodes: Record<string, LayoutNode> = {};
  for (const [id, n] of Object.entries(o.nodes ?? {})) if (n && typeof n === 'object') nodes[id] = { ...(n as LayoutNode) };
  const connections: LayoutConnection[] = [];
  for (const c of Array.isArray(o.connections) ? o.connections : []) {
    if (!c || typeof c !== 'object') continue;
    const { from, to, kind } = c as LayoutConnection;
    if (typeof from === 'string' && typeof to === 'string' && (kind === 'peer' || kind === 'access')) connections.push({ from, to, kind });
  }
  return { version: 1, nodes, connections };
}

/** No zone may be dragged smaller than this, in cells: below it the handles are on top of each other. */
export const MIN_ZONE = 3;

/* ============================================================================================================ */
/* helpers — what only a pointer needs: screen boxes, what is in the way, snapping, and the edge ids          */
/* ============================================================================================================ */

export type NodeKind = 'desk' | 'zone' | 'prop' | 'resource';
export interface Anchor { id: string; kind: NodeKind; rect: Rect; at: Pt; label: string; accent: AccentName }

/** Where a node is on the campus, whatever kind it is; null for an id the campus does not have. */
export function anchorOf(map: CampusMap, id: string): Anchor | null {
  const d = map.desks[id];
  if (d) return { id, kind: 'desk', rect: d.rect, at: { x: (d.rect.x0 + d.rect.x1) / 2, y: (d.rect.y0 + d.rect.y1) / 2 }, label: id, accent: d.accent };
  const r = map.resources[id];
  if (r) return { id, kind: 'resource', rect: r.rect, at: r.at, label: r.label, accent: r.accent };
  const z = map.zoneById[id];
  if (z) return { id, kind: 'zone', rect: z.rect, at: { x: (z.rect.x0 + z.rect.x1) / 2, y: (z.rect.y0 + z.rect.y1) / 2 }, label: z.label, accent: z.accent };
  const p = map.props.find((q) => q.id === id);
  if (p) return { id, kind: 'prop', rect: p.rect, at: p.at, label: p.kind, accent: 'neutral' };
  return null;
}

/** Snap to half a cell — fine enough to line two desks up, coarse enough that nothing lands off the grid. */
export const SNAP = 0.5;
export const snap = (v: number, step = SNAP): number => Math.round(v / step) * step;
export const snapPt = (p: Pt, step = SNAP): Pt => ({ x: snap(p.x, step), y: snap(p.y, step) });

/** The prop kinds that are furniture rather than dressing: something stands there and nothing else may. */
const SOLID_PROPS = new Set(['boardtable', 'counter', 'hightable', 'shelf']);

const overlaps = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * What is already in this footprint, or null when the spot is free. `exceptId` is the thing being moved, which
 * cannot be in its own way. Zones are not consulted: a zone is floor, and everything stands on floor.
 */
export function occupiedBy(map: CampusMap, rect: Rect, exceptId = ''): string | null {
  const wall = map.wall;
  if (rect.x0 < wall || rect.y0 < wall || rect.x1 > map.width || rect.y1 > map.height) return 'the wall';
  for (const [id, d] of Object.entries(map.desks)) if (id !== exceptId && overlaps(rect, d.rect)) return id;
  for (const [id, r] of Object.entries(map.resources)) if (id !== exceptId && overlaps(rect, r.rect)) return id;
  for (const p of map.props) if (p.id !== exceptId && SOLID_PROPS.has(p.kind) && overlaps(rect, p.rect)) return p.id;
  for (const s of Object.values(map.screens)) {
    const r: Rect = s.axis === 'x' ? { x0: s.x, y0: s.y - 0.3, x1: s.x + s.len, y1: s.y + 0.3 } : { x0: s.x - 0.3, y0: s.y, x1: s.x + 0.3, y1: s.y + s.len };
    if (overlaps(rect, r)) return s.kind;
  }
  return null;
}

/* ---- connections ------------------------------------------------------------------------------------------- */

const samePair = (c: LayoutConnection, a: string, b: string): boolean => (c.from === a && c.to === b) || (c.from === b && c.to === a);

/**
 * What a line between these two would mean, or null where there is no such line to draw.
 *
 * desk ↔ desk is `peer` — they may message each other. desk → resource is `access` — that agent may use it.
 * Resource to resource is nothing: a kiosk has nobody to talk to.
 */
export function connectionKind(map: CampusMap, a: string, b: string): LayoutConnection['kind'] | null {
  if (a === b) return null;
  const A = anchorOf(map, a), B = anchorOf(map, b);
  if (!A || !B) return null;
  if (A.kind === 'desk' && B.kind === 'desk') return 'peer';
  if (A.kind === 'desk' && B.kind === 'resource') return 'access';
  if (A.kind === 'resource' && B.kind === 'desk') return 'access';
  return null;
}

/** Add a line, in the shape the daemon stores it: a desk is always the `from` of an `access`. */
export function withConnection(layout: CampusLayout, map: CampusMap, a: string, b: string): CampusLayout {
  const kind = connectionKind(map, a, b);
  if (!kind || connected(layout, a, b)) return layout;
  const desk = map.desks[a] ? a : b;
  const other = desk === a ? b : a;
  return { ...layout, connections: [...layout.connections, kind === 'access' ? { from: desk, to: other, kind } : { from: a, to: b, kind }] };
}

export function withoutConnection(layout: CampusLayout, a: string, b: string): CampusLayout {
  const next = layout.connections.filter((c) => !samePair(c, a, b));
  return next.length === layout.connections.length ? layout : { ...layout, connections: next };
}

/** The lines whose two ends are both still on the campus — the only ones there is anything to draw. */
export function liveConnections(map: CampusMap, layout: CampusLayout): LayoutConnection[] {
  const seen = new Set<string>();
  const out: LayoutConnection[] = [];
  for (const c of layout.connections) {
    const key = [c.from, c.to].sort().join('\u0000');
    if (seen.has(key) || !anchorOf(map, c.from) || !anchorOf(map, c.to)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** One stable id for a line, in either direction: what the viewer selects and what the ⓧ chip removes. */
export const edgeId = (a: string, b: string): string => `edge:${[a, b].sort().join('|')}`;
export function edgeEnds(id: string): [string, string] | null {
  if (!id.startsWith('edge:')) return null;
  const [a, b] = id.slice(5).split('|');
  return a && b ? [a, b] : null;
}

/* ---- writing the note -------------------------------------------------------------------------------------- */

/** One node changed. An empty patch removes the override, which is how a thing goes back to where the template had it. */
export function withNode(layout: CampusLayout, id: string, patch: LayoutNode | null): CampusLayout {
  const nodes = { ...layout.nodes };
  if (patch === null) delete nodes[id];
  else nodes[id] = { ...nodes[id], ...patch };
  return { ...layout, nodes };
}

/** Take a thing off the campus, and every line that ran to it with it. */
export function removeNode(layout: CampusLayout, map: CampusMap, id: string): CampusLayout {
  const added = !!map.resources[id] && !map.desks[id];
  const nodes = { ...layout.nodes };
  // Something the owner added leaves no trace; something the template put there is marked away, or the template
  // would simply put it back on the next load.
  if (added) delete nodes[id]; else nodes[id] = { ...nodes[id], removed: true };
  return { ...layout, nodes, connections: layout.connections.filter((c) => c.from !== id && c.to !== id) };
}

/** The next free id of a kind: `note_1`, `note_2`, … counting what the note and the campus already hold. */
export function nextResourceId(layout: CampusLayout, kind: ResourceKind, tool?: StationFamily): string {
  if (kind === 'station' && tool) return `station_${tool}`;
  const prefix = kind === 'browser' ? 'browser' : kind;
  for (let n = 1; n < 1000; n++) { const id = `${prefix}_${n}`; if (!layout.nodes[id]) return id; }
  return `${prefix}_${Date.now()}`;
}

/** Which zone a point falls in, for a node the owner has just dropped. */
export const zoneIdAt = (map: CampusMap, at: Pt): string => zoneAt(map, at)?.id ?? '';

/** Everything the owner may pick up, in the order `pick` should try them. */
export const draggableIds = (map: CampusMap): string[] => [...Object.keys(map.resources), ...Object.keys(map.desks), ...map.props.map((p) => p.id)];

export { inRect };
