/**
 * `Office/campus.md`, applied to the campus.
 *
 * The template campus (`config/world/office.json`) is the base and never changes. This file is what the owner did
 * on top of it: desks and zones they moved, props they took away, things they added, and the lines they drew
 * between them. One pure function turns the two into the campus the renderer draws, so "the office moved" and
 * "the note changed" are the same event arriving by two routes.
 *
 * ── LOCAL CONTRACT (SP9b step 3) ─────────────────────────────────────────────────────────────────────────────
 * `OfficeLayout`, `applyLayout` and the campus parser are the daemon's as much as the viewer's: one parser, or
 * the office and the note disagree the first time either is changed. They are defined here only until the core
 * agent's land, and at the merge this module keeps its helpers and re-exports the three from `@cubicle/core`:
 *
 *     import { type OfficeLayout, applyLayout, parseCampusMap } from '@cubicle/core';
 *
 * Everything below the `helpers` rule is the viewer's own and stays here.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
 */
import type { Rect } from './iso.js';
import { type AccentName, accentOfZone } from './materials.js';
import { type CampusMap, type Desk, type Pt, type PropItem, type Resource, type Zone, inRect, zoneAt } from './campus.js';

/* ============================================================================================================ */
/* the contract                                                                                                  */
/* ============================================================================================================ */

export const RESOURCE_KINDS = ['browser', 'doc', 'note', 'site', 'station'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const TOOLS = ['email', 'deploy', 'analytics', 'memory'] as const;
export type ToolName = (typeof TOOLS)[number];
export type ConnectionKind = 'peer' | 'access';

/** One entry of the note's `nodes:` map. Every field is optional: the note stores only what differs. */
export interface LayoutNode {
  /** a desk or zone's `x0,y0`; a prop or resource's own middle */
  x?: number; y?: number;
  /** a zone's size, in cells */
  w?: number; d?: number;
  /** set on a node the owner added; absent on one that only moved */
  kind?: ResourceKind;
  zone?: string; label?: string; body?: string; path?: string;
  tool?: ToolName;
  removed?: boolean;
}
export interface Connection { from: string; to: string; kind: ConnectionKind }
export interface OfficeLayout { version: 1; nodes: Record<string, LayoutNode>; connections: Connection[] }

export const emptyLayout = (): OfficeLayout => ({ version: 1, nodes: {}, connections: [] });

/** A layout off the wire, made safe to work with: anything that is not the shape above is dropped, never thrown. */
export function asLayout(raw: unknown): OfficeLayout {
  const o = (raw ?? {}) as Partial<OfficeLayout>;
  const nodes: Record<string, LayoutNode> = {};
  for (const [id, n] of Object.entries(o.nodes ?? {})) if (n && typeof n === 'object') nodes[id] = { ...(n as LayoutNode) };
  const connections: Connection[] = [];
  for (const c of Array.isArray(o.connections) ? o.connections : []) {
    if (!c || typeof c !== 'object') continue;
    const { from, to, kind } = c as Connection;
    if (typeof from === 'string' && typeof to === 'string' && (kind === 'peer' || kind === 'access')) connections.push({ from, to, kind });
  }
  return { version: 1, nodes, connections };
}

/**
 * How big each kind of thing the owner can add is, in cells.
 *
 * Fixed per kind rather than stored in the note: a sticky note the owner could stretch to the size of the Sales
 * floor is a drawing tool, and the office is not one. The note stores where a thing is; what it is decides the rest.
 */
export const RESOURCE_SIZE: Record<ResourceKind, { w: number; d: number }> = {
  browser: { w: 1.6, d: 1.0 },
  doc: { w: 1.8, d: 0.7 },
  note: { w: 1.0, d: 0.8 },
  site: { w: 2.0, d: 0.8 },
  station: { w: 1.4, d: 1.0 },
};
export const RESOURCE_LABEL: Record<ResourceKind, string> = { browser: 'Browser', doc: 'Document', note: 'Note', site: 'Site', station: 'Tool' };
export const TOOL_LABEL: Record<ToolName, string> = { email: 'Email', deploy: 'Deploy', analytics: 'Analytics', memory: 'Memory' };

/** The footprint a resource of this kind occupies, centred on `at`. */
export function resourceRect(kind: ResourceKind, at: Pt): Rect {
  const s = RESOURCE_SIZE[kind];
  return { x0: at.x - s.w / 2, y0: at.y - s.d / 2, x1: at.x + s.w / 2, y1: at.y + s.d / 2 };
}

/** No zone may be dragged smaller than this, in cells: below it the handles are on top of each other. */
export const MIN_ZONE = 3;

const shift = (r: Rect, dx: number, dy: number): Rect => ({ x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy });
const moved = (n: LayoutNode): boolean => n.x !== undefined || n.y !== undefined;

/**
 * The campus as the owner left it.
 *
 * Pure, and total: a node naming something that is not on the campus, a resource with no kind, a station with no
 * tool — each is skipped on its own and nothing else in the note is affected. The daemon is the authority on what
 * is a legal write (and says so in `layout.ack`); this is the same rule applied to what came back, so a viewer
 * that is handed a note it disagrees with still draws an office.
 */
export function applyLayout(map: CampusMap, layout: OfficeLayout | null | undefined): CampusMap {
  const nodes = layout?.nodes ?? {};
  if (!Object.keys(nodes).length) return map;

  const clear: Rect[] = [];
  const block: Rect[] = [];

  // ---- desks: moved by their own delta, seat and all; removed outright ----
  const desks: Record<string, Desk> = { ...map.desks };
  for (const [id, d] of Object.entries(map.desks)) {
    const n = nodes[id];
    if (!n) continue;
    if (n.removed) { delete desks[id]; clear.push(d.rect); continue; }
    if (!moved(n)) continue;
    const dx = (n.x ?? d.rect.x0) - d.rect.x0, dy = (n.y ?? d.rect.y0) - d.rect.y0;
    if (dx === 0 && dy === 0) continue;
    desks[id] = { ...d, rect: shift(d.rect, dx, dy), seat: { x: d.seat.x + dx, y: d.seat.y + dy } };
    clear.push(d.rect);
    block.push(desks[id].rect);
  }

  // ---- zones: moved and resized. A zone is floor, so it blocks nothing and clears nothing ----
  const zoneById: Record<string, Zone> = { ...map.zoneById };
  for (const z of map.zones) {
    const n = nodes[z.id];
    if (!n || (!moved(n) && n.w === undefined && n.d === undefined)) continue;
    const x0 = n.x ?? z.rect.x0, y0 = n.y ?? z.rect.y0;
    const w = Math.max(MIN_ZONE, n.w ?? z.rect.x1 - z.rect.x0);
    const d = Math.max(MIN_ZONE, n.d ?? z.rect.y1 - z.rect.y0);
    zoneById[z.id] = { ...z, rect: { x0, y0, x1: x0 + w, y1: y0 + d }, stand: { x: z.stand.x + (x0 - z.rect.x0), y: z.stand.y + (y0 - z.rect.y0) } };
  }
  const zones = map.zones.map((z) => zoneById[z.id]);
  const rail = map.rail.map((z) => zoneById[z.id]);

  // ---- props: the dressing the owner nudged or took away ----
  const props: PropItem[] = [];
  for (const p of map.props) {
    const n = nodes[p.id];
    if (n?.removed) { clear.push(p.rect); continue; }
    if (!n || !moved(n)) { props.push(p); continue; }
    const dx = (n.x ?? p.at.x) - p.at.x, dy = (n.y ?? p.at.y) - p.at.y;
    props.push({ ...p, at: { x: p.at.x + dx, y: p.at.y + dy }, rect: shift(p.rect, dx, dy) });
  }

  // ---- what the owner added ----
  const zoned = { zones };
  const resources: Record<string, Resource> = {};
  for (const [id, n] of Object.entries(nodes)) {
    if (map.desks[id] || map.zoneById[id] || n.removed) continue;
    if (map.props.some((p) => p.id === id)) continue;
    const kind = n.kind;
    if (!kind || !(RESOURCE_KINDS as readonly string[]).includes(kind)) continue;
    if (n.x === undefined || n.y === undefined) continue;
    if (kind === 'station' && !(n.tool && (TOOLS as readonly string[]).includes(n.tool))) continue;
    const at = { x: n.x, y: n.y };
    const rect = resourceRect(kind, at);
    const zone = n.zone ?? zoneAt(zoned, at)?.id ?? '';
    resources[id] = {
      id, kind, at, rect, zone, accent: accentOfZone(zone),
      label: labelOfNode(kind, n),
      ...(kind === 'station' && n.tool ? { tool: n.tool } : {}),
      ...(n.path ? { path: n.path } : {}),
      ...(n.body ? { body: n.body } : {}),
    };
    block.push(rect);
  }

  const grid = clear.length || block.length ? stampGrid(map, clear, block) : map.grid;
  return { ...map, desks, zones, zoneById, rail, props, resources, grid };
}

/** What a thing the owner added is called, when the note does not say. */
export function labelOfNode(kind: ResourceKind, n: Pick<LayoutNode, 'label' | 'path' | 'body' | 'tool'>): string {
  if (n.label) return n.label;
  if (kind === 'station' && n.tool) return TOOL_LABEL[n.tool];
  if (kind === 'doc' && n.path) return n.path.split('/').pop()!.replace(/\.md$/, '');
  if (kind === 'note' && n.body) { const line = n.body.split('\n').find((l) => l.trim()) ?? ''; return line.length > 28 ? `${line.slice(0, 27)}…` : line || RESOURCE_LABEL.note; }
  return RESOURCE_LABEL[kind];
}

/**
 * The walk grid with the footprints that went away cleared and the ones that arrived blocked.
 *
 * Routing is the one thing a moved desk changes that nothing else would notice: without this an agent walks
 * straight through the kiosk the owner has just put in front of them, and the office reads as a diagram again.
 * Clears run first, so a desk that moved one cell does not unblock the cell it moved onto.
 */
function stampGrid(map: CampusMap, clear: Rect[], block: Rect[]): number[][] {
  const g = map.grid.map((row) => row.slice());
  const paint = (r: Rect, v: number): void => {
    const x0 = Math.max(0, Math.floor(r.x0 * map.walk)), x1 = Math.ceil(r.x1 * map.walk);
    const y0 = Math.max(0, Math.floor(r.y0 * map.walk)), y1 = Math.ceil(r.y1 * map.walk);
    for (let y = y0; y < y1; y++) { const row = g[y]; if (!row) continue; for (let x = x0; x < x1; x++) if (row[x] !== undefined) row[x] = v; }
  };
  for (const r of clear) paint(r, 0);
  for (const r of block) paint(r, 1);
  return g;
}

/* ============================================================================================================ */
/* helpers — the viewer's own, and they stay here after the merge                                                 */
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

const samePair = (c: Connection, a: string, b: string): boolean => (c.from === a && c.to === b) || (c.from === b && c.to === a);

/** Are these two wired together? Either direction: a connection is a line, not an arrow. */
export function connected(layout: OfficeLayout, a: string, b: string): boolean {
  return layout.connections.some((c) => samePair(c, a, b));
}

/**
 * What a line between these two would mean, or null where there is no such line to draw.
 *
 * desk ↔ desk is `peer` — they may message each other. desk → resource is `access` — that agent may use it.
 * Resource to resource is nothing: a kiosk has nobody to talk to.
 */
export function connectionKind(map: CampusMap, a: string, b: string): ConnectionKind | null {
  if (a === b) return null;
  const A = anchorOf(map, a), B = anchorOf(map, b);
  if (!A || !B) return null;
  if (A.kind === 'desk' && B.kind === 'desk') return 'peer';
  if (A.kind === 'desk' && B.kind === 'resource') return 'access';
  if (A.kind === 'resource' && B.kind === 'desk') return 'access';
  return null;
}

/** Add a line, in the shape the daemon stores it: a desk is always the `from` of an `access`. */
export function withConnection(layout: OfficeLayout, map: CampusMap, a: string, b: string): OfficeLayout {
  const kind = connectionKind(map, a, b);
  if (!kind || connected(layout, a, b)) return layout;
  const desk = map.desks[a] ? a : b;
  const other = desk === a ? b : a;
  return { ...layout, connections: [...layout.connections, kind === 'access' ? { from: desk, to: other, kind } : { from: a, to: b, kind }] };
}

export function withoutConnection(layout: OfficeLayout, a: string, b: string): OfficeLayout {
  const next = layout.connections.filter((c) => !samePair(c, a, b));
  return next.length === layout.connections.length ? layout : { ...layout, connections: next };
}

/** The lines whose two ends are both still on the campus — the only ones there is anything to draw. */
export function liveConnections(map: CampusMap, layout: OfficeLayout): Connection[] {
  const seen = new Set<string>();
  const out: Connection[] = [];
  for (const c of layout.connections) {
    const key = [c.from, c.to].sort().join(' ');
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
export function withNode(layout: OfficeLayout, id: string, patch: LayoutNode | null): OfficeLayout {
  const nodes = { ...layout.nodes };
  if (patch === null) delete nodes[id];
  else nodes[id] = { ...nodes[id], ...patch };
  return { ...layout, nodes };
}

/** Take a thing off the campus, and every line that ran to it with it. */
export function removeNode(layout: OfficeLayout, map: CampusMap, id: string): OfficeLayout {
  const added = !!map.resources[id] && !map.desks[id];
  const nodes = { ...layout.nodes };
  // Something the owner added leaves no trace; something the template put there is marked away, or the template
  // would simply put it back on the next load.
  if (added) delete nodes[id]; else nodes[id] = { ...nodes[id], removed: true };
  return { ...layout, nodes, connections: layout.connections.filter((c) => c.from !== id && c.to !== id) };
}

/** The next free id of a kind: `note_1`, `note_2`, … counting what the note and the campus already hold. */
export function nextResourceId(layout: OfficeLayout, kind: ResourceKind, tool?: ToolName): string {
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
