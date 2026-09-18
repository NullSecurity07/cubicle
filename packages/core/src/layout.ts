/**
 * `Office/campus.md` — the office as the owner left it.
 *
 * One note holds the whole of it: the frontmatter is the data (what moved, what was added, what is wired to
 * what) and the body is a sentence-case summary of the same thing, so the owner can read their office in
 * Obsidian without reading yaml. Editing the note moves the office; dragging in the office rewrites the note.
 *
 * The template campus (`config/world/office.json`) stays the base. This note stores only what differs from it,
 * which is why a fresh vault's note has no node overrides at all and the office still looks exactly as shipped.
 *
 * **A connection is a permission.** `peer` between two desks means those two roles may send each other a
 * `colleague.message`; `access` from a desk to a resource means that role may use it. Both gates live in the
 * daemon and the tools; everything here is the reading, the writing and the rules that keep the note honest.
 *
 * Ids: a desk node is keyed by its **desk id**, and a desk id is a role id for every charter the template
 * ships (`RoleFrontmatter.desk`). A hire takes a free member desk whose id is not its role id, so anything the
 * owner or the office writes as a role id is canonicalised to the desk it sits at — `deskOf` — before it is
 * stored. The pure half of all this (the types, `applyLayout`, `connected`, `stationFor`) is in `campus-map.ts`,
 * which the viewer bundles; what is here needs zod, yaml and the vault, and never reaches the browser.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  applyLayout, connected, inRect, isStationId, paintRect, parseCampusMap, resourceRect, stationFor, stationId,
  MIN_ZONE, RESOURCE_KINDS, STATION_FAMILIES, STATION_SCREEN,
  type CampusLayout, type CampusMap, type LayoutConnection, type LayoutNode, type Rect, type ResourceKind,
} from './campus-map.js';
import { parseNote, stringifyNote } from './frontmatter.js';
import type { Vault } from './vault.js';
import { type Org, leadOf, isLead, officeHolder } from './org.js';

export const OFFICE_LAYOUT_PATH = 'Office/campus.md';

/* -------------------------------------------------------------------------------------------------------- */
/* schema                                                                                                    */
/* -------------------------------------------------------------------------------------------------------- */

const coord = z.number().refine((v) => Number.isFinite(v), 'must be a number');

export const LayoutNodeSchema = z.object({
  kind: z.enum(RESOURCE_KINDS as [ResourceKind, ...ResourceKind[]]).optional(),
  x: coord.optional(), y: coord.optional(),
  w: coord.optional(), d: coord.optional(),
  zone: z.string().optional(),
  label: z.string().optional(),
  body: z.string().optional(),
  path: z.string().optional(),
  tool: z.string().optional(),
  removed: z.boolean().optional(),
});

export const LayoutConnectionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(['peer', 'access']),
});

/** The note's frontmatter, exactly as the spec writes it. */
export const OfficeLayout = z.object({
  version: z.number().int().default(1),
  nodes: z.record(z.string(), LayoutNodeSchema).default({}),
  connections: z.array(LayoutConnectionSchema).default([]),
});
export type OfficeLayout = z.infer<typeof OfficeLayout>;

// The schema and the browser-side type are one shape; if they ever part, this stops compiling.
const _shapesAgree: CampusLayout = OfficeLayout.parse({});
void _shapesAgree;

/** An entry the daemon would not apply, and why. One line, never the whole file. */
export interface DroppedEntry { line: string; reason: string }

/* -------------------------------------------------------------------------------------------------------- */
/* the campus map, daemon side                                                                               */
/* -------------------------------------------------------------------------------------------------------- */

let cachedMap: CampusMap | null = null;

/**
 * The template campus the generator writes, parsed once per process.
 *
 * The repo root is resolved here rather than taken from `template.ts`: `scaffoldVault` writes the note, so
 * importing `repoRoot` from there and being imported back by it is a cycle, and a cycle in a module that both
 * sides load at start is the kind of thing that only breaks in the bundle.
 */
export function loadCampusMap(): CampusMap {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  if (!cachedMap) cachedMap = parseCampusMap(JSON.parse(readFileSync(path.join(root, 'config', 'world', 'office.json'), 'utf8')));
  return cachedMap;
}

/** The desk a role sits at: its charter's, else the id itself (a template role's desk id is its role id). */
export function deskOf(org: Org, role: string): string {
  return org.roles[role]?.desk || role;
}

/** Who sits at a desk, by desk id. */
export function roleAtDesk(org: Org, desk: string): string | null {
  if (org.roles[desk]) return desk;
  return Object.values(org.roles).find((r) => r.desk === desk)?.role ?? null;
}

/* -------------------------------------------------------------------------------------------------------- */
/* validation                                                                                                */
/* -------------------------------------------------------------------------------------------------------- */

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Is every walk sub-cell this rectangle covers free in `grid`? */
function rectFree(grid: number[][], walk: number, r: Rect): boolean {
  const gh = grid.length, gw = grid[0]?.length ?? 0;
  const x0 = Math.max(0, Math.floor(r.x0 * walk)), x1 = Math.min(gw - 1, Math.floor(r.x1 * walk - 1e-6));
  const y0 = Math.max(0, Math.floor(r.y0 * walk)), y1 = Math.min(gh - 1, Math.floor(r.y1 * walk - 1e-6));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (grid[y][x]) return false;
  return true;
}

const within = (m: CampusMap, r: Rect): boolean => r.x0 >= 0 && r.y0 >= 0 && r.x1 <= m.width && r.y1 <= m.height;

/**
 * The one gate every write goes through, whether it came from the office or from a save in Obsidian.
 *
 * Takes anything — the wire's `layout.set` payload, the note's frontmatter — and returns a layout the daemon
 * can write plus the lines it would not apply. A bad line never costs the owner the rest of the file: the spec
 * is explicit that an invalid entry is dropped with a warning naming it, and that is the whole contract here.
 *
 * What it enforces, in the spec's order: ids exist (a desk id is a desk or the role sitting at one, a zone id
 * is a zone, a prop id is a prop, a resource id is `kind_n` or `station_<family>`); a position is inside the
 * campus and not on a blocked cell or on another desk; a desk keeps the size the campus gave it; a connection's
 * ends exist and differ; `peer` is desk↔desk and `access` is desk→resource; and no pair is wired twice.
 */
export function validateLayout(map: CampusMap, org: Org, input: unknown): { layout: CampusLayout; dropped: DroppedEntry[] } {
  const dropped: DroppedEntry[] = [];
  const raw = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const version = typeof raw.version === 'number' && Number.isInteger(raw.version) ? raw.version : 1;
  const rawNodes = (raw.nodes && typeof raw.nodes === 'object' && !Array.isArray(raw.nodes) ? raw.nodes : {}) as Record<string, unknown>;
  const rawConns = Array.isArray(raw.connections) ? raw.connections : [];

  const propIds = new Set(map.props.map((p) => p.id));
  /** The floor each accepted resource takes, so the note cannot stack two of them on one spot. */
  const taken: number[][] = map.grid.map((row) => row.map(() => 0));
  const nodes: Record<string, LayoutNode> = {};
  /** Desk placements that passed everything but the collision check, which needs all of them at once. */
  const placing: { id: string; line: string; rect: Rect }[] = [];

  for (const [rawId, value] of Object.entries(rawNodes)) {
    const id = map.desks[rawId] ? rawId : deskOf(org, rawId);
    const line = `nodes.${rawId}`;
    const parsed = LayoutNodeSchema.safeParse(value);
    if (!parsed.success) {
      dropped.push({ line, reason: parsed.error.issues.map((i) => `${i.path.join('.') || 'value'} ${i.message.toLowerCase()}`).join('; ') });
      continue;
    }
    const n = parsed.data;
    const desk = map.desks[id], zone = map.zoneById[id], prop = propIds.has(id);
    const isResource = !desk && !zone && !prop;
    if (isResource && !n.kind) { dropped.push({ line, reason: `no desk, zone or prop called ${rawId}` }); continue; }
    if (isResource && !resourceIdOk(id, n.kind!)) { dropped.push({ line, reason: `a ${n.kind} is called ${n.kind}_1, ${n.kind}_2 …` }); continue; }
    if (isResource && n.kind === 'station') {
      const family = STATION_FAMILIES.find((f) => stationId(f) === id);
      if (n.tool && n.tool !== family) { dropped.push({ line, reason: `station ${id} is the ${family} station, not ${n.tool}` }); continue; }
      n.tool = family;
    }
    if (n.removed) { nodes[id] = { removed: true }; continue; }

    const moved = n.x !== undefined || n.y !== undefined;
    if (moved && (n.x === undefined || n.y === undefined)) { dropped.push({ line, reason: 'a move needs both x and y' }); continue; }
    if (isResource && !moved) { dropped.push({ line, reason: 'a resource needs x and y' }); continue; }
    if (!moved && !zone) { dropped.push({ line, reason: 'nothing to change' }); continue; }

    if (desk) {
      if (n.w !== undefined || n.d !== undefined) dropped.push({ line, reason: 'a desk keeps the size the campus gave it' });
      const w = desk.rect.x1 - desk.rect.x0, d = desk.rect.y1 - desk.rect.y0;
      const rect: Rect = { x0: n.x!, y0: n.y!, x1: n.x! + w, y1: n.y! + d };
      if (!within(map, rect)) { dropped.push({ line, reason: 'that spot is off the campus' }); continue; }
      placing.push({ id, line, rect });
      continue;
    }
    if (zone) {
      const w = n.w ?? zone.rect.x1 - zone.rect.x0, d = n.d ?? zone.rect.y1 - zone.rect.y0;
      if (w < MIN_ZONE || d < MIN_ZONE) { dropped.push({ line, reason: `a zone is at least ${MIN_ZONE} cells across` }); continue; }
      if (!moved && n.w === undefined && n.d === undefined) { dropped.push({ line, reason: 'nothing to change' }); continue; }
      const x0 = n.x ?? zone.rect.x0, y0 = n.y ?? zone.rect.y0;
      if (!within(map, { x0, y0, x1: x0 + w, y1: y0 + d })) { dropped.push({ line, reason: 'that spot is off the campus' }); continue; }
      nodes[id] = { ...(moved ? { x: x0, y: y0 } : {}), ...(n.w !== undefined ? { w } : {}), ...(n.d !== undefined ? { d } : {}) };
      continue;
    }
    // a prop or a resource: one thing, and it has to stand on free floor. A resource is measured by the footprint
    // its kind has (`resourceRect`) rather than a nominal half-cell, so the office and the daemon refuse the same
    // drops — a kiosk that fits in the office's ghost and is then rejected here is the two-parsers bug again.
    const at: Rect = n.kind ? resourceRect(n.kind, { x: n.x!, y: n.y! }) : { x0: n.x!, y0: n.y!, x1: n.x! + 0.5, y1: n.y! + 0.5 };
    if (!within(map, at)) { dropped.push({ line, reason: 'that spot is off the campus' }); continue; }
    if (!rectFree(map.grid, map.walk, at) || !rectFree(taken, map.walk, at)) { dropped.push({ line, reason: 'that spot is taken' }); continue; }
    // Each thing takes the floor it stands on as it is accepted, so two kiosks written onto the same cells in one
    // note is the second one refused rather than both of them standing inside each other.
    if (n.kind) paintRect(taken, map.walk, at, 1);
    nodes[id] = prop ? { x: n.x, y: n.y } : {
      kind: n.kind, x: n.x, y: n.y,
      ...(n.zone && map.zoneById[n.zone] ? { zone: n.zone } : {}),
      ...(n.label ? { label: n.label } : {}),
      ...(n.body ? { body: n.body } : {}),
      ...(n.path ? { path: n.path } : {}),
      ...(n.tool ? { tool: n.tool } : {}),
    };
  }

  // The desks, all at once: every desk that is moving or going leaves its old footprint first, so a rearrangement
  // in which two desks swap places is not refused because each was standing where the other wants to be. What is
  // left blocked is the office itself — walls, partitions, the desks that did not move — and each accepted desk is
  // painted back as it lands, which is what catches two of them dropped on the same cells in one write.
  const grid = map.grid.map((row) => row.slice());
  for (const { id } of placing) paintRect(grid, map.walk, map.desks[id].rect, 0);
  for (const [id, n] of Object.entries(nodes)) if (n.removed && map.desks[id]) paintRect(grid, map.walk, map.desks[id].rect, 0);
  for (const { id, line, rect } of placing) {
    if (!rectFree(grid, map.walk, rect)) { dropped.push({ line, reason: 'that spot is taken' }); paintRect(grid, map.walk, map.desks[id].rect, 1); continue; }
    paintRect(grid, map.walk, rect, 1);
    nodes[id] = { x: rect.x0, y: rect.y0 };
  }

  const isDesk = (id: string): boolean => !!map.desks[id] && !nodes[id]?.removed;
  const isResourceNode = (id: string): boolean => !!nodes[id]?.kind;
  const connections: LayoutConnection[] = [];
  const seen = new Set<string>();
  for (const value of rawConns) {
    const parsed = LayoutConnectionSchema.safeParse(value);
    if (!parsed.success) {
      dropped.push({ line: 'connections', reason: 'a connection needs from, to and kind (peer or access)' });
      continue;
    }
    let { from, to } = parsed.data;
    const { kind } = parsed.data;
    from = map.desks[from] ? from : deskOf(org, from);
    to = map.desks[to] ? to : deskOf(org, to);
    const line = `connections: ${from} → ${to}`;
    if (from === to) { dropped.push({ line, reason: 'a connection needs two different ends' }); continue; }
    if (kind === 'peer') {
      if (!isDesk(from) || !isDesk(to)) { dropped.push({ line, reason: 'a peer connection runs between two desks' }); continue; }
    } else {
      // access runs desk → resource; written the other way round it means the same thing, so turn it round
      if (isResourceNode(from) && isDesk(to)) { const t = from; from = to; to = t; }
      if (!isDesk(from)) { dropped.push({ line, reason: `no desk called ${from}` }); continue; }
      if (!isResourceNode(to)) { dropped.push({ line, reason: `nothing called ${to} on the campus` }); continue; }
    }
    const key = pairKey(from, to);
    if (seen.has(key)) { dropped.push({ line, reason: 'those two are connected already' }); continue; }
    seen.add(key);
    connections.push({ from, to, kind });
  }

  return { layout: { version, nodes, connections }, dropped };
}

function resourceIdOk(id: string, kind: ResourceKind): boolean {
  if (kind === 'station') return isStationId(id);
  return new RegExp(`^${kind}_\\d+$`).test(id);
}

/* -------------------------------------------------------------------------------------------------------- */
/* what the org already implies                                                                              */
/* -------------------------------------------------------------------------------------------------------- */

/**
 * The wiring the company already has, so day one looks and behaves exactly as it did before there was a note to
 * cut: everyone in a room is connected to everyone else in it, every reporting line is a connection, the chief
 * executive is connected to every lead, and every charter is connected to the station of each tool family its
 * charter lists.
 *
 * Three rules, and each of them is something the company could do the day before the note existed:
 *  - **a room is a room.** `can(org, …, 'schedule')` already lets a member hand work to a team-mate, so wiring
 *    only lead↔member would have refused a handoff the company made yesterday — the migration must take nothing
 *    away. It is the denser rule (a room of six is fifteen lines) and it is the honest one.
 *  - **reporting lines**, not team membership alone: a room's lead is not a member of the division above it (the
 *    v2 stopgap took those out), so nothing else would connect the CTO to the dev manager.
 *  - **the chief executive answers to the owner and to everyone**, so every lead has a line to that desk.
 */
export function impliedConnections(org: Org): LayoutConnection[] {
  const out: LayoutConnection[] = [];
  const seen = new Set<string>();
  const add = (a: string, b: string, kind: LayoutConnection['kind']): void => {
    if (!a || !b || a === b) return;
    const key = pairKey(a, b);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ from: a, to: b, kind });
  };
  const chief = officeHolder(org, 'chief_executive');
  for (const role of Object.keys(org.roles)) {
    const lead = leadOf(org, role);
    if (lead && lead !== 'owner' && org.roles[lead]) add(deskOf(org, lead), deskOf(org, role), 'peer');
    if (isLead(org, role) && org.roles[chief]) add(deskOf(org, chief), deskOf(org, role), 'peer');
  }
  for (const t of Object.values(org.teams)) {
    const room = [t.lead, ...t.members].filter((r) => org.roles[r]);
    for (let i = 0; i < room.length; i++) for (let j = i + 1; j < room.length; j++) add(deskOf(org, room[i]), deskOf(org, room[j]), 'peer');
  }
  for (const r of Object.values(org.roles)) {
    for (const tool of r.tools) {
      const family = stationFor(tool);
      if (family) add(deskOf(org, r.role), stationId(family), 'access');
    }
  }
  return out;
}

/**
 * The layout a vault gets when it has never had one: no node overrides, the org's own wiring, and the five
 * stations standing beside the screen each belongs to — the browser by the workshop, email by the post office,
 * deploys by the terminal, analytics by the newsstand, memory by the vault. Only stations some charter can
 * actually use are placed, so a company with nobody who sends email has no email station to cut.
 */
export function migrationLayout(map: CampusMap, org: Org): CampusLayout {
  const connections = impliedConnections(org);
  const wanted = new Set(connections.filter((c) => c.kind === 'access').map((c) => c.to));
  const nodes: Record<string, LayoutNode> = {};
  for (const family of STATION_FAMILIES) {
    const id = stationId(family);
    if (!wanted.has(id)) continue;
    const screen = map.screens[STATION_SCREEN[family]];
    const at = stationSpot(map, screen ? screen.stand : map.door);
    nodes[id] = { kind: 'station', tool: family, x: at.x, y: at.y, ...(zoneOf(map, at) ? { zone: zoneOf(map, at)! } : {}) };
  }
  return { version: 1, nodes, connections: connections.filter((c) => c.kind === 'peer' || nodes[c.to]) };
}

const zoneOf = (map: CampusMap, p: { x: number; y: number }): string | null => map.zones.find((z) => inRect(z.rect, p))?.id ?? null;

/**
 * A free spot beside a screen's standing spot, searched outwards so a station never lands inside furniture.
 *
 * Measured by the floor a station actually takes, centred on the spot, which is what `applyLayout` draws and what
 * `validateLayout` checks: a migration that placed a station the daemon then refused would empty the office on
 * the first read of its own note.
 */
function stationSpot(map: CampusMap, near: { x: number; y: number }): { x: number; y: number } {
  const free = (x: number, y: number): boolean => {
    const r = resourceRect('station', { x, y });
    return within(map, r) && rectFree(map.grid, map.walk, r);
  };
  for (let r = 0; r <= 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = Math.round((near.x + dx * 0.5) * 2) / 2, y = Math.round((near.y + dy * 0.5) * 2) / 2;
        if (free(x, y)) return { x, y };
      }
    }
  }
  return { x: near.x, y: near.y };
}

/* -------------------------------------------------------------------------------------------------------- */
/* the note                                                                                                  */
/* -------------------------------------------------------------------------------------------------------- */

/** The note as it stands, validated against the campus and the org. `null` when there is no note yet. */
export function readLayout(vault: Vault, map: CampusMap, org: Org): { layout: CampusLayout; dropped: DroppedEntry[] } | null {
  const text = vault.readTextOrNull(OFFICE_LAYOUT_PATH);
  if (text === null) return null;
  return validateLayout(map, org, parseNote(text).data);
}

/** The note, as markdown. Exposed so a caller can tell whether writing it would change anything. */
export function layoutMarkdown(layout: CampusLayout, org?: Org): string {
  return stringifyNote({ version: layout.version, nodes: layout.nodes, connections: layout.connections }, layoutBody(layout, org));
}

/** Write the note: frontmatter is the data, the body is written from it. Returns the markdown written. */
export function writeLayout(vault: Vault, layout: CampusLayout, by: string, org?: Org): string {
  const text = layoutMarkdown(layout, org);
  vault.writeText(OFFICE_LAYOUT_PATH, text, by, { generated: true });
  return text;
}

const sentence = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** What a role is called on screen, from its charter; the id when there is no charter for it. */
function nameOf(org: Org | undefined, desk: string): string {
  if (!org) return desk;
  const role = roleAtDesk(org, desk);
  return (role && org.roles[role]?.display) || desk;
}

const CAN_USE: Record<string, string> = {
  station_browser: 'browse the web', station_email: 'send email', station_deploy: 'deploy the site',
  station_analytics: 'read the analytics', station_memory: "use the company's memory",
};

/**
 * The body of the note: who can message whom, and who can use what — the two things a connection means,
 * in sentences, in the order the owner would read them.
 */
export function layoutBody(layout: CampusLayout, org?: Org): string {
  const peers = layout.connections.filter((c) => c.kind === 'peer');
  const access = layout.connections.filter((c) => c.kind === 'access');
  const moved = Object.entries(layout.nodes).filter(([, n]) => !n.kind && !n.removed);
  const added = Object.entries(layout.nodes).filter(([, n]) => n.kind);
  const removed = Object.entries(layout.nodes).filter(([, n]) => n.removed);
  const out: string[] = [
    '# The office',
    '',
    'This note is the office. Drag a desk, a zone or a connection in the viewer and the line appears here; edit a',
    'line here and the office moves. The frontmatter is the data — everything below is written from it, so an edit',
    'down here is overwritten on the next save.',
    '',
    '## Who can message whom',
    '',
  ];
  out.push(peers.length
    ? peers.map((c) => `- ${sentence(nameOf(org, c.from))} and ${nameOf(org, c.to)} can message each other.`).join('\n')
    : '- Nobody is connected to anybody, so no colleague can message another.');
  out.push('', '## Who can use what', '');
  out.push(access.length
    ? access.map((c) => `- ${sentence(nameOf(org, c.from))} can ${CAN_USE[c.to] ?? `use ${layout.nodes[c.to]?.label || c.to}`}.`).join('\n')
    : '- Nothing on the campus is wired to a desk.');
  if (added.length) {
    out.push('', '## On the floor', '');
    out.push(added.map(([id, n]) => `- ${sentence(n.label || describeResource(id, n))} stands at ${n.x}, ${n.y}.`).join('\n'));
  }
  if (moved.length) {
    out.push('', '## Moved', '');
    out.push(moved.map(([id, n]) => `- ${sentence(nameOf(org, id))}${n.x === undefined ? ' was resized' : ` is at ${n.x}, ${n.y}`}.`).join('\n'));
  }
  if (removed.length) {
    out.push('', '## Taken out', '');
    out.push(removed.map(([id]) => `- ${sentence(nameOf(org, id))}.`).join('\n'));
  }
  return out.join('\n') + '\n';
}

const describeResource = (id: string, n: LayoutNode): string => {
  if (n.kind === 'station') return `the ${n.tool} station`;
  if (n.kind === 'doc') return `the board showing ${n.path || id}`;
  if (n.kind === 'note') return 'a sticky note';
  if (n.kind === 'site') return 'the site screen';
  return `a ${n.kind}`;
};
