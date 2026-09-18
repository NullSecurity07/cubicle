/**
 * The office viewer.
 *
 * One canvas, one camera, one render loop. There is no game engine under this any more: the campus is soft flat
 * vector art, and a WebGL sprite pipeline has nothing to offer a picture made of gradients and rounded polygons —
 * it only stands between the art and the device pixel it is drawn on.
 *
 * How a frame is paid for:
 *
 *  - **the furniture is cached, one bitmap per object.** A desk is the same picture from one frame to the next
 *    until the camera's zoom or the hour changes, so it is drawn once into a small canvas at device pixel ratio
 *    and blitted after that. Two hundred `drawImage` calls in depth order cost about a millisecond; two hundred
 *    objects' worth of gradients cost twenty, and at the campus overview nothing is off screen to save you.
 *  - **a zoom invalidates the cache, and the rebuild is budgeted.** A handful of objects are re-rendered per frame
 *    while the rest are blitted scaled, so a zoom tween stays at frame rate and the picture is sharp again a few
 *    frames after it lands. A pan invalidates nothing at all, which is the common case.
 *  - **people are drawn live.** They move every frame, so there is nothing to cache; they are interleaved with the
 *    furniture by the same `x + y` depth key, which is what lets someone walk behind a partition.
 */
import { type Cell, type Pt, type Rect, type View, PERSON_H, quad } from './iso.js';
import { ACCENT, type AccentName, type Light, MATERIAL as M, divisionChip, lampStrength, lightAt, rgba, zoneChip } from './materials.js';
import { type G, PLATES, hull, plate } from './shapes.js';
import type { Drawable } from './props.js';
import {
  type CampusMap, type Router, type Seat, inRect, makeRouter, parseCampus, railZoneAt, rectOf, standAt, zoneAt,
} from './campus.js';
import { Camera, CHROME, ROOM_ZOOM, fitZoom, nameLabelVisible, worldTextVisible } from './camera.js';
import { type ScreenContent, buildProps, buildScreens, campusClip, deskDrawables, paintGround, paintHour, paintZonePlates, propDrawables, slabOf } from './paint.js';
import { Body, type BodyContext } from './people.js';
import { drawMinimap } from './minimap-draw.js';
import {
  type Anchor, type LayoutNode, type NodeKind, type CampusLayout, type ResourceKind, type StationFamily, anchorOf,
  applyLayout, connectionKind, edgeEnds, edgeId, emptyLayout, liveConnections, occupiedBy, resourceRect,
} from './layout.js';
import {
  type DockKind, type Step, Edits, NUDGE, SPOT_TAKEN, addResource, connect as connectStep,
  disconnect as disconnectStep, moveThing, moveZone, removeThing, resizeZone,
} from './editing.js';
import {
  type Pulse, PORT_HIT, PULSE_MS, drawCutChip, drawEdge, drawHandle, drawPort, drawPulse, drawRubberBand,
  drawTargetGlow, edgeCurve, edgeHit, pointOn, portAt, pulseT, shouldPulse,
} from './edges.js';
import { RESOURCE_H, drawGhost, drawLiftShadow, resourceProp } from './resources.js';
import { MOTION, motionOff } from './motion.js';
import type { State } from '../state.js';

export interface ViewHooks {
  getState(): State;
  /** stream id → data URL (live) or `/screens/` URL (replay) */
  frames(): Record<string, string>;
  hour(): number;
  /** wall clock live, event clock in replay (bubbles expire against it) */
  clock(): number;
  onSurfaceClick(kind: string): void;
  onAgentClick(role: string): void;
  /** the camera moved into another zone (the zone rail highlights it) */
  onZoneChange?(id: string): void;
  /**
   * The owner changed the office. The whole note goes over, every time: `layout.set` is idempotent by contract, and
   * a viewer that sent diffs would have to agree with the daemon about what it had already sent.
   */
  onLayoutChange?(layout: CampusLayout): void;
  /** One sentence about what just happened, for the toast. */
  say?(text: string): void;
  /** What is selected now, for the plate that hangs beside it; null when nothing is. */
  onSelect?(sel: Selection | null): void;
  /** The owner dropped an Agent on the floor: a hire, at this spot. */
  onHire?(at: Cell): void;
  /** How the owner would say who this is — a role id is not a name. */
  nameOf?(id: string): string;
}

/** What the owner has picked, as the HTML plate beside it needs to read it. */
export interface Selection {
  id: string;
  kind: NodeKind | 'edge';
  label: string;
  sub: string;
  actions: ('connect' | 'rename' | 'remove')[];
  /** where the plate hangs, in canvas pixels */
  at: Pt;
}

/** What the office has under a screen point. `agent`, `screen` and `zone` are what they always were. */
export type Hit =
  | { kind: 'agent' | 'screen' | 'zone' | 'zonePlate' | 'port' | 'cut'; id: string }
  | { kind: 'handle'; id: string; corner: number }
  | { kind: 'thing'; id: string; node: NodeKind }
  | { kind: 'edge'; id: string; a: string; b: string };

/** What the owner is carrying: a thing lifted off the floor, or a zone being moved or stretched. */
type Drag =
  | { kind: 'camera' }
  | { kind: 'thing'; id: string; node: NodeKind; grab: Cell }
  | { kind: 'zone'; id: string; grab: Cell }
  | { kind: 'handle'; id: string; corner: number }
  | { kind: 'wire'; from: string };

/** A thing in the air: where it would land, whether it may, and the drawables to paint there. */
interface Lift { id: string; node: NodeKind; base: Rect; rect: Rect; from: Rect; blocked: boolean; draw: Drawable[]; spring: number }

/** How far a lifted thing rises off the floor, in screen pixels, and how long it takes to spring back. */
const LIFT_PX = 2;
const SPRING_MS = 180;
/** How far the pointer must travel before a press on a thing becomes a drag rather than a click. */
const DRAG_SLOP = 6;
/** How big a zone's corner handle is, in screen pixels. */
const HANDLE_R = 7;

export interface ZoneSummary {
  id: string; label: string; accent: string; color: string;
  agents: { role: string; color: string; state: string }[];
  meetings: number;
}

interface Sprite {
  canvas: HTMLCanvasElement;
  /** the zoom the bitmap was drawn at */
  zoom: number;
  /** the bitmap's top-left, relative to the anchor cell's screen point, in screen px at `zoom` */
  dx: number; dy: number;
  w: number; h: number;
  /** the light the bitmap was drawn under */
  light: string;
}

/** How many cached objects may be re-rendered in one frame. Eight is about a millisecond and invisible. */
const REBUILD_BUDGET = 8;
/** How far the camera's zoom may drift from a bitmap's own before it is worth redrawing. */
const ZOOM_TOLERANCE = 0.004;

export class CampusView {
  map!: CampusMap;
  camera!: Camera;
  router!: Router;
  private canvas: HTMLCanvasElement;
  private g!: G;
  private dpr = 1;
  private props: Drawable[] = [];
  private sprites = new Map<Drawable, Sprite>();
  private stale: Drawable[] = [];
  private bodies = new Map<string, Body>();
  private seatIndex: Record<string, number> = {};
  private hourOverride: number | null = null;
  private raf = 0;
  private last = 0;
  private frameTimes: number[] = [];
  private dragging = false;
  private dragMoved = 0;
  private dragFrom: Pt | null = null;
  private keys = new Set<string>();
  private zoneNow = '';
  /**
   * Whether an idle person may wander off for a coffee. On in the product — an office where nobody ever leaves
   * their desk is a screensaver. Off in the shot harness, where a run takes minutes and the pantry quietly
   * collected a dozen people who were meant to be in the scene being photographed (visual QA S9-7).
   */
  coffee = true;
  private prevZoom: number | null = null;
  private pendingFocus: { name: string; zoom: boolean } | null = null;
  private images = new Map<string, HTMLImageElement>();
  private hovered: string | null = null;
  private selected: string | null = null;
  private lightKey = '';
  private minimap: HTMLCanvasElement | null = null;
  private minimapEvery = 0;
  hooks!: ViewHooks;

  /* ---- the office as the owner arranged it (SP9b) ---- */
  /** the template campus, as `office.json` has it; never changed, so a note can always be undone back to it */
  private base!: CampusMap;
  /** `Office/campus.md`, the undo stack, and what has been sent but must not be drawn yet */
  readonly edits = new Edits();
  /** what `this.map` was last built from, so a repaint is paid for only when the note actually changed */
  private builtFrom = '';
  /** the thing or line the owner has picked */
  private picked: string | null = null;
  /** what is under the pointer right now: a thing's id, or an `edge:` id */
  private over: string | null = null;
  private drag: Drag | null = null;
  /** where the press went down, so six pixels of travel can tell a drag from a click */
  private downAt: Pt | null = null;
  private downHit: Hit | null = null;
  /** the pointer, in canvas pixels, whenever it is over the office */
  private pointer: Pt | null = null;
  /** the thing in the air, while it is in the air and while it springs back */
  private lift: Lift | null = null;
  /**
   * The keyboard's own route to a connection: Connect on the selection plate, then a click on the other end.
   * Everything a drag from a port can do has to be doable without one.
   */
  private connectFrom: string | null = null;
  /** a zone being moved or stretched: where it would land */
  private zoneGhost: Rect | null = null;
  /**
   * The desk the owner asked for and the company has not decided on yet: a ghost footprint with "Hiring…" over
   * it. It stands from the moment the sheet is sent until the proposal is resolved, so the office shows the spot
   * is spoken for without pretending somebody sits there.
   */
  private hiring: { rect: Rect; label: string } | null = null;
  /** something picked out of the dock and not yet put down */
  private placing: { kind: DockKind; extra: Partial<LayoutNode>; label: string } | null = null;
  /** messages travelling their lines */
  private pulses: Pulse[] = [];
  /** where each zone's plate landed this frame, so a click on the plate can find it */
  private plateBoxes: Record<string, { x: number; y: number; w: number; h: number }> = {};
  /** where the selected line's ⓧ chip landed this frame */
  private cutChip: { x: number; y: number; r: number } | null = null;

  constructor(private parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'office-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'The office');
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', touchAction: 'none' });
    parent.appendChild(this.canvas);
  }

  /** Load the map, build the furniture, start the loop. */
  async start(url = '/office.json'): Promise<void> {
    const res = await fetch(url);
    this.base = parseCampus(await res.json());
    this.rebuild();
    const slab = slabOf(this.map);
    this.camera = new Camera({ w: this.parent.clientWidth || 1280, h: this.parent.clientHeight || 800, bounds: slab });
    this.camera.frame(slab, { head: 3.4, now: true });
    this.resize();
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('the office needs a 2d canvas');
    this.g = ctx;
    this.bind();
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
    if (this.pendingFocus) { const f = this.pendingFocus; this.pendingFocus = null; this.focusOn(f.name, { zoom: f.zoom }); }
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }

  /** The minimap draws into its own canvas, which the chrome owns and hands over here. */
  attachMinimap(canvas: HTMLCanvasElement | null): void { this.minimap = canvas; this.minimapEvery = 0; }

  /* ---- lifecycle -------------------------------------------------------------------------------------- */

  private resize(): void {
    const w = Math.max(1, this.parent.clientWidth), h = Math.max(1, this.parent.clientHeight);
    this.dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.camera?.resize(w, h);
  }

  /**
   * The pointer, and what it is allowed to mean.
   *
   * One press can become four things, and which one it is is not known when the button goes down: a click on a
   * person, a camera pan, a thing lifted off the floor, or a line drawn out of a port. So the press records what
   * was under it and nothing else happens until either the pointer travels `DRAG_SLOP` — which makes it a drag of
   * whatever was under it — or the button comes up, which makes it a click. A port and a zone handle are the two
   * exceptions: both are small, deliberate targets, and waiting six pixels on them only makes them feel loose.
   */
  private bind(): void {
    const c = this.canvas;
    const at = (e: PointerEvent): Pt => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      const p = at(e);
      this.pointer = p;
      this.dragging = true; this.dragMoved = 0; this.dragFrom = { x: e.clientX, y: e.clientY };
      this.downAt = p;
      this.downHit = this.pick(p.x, p.y);
      // a port and a handle start their drag on the press: they are small and aimed at on purpose
      if (this.downHit?.kind === 'port') this.drag = { kind: 'wire', from: this.downHit.id };
      else if (this.downHit?.kind === 'handle') { this.drag = { kind: 'handle', id: this.downHit.id, corner: this.downHit.corner }; this.zoneGhost = { ...this.map.zoneById[this.downHit.id].rect }; }
    });

    c.addEventListener('pointermove', (e) => {
      const p = at(e);
      this.pointer = p;
      if (this.dragging && this.dragFrom) {
        const dx = e.clientX - this.dragFrom.x, dy = e.clientY - this.dragFrom.y;
        this.dragFrom = { x: e.clientX, y: e.clientY };
        this.dragMoved += Math.abs(dx) + Math.abs(dy);
        if (!this.drag && this.dragMoved > DRAG_SLOP) this.startDrag();
        if (this.drag?.kind === 'camera') { this.camera.nudge(dx, dy); return; }
        if (this.drag) { this.dragTo(p); return; }
        return;
      }
      this.hover(p);
    });

    const end = (e: PointerEvent): void => {
      if (!this.dragging) return;
      this.dragging = false;
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      const p = at(e);
      const drag = this.drag;
      this.drag = null;
      if (drag && drag.kind !== 'camera') { this.dropDrag(drag, p); return; }
      if (this.dragMoved > DRAG_SLOP) return;                 // a pan, not a click
      this.click(p);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { if (!this.dragging) this.pointer = null; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const k = Math.exp(-e.deltaY * 0.0016);
      this.camera.zoomAbout(this.camera.targetZoom * k, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => { if (KEYS.has(e.key)) this.keys.add(e.key); });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** What is under the pointer, and what the cursor should say about it. */
  private hover(p: Pt): void {
    const hit = this.pick(p.x, p.y);
    const role = hit?.kind === 'agent' ? hit.id : null;
    const over = hit && (hit.kind === 'thing' || hit.kind === 'edge' || hit.kind === 'port') ? hit.id : null;
    if (role !== this.hovered || over !== this.over) {
      this.hovered = role;
      this.over = over;
      this.canvas.style.cursor = hit?.kind === 'port' ? 'crosshair' : hit?.kind === 'handle' ? 'nwse-resize'
        : hit?.kind === 'thing' || hit?.kind === 'zonePlate' ? 'grab' : hit ? 'pointer' : 'grab';
    }
    if (this.placing) this.canvas.style.cursor = 'copy';
  }

  /** Six pixels of travel: the press was about whatever it was on. */
  private startDrag(): void {
    const h = this.downHit;
    if (h?.kind === 'thing') {
      this.drag = { kind: 'thing', id: h.id, node: h.node, grab: this.camera.toGrid(this.downAt!.x, this.downAt!.y) };
      this.beginLift(h.id, h.node);
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    if (h?.kind === 'zonePlate') {
      this.drag = { kind: 'zone', id: h.id, grab: this.camera.toGrid(this.downAt!.x, this.downAt!.y) };
      this.zoneGhost = { ...this.map.zoneById[h.id].rect };
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    this.drag = { kind: 'camera' };
  }

  /** The pointer moved with something in hand. */
  private dragTo(p: Pt): void {
    const cell = this.camera.toGrid(p.x, p.y);
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'thing' && this.lift) {
      const a = anchorOf(this.map, d.id);
      if (!a) return;
      const want = { x: a.at.x + (cell.x - d.grab.x), y: a.at.y + (cell.y - d.grab.y) };
      this.aimLift(want);
    } else if (d.kind === 'zone') {
      const z = this.map.zoneById[d.id];
      const dx = snapHalf(cell.x - d.grab.x), dy = snapHalf(cell.y - d.grab.y);
      this.zoneGhost = { x0: z.rect.x0 + dx, y0: z.rect.y0 + dy, x1: z.rect.x1 + dx, y1: z.rect.y1 + dy };
    } else if (d.kind === 'handle') {
      const z = this.map.zoneById[d.id];
      const fx = d.corner === 1 || d.corner === 2 ? z.rect.x0 : z.rect.x1;
      const fy = d.corner === 2 || d.corner === 3 ? z.rect.y0 : z.rect.y1;
      this.zoneGhost = { x0: Math.min(fx, snapHalf(cell.x)), y0: Math.min(fy, snapHalf(cell.y)), x1: Math.max(fx, snapHalf(cell.x)), y1: Math.max(fy, snapHalf(cell.y)) };
    }
  }

  /** The button came up with something in hand. */
  private dropDrag(d: Drag, p: Pt): void {
    this.canvas.style.cursor = 'grab';
    if (d.kind === 'thing') {
      const l = this.lift;
      this.lift = null;
      if (!l) return;
      if (l.blocked) { this.springBack(l); this.say(SPOT_TAKEN); return; }
      const to = l.node === 'desk' ? { x: l.rect.x0, y: l.rect.y0 } : { x: (l.rect.x0 + l.rect.x1) / 2, y: (l.rect.y0 + l.rect.y1) / 2 };
      this.step(moveThing(this.map, this.edits.layout, d.id, to, this.nameOf));
      return;
    }
    if (d.kind === 'zone') {
      const g = this.zoneGhost;
      this.zoneGhost = null;
      if (g) this.step(moveZone(this.map, this.edits.layout, d.id, { x: g.x0, y: g.y0 }));
      return;
    }
    if (d.kind === 'handle') {
      const g = this.zoneGhost;
      this.zoneGhost = null;
      if (g) this.step(resizeZone(this.map, this.edits.layout, d.id, g));
      return;
    }
    if (d.kind === 'wire') {
      const hit = this.pick(p.x, p.y);
      const to = hit?.kind === 'thing' || hit?.kind === 'port' ? hit.id : null;
      if (!to || to === d.from) return;                                    // dropped on the floor: nothing happens
      if (!connectionKind(this.map, d.from, to)) return;
      // already wired: the owner is pointing at the line they mean, so select it rather than saying nothing
      if (this.edits.layout.connections.some((cn) => (cn.from === d.from && cn.to === to) || (cn.from === to && cn.to === d.from))) { this.select(edgeId(d.from, to)); return; }
      this.step(connectStep(this.map, this.edits.layout, d.from, to, this.nameOf));
    }
  }

  /** A press that did not travel: a click. */
  private click(p: Pt): void {
    if (this.placing) { this.placeAt(this.camera.toGrid(p.x, p.y)); return; }
    const hit = this.pick(p.x, p.y);
    if (this.connectFrom) {
      const from = this.connectFrom;
      this.connectFrom = null;
      const to = hit && (hit.kind === 'thing' || hit.kind === 'port') ? hit.id : hit?.kind === 'agent' ? this.map.desks[this.hooks.getState().agents[hit.id]?.desk ?? '']?.id ?? null : null;
      if (to && to !== from && connectionKind(this.map, from, to)) { this.connectIds(from, to); return; }
      this.say('Nothing to connect there.');
      return;
    }
    if (hit?.kind === 'cut') { const ends = edgeEnds(hit.id); if (ends) this.step(disconnectStep(this.edits.layout, ends[0], ends[1])); this.select(null); return; }
    if (hit?.kind === 'agent') {
      // Second click on the person at a selected desk focuses them, as it always did; the first selects the desk.
      this.select(null);
      this.hooks.onAgentClick(hit.id);
      return;
    }
    if (hit?.kind === 'screen') { this.select(null); this.hooks.onSurfaceClick(hit.id); return; }
    if (hit?.kind === 'thing') { this.select(this.picked === hit.id ? null : hit.id); return; }
    if (hit?.kind === 'edge') { this.select(this.picked === hit.id ? null : hit.id); return; }
    if (hit?.kind === 'zonePlate') { this.select(this.picked === hit.id ? null : hit.id); return; }
    if (hit?.kind === 'zone') { this.select(null); this.hooks.onSurfaceClick(hit.id); return; }
    this.select(null);
  }

  /* ---- the frame -------------------------------------------------------------------------------------- */

  private frame(now: number): void {
    this.raf = requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.frameTimes.push(now);
    if (this.frameTimes.length > 30) this.frameTimes.shift();
    if (this.canvas.width !== Math.round(this.parent.clientWidth * this.dpr)) this.resize();

    // The arrow keys fly the camera, at a constant screen speed whatever the zoom — unless something is selected,
    // in which case they nudge it half a cell and the app never sends them here at all (`keyDown`). WASD went
    // with SP9b: `D` is the dock's now, and three of the four keys without the fourth is worse than none.
    let kx = 0, ky = 0;
    if (this.keys.has('ArrowLeft')) kx += 1;
    if (this.keys.has('ArrowRight')) kx -= 1;
    if (this.keys.has('ArrowUp')) ky += 1;
    if (this.keys.has('ArrowDown')) ky -= 1;
    if (kx || ky) this.camera.nudge(kx * 540 * dt, ky * 540 * dt);

    this.camera.step(dt);
    this.tick(dt);
    this.stepLift(dt);
    if (this.pulses.length) { const now = this.hooks.clock(); this.pulses = this.pulses.filter((p) => now - p.at <= PULSE_MS); }
    this.render();
    if (this.minimap && ++this.minimapEvery % 4 === 0) this.paintMinimap();
  }

  /** The office's own frame rate, as a rolling average over the last thirty frames. */
  fps(): number {
    const t = this.frameTimes;
    return t.length > 2 ? ((t.length - 1) * 1000) / (t[t.length - 1] - t[0]) : 0;
  }

  private hour(): number { return this.hourOverride ?? this.hooks.hour(); }
  setHourOverride(h: number | null): void { this.hourOverride = h; }

  /** Reconcile the bodies with the reducer state and let them live for a frame. */
  private tick(dt: number): void {
    const s = this.hooks.getState();
    const nowMs = this.hooks.clock();
    const talking = Object.values(s.agents).find((v) => v.state === 'talking' && v.bubble?.kind === 'speech');
    const talker = talking ? this.bodies.get(talking.role) : undefined;
    const ctx: BodyContext = {
      speaker: talker ? { x: talker.at.x, y: talker.at.y, role: talking!.role } : null,
      selected: this.selected, hovered: this.hovered,
    };
    for (const [role, v] of Object.entries(s.agents)) {
      let b = this.bodies.get(role);
      if (!b) {
        b = new Body(v, { map: this.map, router: this.router, seatFor: (r, room) => this.takeSeat(room), roll: () => (this.coffee ? Math.random() : 1) });
        this.bodies.set(role, b);
      }
      if (v.target && this.map.seats[v.target] && !b.seat) b.seat = this.takeSeat(v.target);
      if (!v.target && b.seat) b.seat = null;
      b.update(v, dt, nowMs, ctx);
    }
    for (const [role, b] of this.bodies) if (!s.agents[role]) { this.bodies.delete(role); void b; }

    const z = railZoneAt(this.map, this.camera.at)?.id ?? 'campus';
    if (z !== this.zoneNow) { this.zoneNow = z; this.hooks.onZoneChange?.(z); }
  }

  /** The next free seat in a room, round-robin. */
  takeSeat(room: string): Seat | null {
    const seats = this.map.seats[room] ?? [];
    if (!seats.length) return null;
    const i = (this.seatIndex[room] = ((this.seatIndex[room] ?? -1) + 1) % seats.length);
    return seats[i];
  }
  /** Give a role a seat in a room for a meeting. */
  assignSeat(role: string, room: string): Seat | null {
    const seat = this.takeSeat(room);
    const b = this.bodies.get(role);
    if (b && seat) b.seat = seat;
    return seat;
  }

  /* ---- rendering -------------------------------------------------------------------------------------- */

  private render(): void {
    const g = this.g, cam = this.camera;
    const v = cam.view();
    const light = lightAt(this.hour());
    const lightKey = `${light.name}|${Math.round(this.hour() * 4)}`;
    if (lightKey !== this.lightKey) { this.lightKey = lightKey; this.sprites.clear(); }
    this.cutChip = null;
    const t = this.timing;
    let mark = performance.now();
    const lap = (k: keyof Timing): void => { const n = performance.now(); t[k] += n - mark; mark = n; };

    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, cam.w, cam.h);
    paintGround(g, v, this.map, light);
    lap('ground');

    // pass 3: the world, back to front. Furniture from the bitmap cache, people live, screens live.
    const items: { d: number; kind: 'prop' | 'body' | 'screen'; prop?: Drawable; body?: Body }[] = [];
    for (const p of this.props) if (this.onScreen(v, p)) items.push({ d: p.d, kind: 'prop', prop: p });
    for (const s of buildScreens(this.map, (k) => this.screenContent(k))) if (this.onScreen(v, s)) items.push({ d: s.d, kind: 'screen', prop: s });
    for (const b of this.bodies.values()) if (b.visible()) items.push({ d: b.depth, kind: 'body', body: b });
    items.sort((a, b) => a.d - b.d);
    lap('sort');

    g.save();
    campusClip(g, v, this.map);
    g.clip();
    // Every plate this frame claims its box out of one book, so two names can never land on top of each other.
    // Cleared here, before the first thing that draws a plate, which is a screen in the pass below. The book is
    // told the free area first — inside the canvas, clear of the zone rail and the two bars — and the minimap is
    // blocked out of it, so nothing a plate says ever ends up half under a piece of chrome.
    PLATES.clear({ x0: CHROME.left + 6, y0: CHROME.top + 6, x1: cam.w - 6, y1: cam.h - CHROME.bottom - 6 });
    if (this.minimap && this.minimap.clientWidth > 0) {
      const mm = this.minimap.getBoundingClientRect();
      PLATES.block(mm.left - 8, mm.top - CHROME.hit - 12, mm.width + 16, mm.height + CHROME.hit + 20);
    }
    let budget = REBUILD_BUDGET;
    // The floor dressing is painted first (its depth key is under -800), then everything the owner drew on the
    // floor — the lines, the pulses travelling them, the landing ghost — then everything that stands. A line
    // over a person's feet would be the one thing in the picture that is not a room.
    let floorDone = false;
    const lifted = this.lift?.id ?? null;
    for (const it of items) {
      if (!floorDone && !(it.kind === 'prop' && it.prop!.floor)) { floorDone = true; this.paintFloorMarks(g, v); }
      if (it.kind === 'body') { it.body!.shadow(g, v, light); it.body!.draw(g, v, light); continue; }
      if (it.kind === 'screen') { const s0 = performance.now(); it.prop!.draw(g, v, light); t.screens += performance.now() - s0; continue; }
      if (lifted && it.prop!.owner === lifted) continue;             // it is in the air; it is drawn below
      budget -= this.blit(g, v, light, it.prop!, budget > 0) ? 1 : 0;
    }
    if (!floorDone) this.paintFloorMarks(g, v);
    this.paintLifted(g, v, light);
    g.restore();
    t.world += performance.now() - mark; mark = performance.now();

    paintHour(g, v, this.map, light);
    this.paintLamps(g, v);
    lap('light');

    // pass 5: UI type, in screen space, over everything
    const ctx: BodyContext = { speaker: null, selected: this.selected, hovered: this.hovered };
    if (worldTextVisible(cam.zoom)) for (const b of this.bodies.values()) b.drawLabel(g, v, ctx);
    this.plateBoxes = paintZonePlates(g, v, this.map, { current: this.zoneNow, selected: this.picked });
    if (nameLabelVisible(cam.zoom)) this.paintDeskPlates(g, v);
    // pass 6: the handles the owner reaches for — a zone's corners, a thing's port, a line's ⓧ, and the message
    // travelling its line. Controls, not scenery, so they are drawn over the hour rather than under it.
    this.paintMarksOverHour(g, v, light);
    lap('labels');
    t.frames += 1;
  }

  /**
   * Where the frame went, in milliseconds summed since the last read.
   *
   * The spec carries a frame-rate budget, and a budget nobody can attribute is a number to argue about: this says
   * which pass to look at. `__cubicle.profile()` divides by the frame count and clears.
   */
  private timing: Timing = { ground: 0, sort: 0, world: 0, screens: 0, light: 0, labels: 0, frames: 0 };
  profile(): Record<string, number> {
    const t = this.timing, n = Math.max(1, t.frames);
    const out = { frames: t.frames, fps: Math.round(this.fps()), ground: +(t.ground / n).toFixed(2), sort: +(t.sort / n).toFixed(2), world: +(t.world / n).toFixed(2), screens: +(t.screens / n).toFixed(2), light: +(t.light / n).toFixed(2), labels: +(t.labels / n).toFixed(2), props: this.props.length, sprites: this.sprites.size };
    this.timing = { ground: 0, sort: 0, world: 0, screens: 0, light: 0, labels: 0, frames: 0 };
    return out;
  }

  /** Is any of this object's screen box inside the viewport? */
  private onScreen(v: View, p: Drawable): boolean {
    if (!p.bounds) return true;
    const b = this.boxOf(v, p);
    return b.x + b.w > -40 && b.x < v.cam.w + 40 && b.y + b.h > -40 && b.y < v.cam.h + 40;
  }

  /** The screen-space box a drawable paints into, its shadow included. */
  private boxOf(v: View, p: Drawable): { x: number; y: number; w: number; h: number; ax: number; ay: number } {
    const r = p.bounds!;
    const hz = p.hz ?? 0;
    const pts: Pt[] = [...quad(v, r, 0), ...quad(v, r, hz)];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of pts) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    // the shadow reaches down and to the right; the margin is generous because a blur runs past the silhouette
    const reach = (hz + 0.4) * v.cz * 3.2;
    const pad = 6 + 8 * v.z;
    const a = v.p(r.x0, r.y0, 0);
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + reach + pad * 2, h: y1 - y0 + reach * 0.66 + pad * 2, ax: a.x, ay: a.y };
  }

  /** Blit a cached object; build or rebuild its bitmap when there is budget. Returns whether it rebuilt. */
  private blit(g: G, v: View, light: Light, p: Drawable, mayBuild: boolean): boolean {
    if (!p.bounds) { p.draw(g, v, light); return false; }
    let s = this.sprites.get(p);
    const wrongZoom = !s || Math.abs(s.zoom - v.z) > ZOOM_TOLERANCE;
    let built = false;
    if ((!s || wrongZoom) && (mayBuild || !s)) { s = this.build(v, light, p); built = true; }
    if (!s) return false;
    const a = v.p(p.bounds.x0, p.bounds.y0, 0);
    const k = v.z / s.zoom;
    g.drawImage(s.canvas, a.x + s.dx * k, a.y + s.dy * k, s.w * k, s.h * k);
    return built;
  }

  private build(v: View, light: Light, p: Drawable): Sprite | undefined {
    const box = this.boxOf(v, p);
    const w = Math.ceil(box.w), h = Math.ceil(box.h);
    if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return undefined;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * this.dpr));
    canvas.height = Math.max(1, Math.round(h * this.dpr));
    const sg = canvas.getContext('2d');
    if (!sg) return undefined;
    sg.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const off = offsetView(v, box.x, box.y);
    if (p.shadow) {
      sg.save();
      sg.filter = `blur(${(1.4 + 3.2 * v.z).toFixed(2)}px)`;
      p.shadow(sg, off, light);
      sg.restore();
    }
    p.draw(sg, off, light);
    const sprite: Sprite = { canvas, zoom: v.z, dx: box.x - box.ax, dy: box.y - box.ay, w, h, light: light.name };
    this.sprites.set(p, sprite);
    return sprite;
  }

  /** The warm points after dark: a halo over every lamp and lit screen, added over the hour's multiply. */
  private paintLamps(g: G, v: View): void {
    const k = lampStrength(this.hour());
    if (k <= 0.01) return;
    // Where somebody is working or talking. A lamp near one of them burns; the rest of the campus keeps a low
    // stand-by glow, so an office after dark says at a glance who is still in it rather than lighting forty empty
    // desks at equal brightness.
    const busy: Pt[] = [];
    for (const b of this.bodies.values()) {
      if (b.view.state === 'working' || b.view.state === 'talking') busy.push({ x: b.at.x, y: b.at.y });
    }
    g.save();
    campusClip(g, v, this.map);
    g.clip();
    g.globalCompositeOperation = 'screen';
    for (const d of this.map.decor) {
      if (d.kind !== 'lamp') continue;
      const lit = busy.some((p) => Math.hypot(p.x - d.at.x, p.y - d.at.y) < LAMP_REACH);
      const strength = k * (lit ? 1 : 0.34);
      const at = v.p(d.at.x, d.at.y, 0.9);
      const r = Math.max(20, (lit ? 2.4 : 1.7) * v.cw);
      const grad = g.createRadialGradient(at.x, at.y, 0, at.x, at.y, r);
      grad.addColorStop(0, rgba(M.lamp, 0.46 * strength));
      grad.addColorStop(0.5, rgba(M.lampDeep, 0.18 * strength));
      grad.addColorStop(1, rgba(M.lampDeep, 0));
      g.fillStyle = grad;
      g.beginPath(); g.arc(at.x, at.y, r, 0, Math.PI * 2); g.fill();
    }
    for (const s of Object.values(this.map.screens)) {
      if (s.face !== 'screen') continue;
      const at = v.p(s.axis === 'x' ? s.x + s.len / 2 : s.x, s.axis === 'x' ? s.y : s.y + s.len / 2, s.z + s.h / 2);
      const r = Math.max(24, 2.4 * v.cw);
      const grad = g.createRadialGradient(at.x, at.y, 0, at.x, at.y, r);
      grad.addColorStop(0, rgba(M.screenGlow, 0.22 * k));
      grad.addColorStop(1, rgba(M.screenGlow, 0));
      g.fillStyle = grad;
      g.beginPath(); g.arc(at.x, at.y, r, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }

  /** The desk plates, close in: whose desk this is, under the desk's own front edge. */
  private paintDeskPlates(g: G, v: View): void {
    const s = this.hooks.getState();
    const byDesk: Record<string, string> = {};
    for (const a of Object.values(s.agents)) byDesk[a.desk] = a.display;
    for (const d of Object.values(this.map.desks)) {
      const name = byDesk[d.id];
      if (!name) continue;
      // the plate goes on the desk's far edge, never over the person sitting at it
      const at = v.p((d.rect.x0 + d.rect.x1) / 2, d.side === 'far' ? d.rect.y1 + 0.5 : d.rect.y0 - 0.5, 0);
      if (at.x < -80 || at.x > v.cam.w + 80 || at.y < -30 || at.y > v.cam.h + 30) continue;
      // The body carries the name wherever the body is, so a desk plate is for a desk whose owner is not in the
      // frame at all. It used to yield only while they were sitting at it, which put "The Skeptic" on the desk and
      // "The Skeptic" on the advisor at the board table, in the same picture (visual QA S9-6).
      const owner = [...this.bodies.values()].find((b) => b.view.desk === d.id);
      if (owner && owner.visible()) {
        const p = v.p(owner.at.x, owner.at.y, 0);
        if (p.x > -60 && p.x < v.cam.w + 60 && p.y > -30 && p.y < v.cam.h + 30) continue;
      }
      plateFor(g, at, name, d.accent);
    }
  }

  private paintMinimap(): void {
    if (!this.minimap) return;
    drawMinimap(this.minimap, this.map, this.camera, [...this.bodies.values()].map((b) => ({ x: b.at.x, y: b.at.y, colour: b.view.state === 'offline' ? M.offline : divisionChip(b.view.division) })));
  }

  /* ---- what the screens are showing ------------------------------------------------------------------- */

  private screenContent(kind: string): ScreenContent {
    const s = this.hooks.getState();
    const frames = this.hooks.frames();
    switch (kind) {
      case 'billboard': {
        const browser = Object.values(s.surfaces).filter((x) => x.streamKind === 'browser');
        const su = browser.find((x) => x.active) ?? browser[0];
        const url = su ? frames[su.streamId] : undefined;
        return { ...(url ? { image: this.image(url) } : {}), live: !!su?.active, ...(url ? {} : { lines: ['no session open'] }) };
      }
      case 'terminal': {
        const lines = s.terminal.filter((l) => l.trim()).slice(-6);
        return { lines: lines.length ? lines : ['$ \u2014 idle'], live: Object.values(s.surfaces).some((x) => x.streamKind === 'terminal' && x.active) };
      }
      case 'noticeboard': {
        const jobs = Object.values(s.jobs);
        const open = jobs.filter((j) => j.status === 'queued' || j.status === 'in_progress').length;
        const blocked = jobs.filter((j) => j.status === 'blocked').length;
        return { lines: [open || blocked ? `${open} job${open === 1 ? '' : 's'} \u00b7 ${blocked} blocked` : 'Queue empty'] };
      }
      case 'whiteboard': return { lines: [headline(s.plan) ?? 'No plan yet'] };
      case 'postoffice': { const n = s.inbox.length; return { lines: [n ? `${n} waiting for you` : 'Nothing waiting'] }; }
      case 'bank': return { lines: [s.money ? `${s.money.cash} \u00b7 ${s.money.runway}` : 'no ledger yet'] };
      case 'newsstand': return { lines: [s.feed[0]?.text ?? 'No brief yet'] };
      case 'workshop': return { lines: [headline(s.latestRun?.body ?? '') ?? 'no build yet'] };
      case 'vault': return { lines: ['open in Obsidian'] };
      case 'cabin': return { lines: [s.chat.length ? s.chat[s.chat.length - 1].text : 'ask me anything'] };
      default: return {};
    }
  }

  /** A frame URL as a decoded image, kept until the URL changes. */
  private image(url: string): HTMLImageElement | null {
    const have = this.images.get(url);
    if (have) return have.complete && have.naturalWidth > 0 ? have : null;
    const img = new Image();
    img.src = url;
    this.images.set(url, img);
    // one stream keeps one frame: without this a live browser fills the map with every frame it ever sent
    if (this.images.size > 8) { const first = this.images.keys().next().value; if (first) this.images.delete(first); }
    return null;
  }

  /* ---- the office as the owner arranged it (SP9b) ------------------------------------------------------ */

  /**
   * Rebuild the campus from the template plus the note.
   *
   * The template is never edited, so this is always `applyLayout(base, note)` from scratch: an office that has
   * been dragged about for an hour is the same object as one loaded from the same note cold, which is the only
   * way "reload and it is still there" can be true rather than nearly true.
   *
   * It costs one parse of the note, one router and one pass over the props. That is a few milliseconds, and it is
   * paid when the owner drops something — never on a frame.
   */
  private rebuild(): void {
    const key = JSON.stringify(this.edits.layout);
    if (key === this.builtFrom && this.map) return;
    this.builtFrom = key;
    const before = this.map;
    this.map = applyLayout(this.base, this.edits.layout);
    this.router = makeRouter(this.map);
    this.props = buildProps(this.map).sort((a, b) => a.d - b.d);
    this.sprites.clear();
    this.stale.length = 0;
    if (this.camera) this.camera.bounds = slabOf(this.map);
    // Whoever's desk moved gets up and walks to it. Everyone else keeps whatever they were doing: a note that
    // moved one desk must not send the whole company back to their chairs.
    if (before) for (const b of this.bodies.values()) {
      const was = before.desks[b.view.desk]?.seat, now = this.map.desks[b.view.desk]?.seat;
      b.remap(this.map, this.router, !!was !== !!now || (!!was && !!now && (was.x !== now.x || was.y !== now.y)));
    }
  }

  /** How the owner would say who this is. */
  private nameOf = (id: string): string => this.hooks.nameOf?.(id) ?? this.map.resources[id]?.label ?? this.map.zoneById[id]?.label ?? id;
  private say(text: string): void { this.hooks.say?.(text); }

  /** One step the owner took: remember it, redraw the office, say what happened, tell the daemon. */
  private step(s: Step | null): void {
    if (!s) { this.say(SPOT_TAKEN); return; }
    const send = this.edits.apply(s);
    this.rebuild();
    this.say(s.said);
    this.hooks.onLayoutChange?.(send);
    this.refreshSelection();
  }

  /** The daemon's word on the office — from the snapshot or from `layout.changed`. Never undoable: it is true. */
  setLayout(layout: CampusLayout): void {
    this.edits.accept(layout);
    this.rebuild();
    this.refreshSelection();
  }
  /** The note as the office holds it. */
  layout(): CampusLayout { return this.edits.layout; }

  /** Go back one step. Returns whether there was one. */
  undoLayout(): boolean {
    const send = this.edits.undo();
    if (!send) return false;
    this.rebuild();
    this.say('Undone.');
    this.hooks.onLayoutChange?.(send);
    this.refreshSelection();
    return true;
  }

  /* ---- selection --------------------------------------------------------------------------------------- */

  select(id: string | null): void {
    this.picked = id;
    this.hooks.onSelect?.(id ? this.selectionFor(id) : null);
  }
  /** What is picked, or null. */
  selected2(): string | null { return this.picked; }

  private refreshSelection(): void {
    if (!this.picked) return;
    const sel = this.selectionFor(this.picked);
    if (!sel) { this.select(null); return; }
    this.hooks.onSelect?.(sel);
  }

  /**
   * Where the plate beside the selection hangs, in canvas pixels: the top-right of what is selected. Read every
   * frame by the chrome, because the camera moves and the plate has to move with the thing it is about.
   */
  selectionAnchor(): Pt | null {
    if (!this.picked) return null;
    const v = this.camera.view();
    const ends = edgeEnds(this.picked);
    if (ends) {
      const a = anchorOf(this.map, ends[0]), b = anchorOf(this.map, ends[1]);
      if (!a || !b) return null;
      const mid = pointOn(edgeCurve(a.at, b.at), 0.5);
      return v.p(mid.x, mid.y, 0.4);
    }
    const a = anchorOf(this.map, this.picked);
    if (!a) return null;
    return v.p(a.rect.x1, a.rect.y0, a.kind === 'zone' ? 0 : 1.1);
  }

  private selectionFor(id: string): Selection | null {
    const ends = edgeEnds(id);
    if (ends) {
      const [x, y] = ends;
      const cn = liveConnections(this.map, this.edits.layout).find((c) => (c.from === x && c.to === y) || (c.from === y && c.to === x));
      if (!cn) return null;
      const label = cn.kind === 'peer' ? `${this.nameOf(cn.from)} and ${this.nameOf(cn.to)}` : `${this.nameOf(cn.from)} → ${this.nameOf(cn.to)}`;
      return { id, kind: 'edge', label, sub: cn.kind === 'peer' ? 'Can message each other' : 'Can use this', actions: ['remove'], at: { x: 0, y: 0 } };
    }
    const a = anchorOf(this.map, id);
    if (!a) return null;
    if (a.kind === 'zone') return { id, kind: 'zone', label: a.label, sub: 'Zone', actions: ['rename'], at: { x: 0, y: 0 } };
    if (a.kind === 'desk') return { id, kind: 'desk', label: this.nameOf(id), sub: 'Desk', actions: ['connect', 'remove'], at: { x: 0, y: 0 } };
    if (a.kind === 'resource') { const r = this.map.resources[id]; return { id, kind: 'resource', label: r.label, sub: SUB_OF[r.kind], actions: ['connect', 'rename', 'remove'], at: { x: 0, y: 0 } }; }
    return { id, kind: 'prop', label: a.label, sub: 'Prop', actions: ['remove'], at: { x: 0, y: 0 } };
  }

  /* ---- the actions, however they were asked for -------------------------------------------------------- */

  /** Take the selected thing away. A desk goes through a fire proposal; anything else goes at once. */
  removeSelected(): boolean {
    const id = this.picked;
    if (!id) return false;
    const ends = edgeEnds(id);
    if (ends) { this.step(disconnectStep(this.edits.layout, ends[0], ends[1])); this.select(null); return true; }
    const s = removeThing(this.map, this.edits.layout, id, this.nameOf);
    if (!s) return false;
    this.step(s);
    this.select(null);
    return true;
  }

  /** Give the selected thing another name. Only what the owner put there, and the zones, have one to give. */
  renameSelected(text: string): boolean {
    const id = this.picked;
    const label = text.trim();
    if (!id || !label) return false;
    const a = anchorOf(this.map, id);
    if (!a || (a.kind !== 'resource' && a.kind !== 'zone')) return false;
    const next = { ...this.edits.layout, nodes: { ...this.edits.layout.nodes, [id]: { ...this.edits.layout.nodes[id], label } } };
    this.step({ layout: next, said: `Renamed it ${label}.` });
    return true;
  }

  /** Connect was pressed on the selection plate: the next click on a thing is the other end. */
  armConnect(id: string): void { this.connectFrom = id; }
  /** Whether a connection is waiting for its other end. */
  connecting(): string | null { return this.connectFrom; }

  /**
   * Move a thing to a cell outright — the console's and the harness's route to a drag.
   *
   * The same step the pointer takes, so a test that drags a desk is testing what the owner's hand does and not a
   * second implementation of it. Returns false when the spot is taken, which is what the pointer is told too.
   */
  dragTo2(id: string, to: Cell): boolean {
    const a = anchorOf(this.map, id);
    if (!a) return false;
    if (a.kind === 'zone') { const z = moveZone(this.map, this.edits.layout, id, to); if (!z) return false; this.step(z); return true; }
    const at = a.kind === 'desk' ? { x: to.x - (a.rect.x1 - a.rect.x0) / 2, y: to.y - (a.rect.y1 - a.rect.y0) / 2 } : to;
    const s = moveThing(this.map, this.edits.layout, id, at, this.nameOf);
    if (!s) { this.say(SPOT_TAKEN); return false; }
    this.step(s);
    return true;
  }

  /** Wire two things together by id — the Org sheet's route, and `__cubicle.connect`. */
  connectIds(a: string, b: string): boolean {
    const s = connectStep(this.map, this.edits.layout, a, b, this.nameOf);
    if (!s) return false;
    this.step(s);
    return true;
  }
  disconnectIds(a: string, b: string): boolean {
    const s = disconnectStep(this.edits.layout, a, b);
    if (!s) return false;
    this.step(s);
    return true;
  }

  /** An arrow key with something selected: half a cell, along the plane. */
  nudgeSelected(key: string): boolean {
    const n = NUDGE[key];
    if (!n || !this.picked) return false;
    const a = anchorOf(this.map, this.picked);
    if (!a) return false;
    if (a.kind === 'zone') { this.step(moveZone(this.map, this.edits.layout, this.picked, { x: a.rect.x0 + n.x, y: a.rect.y0 + n.y })); return true; }
    const to = a.kind === 'desk' ? { x: a.rect.x0 + n.x, y: a.rect.y0 + n.y } : { x: a.at.x + n.x, y: a.at.y + n.y };
    this.step(moveThing(this.map, this.edits.layout, this.picked, to, this.nameOf));
    return true;
  }

  /**
   * The keyboard, for everything the owner can do to the office.
   *
   * Handed the event by the app rather than listening itself: the sheets, the first-run card and the quick-open
   * palette all own the keyboard while they are up, and the office must not be arranging itself behind them.
   */
  keyDown(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): boolean {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) return this.undoLayout();
    if (e.ctrlKey || e.metaKey || !this.map) return false;
    if (e.key === 'Escape') {
      if (this.connectFrom) { this.connectFrom = null; return true; }
      if (this.placing) { this.cancelPlacing(); return true; }
      if (this.lift) { const l = this.lift; this.lift = null; this.drag = null; this.dragging = false; this.springBack(l); return true; }
      if (this.zoneGhost) { this.zoneGhost = null; this.drag = null; this.dragging = false; return true; }
      if (this.picked) { this.select(null); return true; }
      return false;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.picked) return this.removeSelected();
    if (NUDGE[e.key] && this.picked) return this.nudgeSelected(e.key);
    return false;
  }

  /* ---- the dock's placement flow ------------------------------------------------------------------------ */

  /** Something picked out of the dock and not yet put down. The next click on the floor places it. */
  arm(kind: DockKind, extra: Partial<LayoutNode> = {}, label = ''): void {
    this.placing = { kind, extra, label: label || String(kind) };
    this.select(null);
    this.canvas.style.cursor = 'copy';
  }
  cancelPlacing(): void { this.placing = null; this.canvas.style.cursor = 'grab'; }
  /** What is being placed, for the dock to keep its glyph lit. */
  placingKind(): DockKind | null { return this.placing?.kind ?? null; }

  /**
   * The spot a hire was asked for, or `null` once it is decided.
   *
   * A desk's own footprint, so the ghost is the size of the thing that would arrive. It is not in the note: a
   * proposal is the company's business, not the floor's, and a rejected hire must leave nothing behind.
   */
  setHiring(at: Cell | null, label = 'Hiring…'): void {
    this.hiring = at ? { rect: { x0: at.x - 1.25, y0: at.y - 0.65, x1: at.x + 1.25, y1: at.y + 0.65 }, label } : null;
  }
  hiringAt(): Rect | null { return this.hiring?.rect ?? null; }

  /** The name of the room a cell falls in, for a sheet that has to say where the owner just dropped something. */
  zoneLabelAt(at: Cell): string | null { return this.map ? zoneAt(this.map, at)?.label ?? null : null; }

  /** Put the armed thing down at a cell. */
  placeAt(cell: Cell): boolean {
    const p = this.placing;
    if (!p) return false;
    this.cancelPlacing();
    if (p.kind === 'agent') { this.hooks.onHire?.({ x: snapHalf(cell.x), y: snapHalf(cell.y) }); return true; }
    const s = addResource(this.map, this.edits.layout, p.kind, cell, p.extra);
    if (!s) { this.say(SPOT_TAKEN); return false; }
    this.step(s);
    this.select(s.id);
    return true;
  }

  /** The dock dropped a glyph on the office at a screen point (the drag route, rather than click-then-click). */
  dropFromDock(px: number, py: number): boolean {
    if (!this.placing) return false;
    return this.placeAt(this.camera.toGrid(px, py));
  }

  /* ---- the pulse --------------------------------------------------------------------------------------- */

  /**
   * A message travelled a line. The one memorable motion in the office, and the only thing that moves on the
   * floor: everything else on it is a diagram that stays still.
   */
  pulse(from: string, to: string): void {
    const wired = !!this.map && this.edits.layout.connections.some((c) => (c.from === from && c.to === to) || (c.from === to && c.to === from));
    if (!shouldPulse(wired, motionOff())) return;
    this.pulses.push({ from, to, at: this.hooks.clock() });
    if (this.pulses.length > 24) this.pulses.shift();
  }

  /* ---- the thing in the air ----------------------------------------------------------------------------- */

  private beginLift(id: string, node: NodeKind): void {
    const a = anchorOf(this.map, id);
    if (!a) return;
    this.lift = { id, node, base: { ...a.rect }, rect: { ...a.rect }, from: { ...a.rect }, blocked: false, draw: this.drawablesAt(id, node, a.rect), spring: 0 };
  }

  /** The pointer moved: where would it land, and may it. */
  private aimLift(want: Pt): void {
    const l = this.lift;
    if (!l) return;
    const w = l.base.x1 - l.base.x0, d = l.base.y1 - l.base.y0;
    // A desk snaps its own corner, so a row of desks lines up; anything else snaps the point it is centred on,
    // which is the point the owner is pointing at.
    const x0 = l.node === 'desk' ? snapHalf(want.x - w / 2) : snapHalf(want.x) - w / 2;
    const y0 = l.node === 'desk' ? snapHalf(want.y - d / 2) : snapHalf(want.y) - d / 2;
    if (x0 === l.rect.x0 && y0 === l.rect.y0) return;
    l.rect = { x0, y0, x1: x0 + w, y1: y0 + d };
    l.blocked = !!occupiedBy(this.map, l.rect, l.id);
    l.draw = this.drawablesAt(l.id, l.node, l.rect);
  }

  /** The thing goes back where it came from, over 180 ms. Under reduced motion it is simply back. */
  private springBack(l: Lift): void {
    if (motionOff() || (l.rect.x0 === l.base.x0 && l.rect.y0 === l.base.y0)) { this.lift = null; return; }
    this.lift = { ...l, from: { ...l.rect }, spring: 1 };
  }

  private stepLift(dt: number): void {
    const l = this.lift;
    if (!l || l.spring <= 0) return;
    l.spring -= (dt * 1000) / Math.max(1, SPRING_MS * MOTION.scale);
    if (l.spring <= 0) { this.lift = null; return; }
    const k = 1 - (1 - (1 - l.spring)) ** 3;
    l.rect = { x0: mix1(l.from.x0, l.base.x0, k), y0: mix1(l.from.y0, l.base.y0, k), x1: mix1(l.from.x1, l.base.x1, k), y1: mix1(l.from.y1, l.base.y1, k) };
    l.draw = this.drawablesAt(l.id, l.node, l.rect);
  }

  /** The same object, built at a rectangle that is not the one the map has it at. */
  private drawablesAt(id: string, node: NodeKind, rect: Rect): Drawable[] {
    if (node === 'desk') {
      const d = this.map.desks[id];
      if (!d) return [];
      const dx = rect.x0 - d.rect.x0, dy = rect.y0 - d.rect.y0;
      return deskDrawables({ ...d, rect, seat: { x: d.seat.x + dx, y: d.seat.y + dy } });
    }
    if (node === 'resource') {
      const r = this.map.resources[id];
      return r ? [resourceProp({ ...r, rect, at: { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 } })] : [];
    }
    const p = this.map.props.find((q) => q.id === id);
    return p ? propDrawables({ ...p, rect, at: { x: p.at.x + (rect.x0 - p.rect.x0), y: p.at.y + (rect.y0 - p.rect.y0) } }) : [];
  }

  /* ---- what the floor carries --------------------------------------------------------------------------- */

  /**
   * The lines, and whatever the owner is in the middle of doing.
   *
   * A resting line is scenery: it lies on the floor under everything that stands and the hour's multiply reaches
   * it, exactly as it reaches the floor it is drawn on. The selected line, the pulses and the ports are not
   * scenery but controls, so they are drawn over the hour instead (`paintMarksOverHour`) and hold their contrast
   * at noon and at midnight alike.
   */
  private paintFloorMarks(g: G, v: View): void {
    const sel = this.selectedEdge();
    for (const cn of liveConnections(this.map, this.edits.layout)) {
      const a = anchorOf(this.map, cn.from), b = anchorOf(this.map, cn.to);
      if (!a || !b) continue;
      if (!this.rectOnScreen(v, a.rect) && !this.rectOnScreen(v, b.rect)) continue;
      if (edgeId(cn.from, cn.to) === sel) continue;
      drawEdge(g, v, edgeCurve(a.at, b.at), { kind: cn.kind, hovered: edgeId(cn.from, cn.to) === this.over });
    }
    if (this.drag?.kind === 'wire' && this.pointer) this.paintWire(g, v, this.drag.from, this.pointer);
    if (this.lift && this.lift.spring <= 0) drawGhost(g, v, this.lift.rect, this.lift.blocked);
    if (this.zoneGhost) drawGhost(g, v, this.zoneGhost, false);
    if (this.hiring) {
      drawGhost(g, v, this.hiring.rect, false);
      const c = { x: (this.hiring.rect.x0 + this.hiring.rect.x1) / 2, y: (this.hiring.rect.y0 + this.hiring.rect.y1) / 2 };
      if (v.z > 0.6) plate(g, v.p(c.x, c.y, 0.9), this.hiring.label, { size: 11, alpha: 0.9, lift: 1 });
    }
    if (this.placing && this.pointer) {
      const cell = this.camera.toGrid(this.pointer.x, this.pointer.y);
      const rect = this.placing.kind === 'agent'
        ? { x0: snapHalf(cell.x) - 1.25, y0: snapHalf(cell.y) - 0.65, x1: snapHalf(cell.x) + 1.25, y1: snapHalf(cell.y) + 0.65 }
        : resourceRect(this.placing.kind, { x: snapHalf(cell.x), y: snapHalf(cell.y) });
      drawGhost(g, v, rect, !!occupiedBy(this.map, rect));
    }
  }

  /** The rubber band out of a port, and the things it could legally land on. */
  private paintWire(g: G, v: View, fromId: string, at: Pt): void {
    const from = anchorOf(this.map, fromId);
    if (!from) return;
    const hit = this.pick(at.x, at.y);
    const over = hit && (hit.kind === 'thing' || hit.kind === 'port') ? hit.id : null;
    const ok = !!over && !!connectionKind(this.map, fromId, over);
    for (const cand of [...Object.values(this.map.desks), ...Object.values(this.map.resources)]) {
      if (cand.id === fromId || !connectionKind(this.map, fromId, cand.id) || !this.rectOnScreen(v, cand.rect)) continue;
      drawTargetGlow(g, v, cand.rect, { soft: cand.id !== over });
    }
    drawRubberBand(g, v, portAt(from.rect), ok && over ? anchorOf(this.map, over)!.at : this.camera.toGrid(at.x, at.y), ok);
  }

  /** The thing the owner is holding, lifted two pixels off the floor with a bigger shadow under it. */
  private paintLifted(g: G, v: View, light: Light): void {
    const l = this.lift;
    if (!l) return;
    drawLiftShadow(g, v, l.rect, light);
    g.save();
    g.translate(0, -LIFT_PX);
    for (const d of l.draw) { d.shadow?.(g, v, light); d.draw(g, v, light); }
    g.restore();
  }

  /** The `edge:` id that is selected, or null. */
  private selectedEdge(): string | null { return this.picked && this.picked.startsWith('edge:') ? this.picked : null; }

  /**
   * The controls the office puts on the floor: the selected line and its ⓧ, the messages travelling, the ports
   * and a zone's corner handles.
   *
   * All of it after the hour's multiply, for the reason the lamps are: a control that the evening can hide is not
   * a control. `ui/tokens.test.ts` holds each of them at 3:1 against the floor at noon, at dusk and at midnight.
   */
  private paintMarksOverHour(g: G, v: View, light: Light): void {
    const now = this.hooks.clock();
    const sel = this.selectedEdge();
    for (const cn of liveConnections(this.map, this.edits.layout)) {
      const a = anchorOf(this.map, cn.from), b = anchorOf(this.map, cn.to);
      if (!a || !b) continue;
      const id = edgeId(cn.from, cn.to);
      const hasPulse = this.pulses.some((p) => (p.from === cn.from && p.to === cn.to) || (p.from === cn.to && p.to === cn.from));
      if (id !== sel && !hasPulse) continue;
      if (!this.rectOnScreen(v, a.rect) && !this.rectOnScreen(v, b.rect)) continue;
      const c = edgeCurve(a.at, b.at);
      if (id === sel) { drawEdge(g, v, c, { kind: cn.kind, selected: true, light }); this.cutChip = drawCutChip(g, v, c, light); }
      for (const p of this.pulses) {
        if (!((p.from === cn.from && p.to === cn.to) || (p.from === cn.to && p.to === cn.from))) continue;
        const t = pulseT(p, now);
        if (t !== null) drawPulse(g, v, p.from === cn.from ? c : { from: c.to, ctrl: c.ctrl, to: c.from }, t, light);
      }
    }
    const z = this.picked ? this.map.zoneById[this.picked] : null;
    if (z) for (const c of quad(v, this.zoneGhost ?? z.rect, 0)) drawHandle(g, c, ACCENT[z.accent].chip);
    if (this.drag?.kind === 'thing' || this.drag?.kind === 'zone' || this.drag?.kind === 'camera') return;
    const seen = new Set<string>();
    for (const id of [this.drag?.kind === 'wire' ? this.drag.from : null, this.over, this.picked]) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const a = anchorOf(this.map, id);
      if (!a || (a.kind !== 'desk' && a.kind !== 'resource')) continue;
      drawPort(g, v, portAt(a.rect), ACCENT[a.accent].chip, { active: this.drag?.kind === 'wire' && this.drag.from === id, light });
    }
  }

  /** Is any of this footprint in the frame? Forty lines and forty rings are not worth drawing off screen. */
  private rectOnScreen(v: View, r: Rect): boolean {
    const q = quad(v, r, 0);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of q) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return x1 > -80 && x0 < v.cam.w + 80 && y1 > -80 && y0 < v.cam.h + 80;
  }

  /* ---- picking ---------------------------------------------------------------------------------------- */

  /**
   * What is under a screen point.
   *
   * The order is the whole of the rule, and it is the order of what the owner meant: the two chrome targets a
   * selection puts on the screen (a zone's handles, a line's ⓧ) come first because they exist only while
   * something is selected and are aimed at deliberately; then a port, but only on the thing the pointer is
   * already on, so a ring nobody can see cannot be grabbed by accident; then people, who always win, as they
   * always did; then the screens on the walls; then the things on the floor, nearest the camera first; then the
   * lines; then a zone's plate, and last the zone floor itself, which is what a press on open floor pans.
   */
  pick(px: number, py: number): Hit | null {
    const v = this.camera.view();
    if (this.cutChip && Math.hypot(px - this.cutChip.x, py - this.cutChip.y) <= this.cutChip.r) return { kind: 'cut', id: this.picked! };
    const handle = this.handleAt(v, px, py);
    if (handle) return handle;
    const port = this.portAtPoint(v, px, py);
    if (port) return { kind: 'port', id: port };

    const h = PERSON_H * v.cz;
    let best: { id: string; d: number } | null = null;
    for (const [role, b] of this.bodies) {
      if (!b.visible()) continue;
      const at = v.p(b.at.x, b.at.y, 0);
      if (px < at.x - h * 0.28 || px > at.x + h * 0.28 || py < at.y - h * 1.06 || py > at.y + h * 0.1) continue;
      if (!best || b.depth > best.d) best = { id: role, d: b.depth };
    }
    if (best) return { kind: 'agent', id: best.id };

    for (const s of Object.values(this.map.screens)) {
      const face = s.axis === 'x'
        ? [v.p(s.x, s.y, s.z + s.h), v.p(s.x + s.len, s.y, s.z + s.h), v.p(s.x + s.len, s.y, s.z), v.p(s.x, s.y, s.z)]
        : [v.p(s.x, s.y + s.len, s.z + s.h), v.p(s.x, s.y, s.z + s.h), v.p(s.x, s.y, s.z), v.p(s.x, s.y + s.len, s.z)];
      if (inPoly(face, px, py)) return { kind: 'screen', id: s.kind };
    }

    let thing: { id: string; node: NodeKind; d: number } | null = null;
    const tryBox = (id: string, node: NodeKind, r: Rect, hz: number): void => {
      if (!boxHit(v, r, hz, px, py)) return;
      const d = r.x1 + r.y1;
      if (!thing || d > thing.d) thing = { id, node, d };
    };
    for (const r of Object.values(this.map.resources)) tryBox(r.id, 'resource', r.rect, RESOURCE_H[r.kind]);
    for (const d of Object.values(this.map.desks)) tryBox(d.id, 'desk', d.rect, 0.72);
    for (const p of this.map.props) if (DRAGGABLE_PROPS.has(p.kind)) tryBox(p.id, 'prop', p.rect, 0.9);
    if (thing) { const t = thing as { id: string; node: NodeKind }; return { kind: 'thing', id: t.id, node: t.node }; }

    for (const cn of liveConnections(this.map, this.edits.layout)) {
      const a = anchorOf(this.map, cn.from), b = anchorOf(this.map, cn.to);
      if (!a || !b) continue;
      if (edgeHit(v, edgeCurve(a.at, b.at), px, py)) return { kind: 'edge', id: edgeId(cn.from, cn.to), a: cn.from, b: cn.to };
    }

    for (const [id, box] of Object.entries(this.plateBoxes)) {
      if (px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h) return { kind: 'zonePlate', id };
    }

    const cell = this.camera.toGrid(px, py);
    const z = zoneAt(this.map, cell);
    return z ? { kind: 'zone', id: z.id } : null;
  }

  /** A corner handle of the selected zone, in screen space. */
  private handleAt(v: View, px: number, py: number): Hit | null {
    const z = this.picked ? this.map.zoneById[this.picked] : null;
    if (!z) return null;
    const cs = quad(v, z.rect, 0);
    for (let i = 0; i < 4; i++) if (Math.hypot(px - cs[i].x, py - cs[i].y) <= HANDLE_R + 4) return { kind: 'handle', id: z.id, corner: i };
    return null;
  }

  /**
   * The port ring under the pointer, if there is one.
   *
   * Only on the thing the pointer is already over or the thing that is selected: a ring that is not drawn must
   * not be grabbable, or every desk corner on the campus would quietly stop the camera from panning.
   */
  private portAtPoint(v: View, px: number, py: number): string | null {
    for (const id of [this.over, this.picked]) {
      if (!id) continue;
      const a = anchorOf(this.map, id);
      if (!a || (a.kind !== 'desk' && a.kind !== 'resource')) continue;
      const p = v.p(portAt(a.rect).x, portAt(a.rect).y, 0.02);
      if (Math.hypot(px - p.x, py - p.y) <= PORT_HIT) return id;
    }
    return null;
  }

  /* ---- the camera, as the rest of the app drives it --------------------------------------------------- */

  /** The zone the camera is over, or `campus` on the open floor. */
  currentZone(): string { return this.zoneNow || 'campus'; }

  /** Frame a zone by id; `campus` frames the whole plate. */
  focusZone(id: string): void {
    this.prevZoom = null;
    if (id === 'campus') { this.camera.frame(slabOf(this.map), { head: 3.4 }); this.zoneNow = 'campus'; this.hooks.onZoneChange?.('campus'); return; }
    const z = this.map.zoneById[id];
    if (!z) return;
    this.camera.frame(pad(z.rect, 1.4), { head: 2.2 });
  }

  /**
   * Pan to a place: `agent:<role>`, `desk:<id>`, a screen kind, a room or a zone.
   *
   * Only a click the owner made zooms; anything the app opens by itself keeps the elevation they chose.
   */
  focusOn(name: string, opts: { zoom?: boolean } = {}): void {
    if (!this.map) { this.pendingFocus = { name, zoom: opts.zoom ?? false }; return; }
    const role = name.startsWith('agent:') ? name.slice(6) : null;
    this.selected = role;
    if (role) {
      const b = this.bodies.get(role);
      if (!b) return;
      if (opts.zoom && this.prevZoom === null) this.prevZoom = this.camera.targetZoom;
      this.camera.panTo({ x: b.at.x, y: b.at.y }, opts.zoom ? { zoom: Math.max(this.camera.targetZoom, ROOM_ZOOM + 0.25) } : {});
      return;
    }
    const r = rectOf(this.map, name);
    if (!r) { const p = standAt(this.map, name); if (p) this.camera.panTo(p); return; }
    if (opts.zoom) {
      if (this.prevZoom === null) this.prevZoom = this.camera.targetZoom;
      this.camera.frame(pad(r, 2.4), { head: 2.4 });
    } else this.camera.panTo(centre(r));
  }

  /** Undo the last `focusOn(name, { zoom: true })`, once. */
  restoreZoom(): void {
    if (this.prevZoom === null) return;
    this.camera.panTo(this.camera.targetAt, { zoom: this.prevZoom });
    this.prevZoom = null;
  }

  /** Who is in each zone right now, and how many meetings are open there (the zone rail's badges). */
  zoneSummary(): ZoneSummary[] {
    const s = this.hooks.getState();
    const out: ZoneSummary[] = [];
    for (const z of this.map.rail) {
      const rooms = new Set(Object.values(this.map.rooms).filter((r) => r.zone === z.id).map((r) => r.id));
      if (z.id === 'boardroom') for (const extra of ['ceo_office', 'meetingroom']) rooms.add(extra);
      const rects = [z.rect, ...(z.id === 'boardroom' ? [this.map.zoneById.ceo_office?.rect, this.map.zoneById.meetingroom?.rect] : [])].filter(Boolean) as Rect[];
      const agents = [...this.bodies.values()]
        .filter((b) => b.view.state !== 'offline' && rects.some((r) => inRect(r, b.at)))
        .map((b) => ({ role: b.view.role, color: divisionChip(b.view.division), state: b.view.state }));
      const meetings = Object.values(s.meetings).filter((mt) => mt.open && rooms.has(mt.room === 'board' ? 'boardroom' : mt.room === 'meeting' ? 'meetingroom' : mt.room)).length;
      out.push({ id: z.id, label: z.rail!.label, accent: z.accent, color: zoneChip(z.accent), agents, meetings });
    }
    return out;
  }

  /* ---- the console and the harnesses ------------------------------------------------------------------ */

  debugAgents(): Record<string, unknown>[] { return [...this.bodies.values()].map((b) => b.debug()); }
  debugAnchors(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const z of this.map.zones) out[z.id] = { tx: Math.round(z.rect.x0), ty: Math.round(z.rect.y0), props: { label: z.label, accent: z.accent, floor: 1 } };
    for (const r of Object.values(this.map.rooms)) out[r.id] = { tx: Math.round(r.rect.x0), ty: Math.round(r.rect.y0), props: { label: r.label, zone: r.zone, floor: 1 } };
    for (const s of Object.values(this.map.screens)) out[s.kind] = { tx: Math.round(s.x), ty: Math.round(s.y), props: { label: s.label, floor: 1, stand_x: s.stand.x, stand_y: s.stand.y } };
    return out;
  }
  debugDesks(): Record<string, { tx: number; ty: number }> {
    return Object.fromEntries(Object.values(this.map.desks).map((d) => [d.id, { tx: Math.round(d.seat.x), ty: Math.round(d.seat.y) }]));
  }
  debugStand(name: string): { tx: number; ty: number } | null {
    const p = standAt(this.map, name);
    return p ? { tx: Math.round(p.x), ty: Math.round(p.y) } : null;
  }
  /** The route a body would take to a place, as its corners. One plane, so there is only ever one leg. */
  async debugRoute(role: string, target: string): Promise<Pt[] | null> {
    const b = this.bodies.get(role);
    const dest = target === 'home' ? b?.homeAt() ?? null : standAt(this.map, target);
    if (!b || !dest) return null;
    return this.router.find(b.at, dest);
  }
  /** Set the zoom outright (the console, the shot harness). */
  setZoom(z: number): { zoom: number; at: Cell; settled: boolean } {
    this.camera.panTo(this.camera.targetAt, { zoom: z, now: true });
    return { zoom: this.camera.zoom, at: { ...this.camera.at }, settled: this.camera.settled };
  }
  /** Centre on a grid cell outright. */
  centerOn(x: number, y: number): { zoom: number; at: Cell; settled: boolean } {
    this.camera.panTo({ x, y }, { now: true });
    this.zoneNow = railZoneAt(this.map, this.camera.at)?.id ?? 'campus';
    this.hooks.onZoneChange?.(this.zoneNow);
    return { zoom: this.camera.zoom, at: { ...this.camera.at }, settled: this.camera.settled };
  }
  /** Where a grid cell lands on the screen — the click harness parks a target under a chrome element with it. */
  project(x: number, y: number, z = 0): Pt { return this.camera.toScreen(x, y, z); }
  /**
   * The screen box a node occupies — a desk, a zone, a resource or a prop.
   *
   * The harnesses need this to press on a *thing* rather than on the person sitting at it: `desks()` hands back
   * where somebody sits, and people win every hit test, so a press there is a press on them.
   */
  nodeBox(id: string): { x: number; y: number; w: number; h: number; cx: number; cy: number } | null {
    const a = anchorOf(this.map, id);
    if (!a) return null;
    const v = this.camera.view();
    const hz = a.kind === 'desk' ? 0.72 : a.kind === 'resource' ? RESOURCE_H[this.map.resources[id].kind] : 0;
    const pts = [...quad(v, a.rect, 0), ...quad(v, a.rect, hz)];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    // the middle of the floor quad, not of the whole silhouette: that is the top of the thing, where nobody stands
    const c = v.p((a.rect.x0 + a.rect.x1) / 2, (a.rect.y0 + a.rect.y1) / 2, hz * 0.5);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: c.x, cy: c.y };
  }

  /** The screen box a screen surface occupies, for the click harness. */
  screenBox(kind: string): { x: number; y: number; w: number; h: number; cx: number; cy: number } | null {
    const s = this.map.screens[kind];
    if (!s) return null;
    const v = this.camera.view();
    const face = s.axis === 'x'
      ? [v.p(s.x, s.y, s.z + s.h), v.p(s.x + s.len, s.y, s.z + s.h), v.p(s.x + s.len, s.y, s.z), v.p(s.x, s.y, s.z)]
      : [v.p(s.x, s.y + s.len, s.z + s.h), v.p(s.x, s.y, s.z + s.h), v.p(s.x, s.y, s.z), v.p(s.x, s.y + s.len, s.z)];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of face) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }
  /** What the office has under a screen point, without clicking it — the overlay gate's hit test. */
  hitAt(px: number, py: number): Hit | null { return this.pick(px, py); }
  /** Let the idle wander off for a coffee, or hold them at their desks. The shot harness holds them. */
  setCoffee(on: boolean): boolean { this.coffee = on; return this.coffee; }
  /** Whether a pointer is down on the canvas and carrying the camera. The overlay gate asserts this clears. */
  isDragging(): boolean { return this.dragging; }
  /** Whether the camera has finished easing to where it was sent. Every harness waits on this before it measures. */
  isSettled(): boolean { return this.camera.settled; }
  /** The grid cell at a screen point, for the minimap and the harness. */
  toGrid(px: number, py: number): Cell { return this.camera.toGrid(px, py); }
}

/** How far a lamp reaches for somebody to be working under it, in cells. Two desks and the walkway between them. */
const LAMP_REACH = 4.5;

interface Timing { ground: number; sort: number; world: number; screens: number; light: number; labels: number; frames: number }

const KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** Half a cell, which is what everything in the office snaps to. */
const snapHalf = (v: number): number => Math.round(v * 2) / 2;
const mix1 = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * The dressing the owner may pick up. A partition, a walkway or a window is part of the building; a plant, a
 * stool, a lamp or a shelf is furniture, and furniture moves.
 */
const DRAGGABLE_PROPS = new Set(['plant', 'stool', 'floorlamp', 'shelf', 'hightable', 'chair']);

/** What the plate beside a selected thing calls it. */
const SUB_OF: Record<string, string> = { browser: 'Browser', doc: 'Document', note: 'Sticky note', site: 'Site', station: 'Tool station' };

/** Is a screen point inside the silhouette of a box standing on the floor? Floor quad and top quad, hulled. */
function boxHit(v: View, r: Rect, hz: number, px: number, py: number): boolean {
  return inPoly(hull([...quad(v, r, 0), ...quad(v, r, hz)]), px, py);
}

const pad = (r: Rect, n: number): Rect => ({ x0: r.x0 - n, y0: r.y0 - n, x1: r.x1 + n, y1: r.y1 + n });
const centre = (r: Rect): Cell => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });

/** The same projection, shifted so a sprite can be drawn into a canvas of its own. */
export function offsetView(base: View, ox: number, oy: number): View {
  return {
    cam: base.cam, z: base.z, cw: base.cw, ch: base.ch, cz: base.cz,
    p(gx: number, gy: number, gz = 0): Pt { const q = base.p(gx, gy, gz); return { x: q.x - ox, y: q.y - oy }; },
  };
}

/** The first line of a markdown document that says something, without its hashes. */
export function headline(text: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (line && !line.startsWith('---') && !/^[a-z_]+:/.test(line)) return line.length > 42 ? `${line.slice(0, 41)}\u2026` : line;
  }
  return null;
}

/** Even-odd point in polygon. */
export function inPoly(pts: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A desk plate, for a desk nobody is sitting at. */
function plateFor(g: G, at: Pt, name: string, accent: string): void {
  plate(g, at, name, { size: 10, chip: zoneChip(accent as AccentName), alpha: 0.78, lift: 2 });
}
