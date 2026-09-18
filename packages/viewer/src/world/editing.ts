/**
 * Every change the owner can make to the office, as one pure step each.
 *
 * A step takes the campus and the note as they are and hands back the note as it should be, plus the one sentence
 * the office says about it. Nothing here draws, nothing here talks to the daemon and nothing here holds a pointer:
 * `view.ts` decides *when* a step happens, this decides *what* it is, and both the click and the Org sheet's
 * accessible list go through the same one — so the two can never drift into meaning different things.
 *
 * The undo stack lives here too, for the same reason: twenty steps in memory, and a step is whatever one gesture
 * produced. `Edits.pending` is the one asymmetry — a node that has been *sent* but must not be *drawn* yet, which
 * is what "an agent becomes a fire proposal" means: the desk stays until the owner has decided, and the daemon's
 * next `layout.changed` is the thing that takes it away.
 */
import type { Pt, Rect } from './iso.js';
import type { CampusMap } from './campus.js';
import {
  type LayoutNode, type OfficeLayout, type ResourceKind, type ToolName, MIN_ZONE, RESOURCE_LABEL,
  TOOL_LABEL, anchorOf, connectionKind, emptyLayout, nextResourceId, occupiedBy, removeNode, resourceRect, snap,
  withConnection, withNode, withoutConnection,
} from './layout.js';

/** How many steps back the office remembers. In memory: an undo is about the last minute, not about last Tuesday. */
export const UNDO_MAX = 20;

/** What one step did: the note to send, and the one sentence to say about it. `null` is a step that changed nothing. */
export interface Step { layout: OfficeLayout; said: string; pending?: Record<string, LayoutNode> }

/** How to say who somebody is. The office knows a role id; the owner knows "the CTO". */
export type NameOf = (id: string) => string;

/* ------------------------------------------------------------------------------------------------------------ */
/* the steps                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/** A desk, a resource or a prop, moved. `to` is where its footprint's anchor lands, already snapped. */
export function moveThing(map: CampusMap, layout: OfficeLayout, id: string, to: Pt, nameOf: NameOf): Step | null {
  const a = anchorOf(map, id);
  if (!a || a.kind === 'zone') return null;
  const rect = rectAt(a.rect, a.kind === 'desk' ? { x: a.rect.x0, y: a.rect.y0 } : a.at, to);
  if (occupiedBy(map, rect, id)) return null;
  const at = a.kind === 'desk' ? { x: rect.x0, y: rect.y0 } : to;
  return { layout: withNode(layout, id, { x: snap(at.x), y: snap(at.y) }), said: movedLine(map, id, nameOf) };
}

/** What the office says about a thing that just moved. */
export function movedLine(map: CampusMap, id: string, nameOf: NameOf): string {
  if (map.desks[id]) return `Moved ${nameOf(id)}'s desk.`;
  const r = map.resources[id];
  if (r) return `Moved the ${r.label.toLowerCase()}.`;
  const z = map.zoneById[id];
  if (z) return `Moved ${z.label}.`;
  const p = map.props.find((q) => q.id === id);
  return p ? `Moved the ${p.kind}.` : 'Moved it.';
}

/** A footprint with its anchor put at `to`. */
function rectAt(rect: Rect, anchor: Pt, to: Pt): Rect {
  const dx = snap(to.x) - anchor.x, dy = snap(to.y) - anchor.y;
  return { x0: rect.x0 + dx, y0: rect.y0 + dy, x1: rect.x1 + dx, y1: rect.y1 + dy };
}

/**
 * A zone, moved — and every desk standing in it moved with it.
 *
 * The desks get their own overrides rather than being carried implicitly, so `Office/campus.md` says where each
 * desk is and an owner reading the note in Obsidian is not left to work it out from the zone's rectangle.
 */
export function moveZone(map: CampusMap, layout: OfficeLayout, id: string, to: Pt): Step | null {
  const z = map.zoneById[id];
  if (!z) return null;
  // A zone snaps its *delta* rather than its position, and everything in it is translated by that same delta. A
  // whole floor of desks jumping a tenth of a cell sideways because the template put the room at x 35.6 and the
  // grid is halves would be a worse answer than a room that keeps the arrangement it had.
  const dx = snap(to.x - z.rect.x0), dy = snap(to.y - z.rect.y0);
  if (dx === 0 && dy === 0) return null;
  let next = withNode(layout, id, { x: z.rect.x0 + dx, y: z.rect.y0 + dy });
  for (const d of Object.values(map.desks)) {
    if (d.zone !== id && d.room !== id) continue;
    next = withNode(next, d.id, { x: d.rect.x0 + dx, y: d.rect.y0 + dy });
  }
  return { layout: next, said: `Moved ${z.label}.` };
}

/** A zone, resized by one of its corner handles. The desks stay where they are: the room grew, they did not move. */
export function resizeZone(map: CampusMap, layout: OfficeLayout, id: string, rect: Rect): Step | null {
  const z = map.zoneById[id];
  if (!z) return null;
  const x0 = snap(Math.min(rect.x0, rect.x1)), y0 = snap(Math.min(rect.y0, rect.y1));
  const w = Math.max(MIN_ZONE, snap(Math.abs(rect.x1 - rect.x0))), d = Math.max(MIN_ZONE, snap(Math.abs(rect.y1 - rect.y0)));
  return { layout: withNode(layout, id, { x: x0, y: y0, w, d }), said: `Resized ${z.label}.` };
}

/** What the owner is adding, as the dock offers it. `agent` is the one that is not a node at all — it is a hire. */
export type DockKind = 'agent' | ResourceKind;

/** Something new, put down at a point on the floor. */
export function addResource(map: CampusMap, layout: OfficeLayout, kind: ResourceKind, at: Pt, extra: Partial<LayoutNode> = {}): (Step & { id: string }) | null {
  const to = { x: snap(at.x), y: snap(at.y) };
  if (occupiedBy(map, resourceRect(kind, to))) return null;
  const id = nextResourceId(layout, kind, extra.tool);
  const node: LayoutNode = { kind, x: to.x, y: to.y, ...extra };
  return { id, layout: withNode(layout, id, node), said: addedLine(kind, extra.tool) };
}

export function addedLine(kind: ResourceKind, tool?: ToolName): string {
  if (kind === 'station' && tool) return `${TOOL_LABEL[tool]} station added.`;
  return `${kind === 'note' ? 'Sticky note' : RESOURCE_LABEL[kind]} added.`;
}

/**
 * Something taken off the campus.
 *
 * A desk with somebody at it is the exception: letting the owner delete a colleague with the Delete key would be
 * the one irreversible thing in an office where everything else springs back. The note goes to the daemon, which
 * turns it into a fire proposal, and the desk stays on the campus until that proposal is decided.
 */
export function removeThing(map: CampusMap, layout: OfficeLayout, id: string, nameOf: NameOf): Step | null {
  const a = anchorOf(map, id);
  if (!a || a.kind === 'zone') return null;
  const next = removeNode(layout, map, id);
  if (map.desks[id]) return { layout, said: 'Fire proposed — approve it in Decisions.', pending: { [id]: { ...layout.nodes[id], removed: true } } };
  const r = map.resources[id];
  return { layout: next, said: r ? `Removed the ${r.label.toLowerCase()}.` : `Removed the ${a.label}.` };
}

/** Removing a line, said the same way whichever end the owner cut it from. */
export const REMOVED_CONNECTION = 'Removed the connection.';
/** What the office says when a thing cannot land where the pointer is. */
export const SPOT_TAKEN = 'That spot is taken.';

/** Two things wired together. */
export function connect(map: CampusMap, layout: OfficeLayout, a: string, b: string, nameOf: NameOf): Step | null {
  const kind = connectionKind(map, a, b);
  if (!kind) return null;
  const next = withConnection(layout, map, a, b);
  if (next === layout) return null;
  return { layout: next, said: connectedLine(map, a, b, kind, nameOf) };
}

export function connectedLine(map: CampusMap, a: string, b: string, kind: 'peer' | 'access', nameOf: NameOf): string {
  if (kind === 'peer') return `Connected ${nameOf(a)} and ${nameOf(b)} — they can message each other now.`;
  const desk = map.desks[a] ? a : b;
  const thing = desk === a ? b : a;
  return `${nameOf(desk)} can use the ${map.resources[thing]?.label.toLowerCase() ?? thing} now.`;
}

/** A line cut. One sentence, always the same: the owner already knows which line they clicked. */
export function disconnect(layout: OfficeLayout, a: string, b: string): Step | null {
  const next = withoutConnection(layout, a, b);
  return next === layout ? null : { layout: next, said: REMOVED_CONNECTION };
}

/** A thing nudged by the arrow keys: half a cell, in screen terms, on the isometric plane. */
export const NUDGE: Record<string, Pt> = {
  ArrowUp: { x: -0.5, y: -0.5 }, ArrowDown: { x: 0.5, y: 0.5 },
  ArrowLeft: { x: -0.5, y: 0.5 }, ArrowRight: { x: 0.5, y: -0.5 },
};

/* ------------------------------------------------------------------------------------------------------------ */
/* the stack                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The note as the office holds it: what is drawn, what has been sent, and the last twenty states to go back to.
 *
 * `apply` is a step the owner took — it pushes the old state and keeps it undoable. `accept` is the daemon
 * speaking, which is never undoable: it is not a step the owner took, it is what is true.
 */
export class Edits {
  layout: OfficeLayout;
  /** nodes sent to the daemon but deliberately not drawn yet (a fire proposal's desk) */
  pending: Record<string, LayoutNode> = {};
  private stack: OfficeLayout[] = [];

  constructor(layout: OfficeLayout = emptyLayout()) { this.layout = layout; }

  get canUndo(): boolean { return this.stack.length > 0; }

  /** Take a step. Returns what to send, which is the drawn note with anything still pending folded back in. */
  apply(step: Step): OfficeLayout {
    this.stack.push(this.layout);
    if (this.stack.length > UNDO_MAX) this.stack.shift();
    this.layout = step.layout;
    if (step.pending) this.pending = { ...this.pending, ...step.pending };
    return this.toSend();
  }

  /** What the daemon should be told the whole state is. */
  toSend(): OfficeLayout {
    return Object.keys(this.pending).length ? { ...this.layout, nodes: { ...this.layout.nodes, ...this.pending } } : this.layout;
  }

  /** The daemon's own word on the layout: it is the truth, so it clears what was in flight and is not undoable. */
  accept(layout: OfficeLayout): void { this.layout = layout; this.pending = {}; }

  /** Go back one step; null when there is nothing to go back to. */
  undo(): OfficeLayout | null {
    const prev = this.stack.pop();
    if (!prev) return null;
    this.layout = prev;
    this.pending = {};
    return this.toSend();
  }
}

export type { OfficeLayout, LayoutNode };
