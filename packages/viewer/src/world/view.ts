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
import { type AccentName, type Light, MATERIAL as M, divisionChip, lampStrength, lightAt, rgba, zoneChip } from './materials.js';
import { type G, PLATES, plate } from './shapes.js';
import type { Drawable } from './props.js';
import {
  type CampusMap, type Router, type Seat, inRect, makeRouter, parseCampus, railZoneAt, rectOf, standAt, zoneAt,
} from './campus.js';
import { Camera, CHROME, ROOM_ZOOM, fitZoom, nameLabelVisible, worldTextVisible } from './camera.js';
import { type ScreenContent, buildProps, buildScreens, campusClip, paintGround, paintHour, paintZonePlates, slabOf } from './paint.js';
import { Body, type BodyContext } from './people.js';
import { drawMinimap } from './minimap-draw.js';
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
}

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
    this.map = parseCampus(await res.json());
    this.router = makeRouter(this.map);
    this.props = buildProps(this.map).sort((a, b) => a.d - b.d);
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

  private bind(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      this.dragging = true; this.dragMoved = 0; this.dragFrom = { x: e.clientX, y: e.clientY };
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      if (this.dragging && this.dragFrom) {
        const dx = e.clientX - this.dragFrom.x, dy = e.clientY - this.dragFrom.y;
        this.dragFrom = { x: e.clientX, y: e.clientY };
        this.dragMoved += Math.abs(dx) + Math.abs(dy);
        this.camera.nudge(dx, dy);
        return;
      }
      const hit = this.pick(e.clientX - r.left, e.clientY - r.top);
      const role = hit?.kind === 'agent' ? hit.id : null;
      if (role !== this.hovered) { this.hovered = role; c.style.cursor = hit ? 'pointer' : 'grab'; }
    });
    const end = (e: PointerEvent): void => {
      if (!this.dragging) return;
      this.dragging = false;
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      if (this.dragMoved > 6) return;                       // a drag, not a click
      const r = c.getBoundingClientRect();
      const hit = this.pick(e.clientX - r.left, e.clientY - r.top);
      if (hit?.kind === 'agent') this.hooks.onAgentClick(hit.id);
      else if (hit?.kind === 'screen') this.hooks.onSurfaceClick(hit.id);
      else if (hit?.kind === 'zone') this.hooks.onSurfaceClick(hit.id);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
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

  /* ---- the frame -------------------------------------------------------------------------------------- */

  private frame(now: number): void {
    this.raf = requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.frameTimes.push(now);
    if (this.frameTimes.length > 30) this.frameTimes.shift();
    if (this.canvas.width !== Math.round(this.parent.clientWidth * this.dpr)) this.resize();

    // WASD / arrows, at a constant screen speed whatever the zoom
    let kx = 0, ky = 0;
    if (this.keys.has('a') || this.keys.has('A') || this.keys.has('ArrowLeft')) kx += 1;
    if (this.keys.has('d') || this.keys.has('D') || this.keys.has('ArrowRight')) kx -= 1;
    if (this.keys.has('w') || this.keys.has('W') || this.keys.has('ArrowUp')) ky += 1;
    if (this.keys.has('s') || this.keys.has('S') || this.keys.has('ArrowDown')) ky -= 1;
    if (kx || ky) this.camera.nudge(kx * 540 * dt, ky * 540 * dt);

    this.camera.step(dt);
    this.tick(dt);
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
    for (const it of items) {
      if (it.kind === 'body') { it.body!.shadow(g, v, light); it.body!.draw(g, v, light); continue; }
      if (it.kind === 'screen') { const s0 = performance.now(); it.prop!.draw(g, v, light); t.screens += performance.now() - s0; continue; }
      budget -= this.blit(g, v, light, it.prop!, budget > 0) ? 1 : 0;
    }
    g.restore();
    t.world += performance.now() - mark; mark = performance.now();

    paintHour(g, v, this.map, light);
    this.paintLamps(g, v);
    lap('light');

    // pass 5: UI type, in screen space, over everything
    const ctx: BodyContext = { speaker: null, selected: this.selected, hovered: this.hovered };
    if (worldTextVisible(cam.zoom)) for (const b of this.bodies.values()) b.drawLabel(g, v, ctx);
    paintZonePlates(g, v, this.map, { current: this.zoneNow });
    if (nameLabelVisible(cam.zoom)) this.paintDeskPlates(g, v);
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

  /* ---- picking ---------------------------------------------------------------------------------------- */

  /** What is under a screen point: the nearest person, else a screen, else the zone the floor belongs to. */
  pick(px: number, py: number): { kind: 'agent' | 'screen' | 'zone'; id: string } | null {
    const v = this.camera.view();
    const h = PERSON_H * v.cz;
    let best: { kind: 'agent'; id: string; d: number } | null = null;
    for (const [role, b] of this.bodies) {
      if (!b.visible()) continue;
      const at = v.p(b.at.x, b.at.y, 0);
      if (px < at.x - h * 0.28 || px > at.x + h * 0.28 || py < at.y - h * 1.06 || py > at.y + h * 0.1) continue;
      if (!best || b.depth > best.d) best = { kind: 'agent', id: role, d: b.depth };
    }
    if (best) return { kind: 'agent', id: best.id };
    for (const s of Object.values(this.map.screens)) {
      const face = s.axis === 'x'
        ? [v.p(s.x, s.y, s.z + s.h), v.p(s.x + s.len, s.y, s.z + s.h), v.p(s.x + s.len, s.y, s.z), v.p(s.x, s.y, s.z)]
        : [v.p(s.x, s.y + s.len, s.z + s.h), v.p(s.x, s.y, s.z + s.h), v.p(s.x, s.y, s.z), v.p(s.x, s.y + s.len, s.z)];
      if (inPoly(face, px, py)) return { kind: 'screen', id: s.kind };
    }
    const cell = this.camera.toGrid(px, py);
    const z = zoneAt(this.map, cell);
    return z ? { kind: 'zone', id: z.id } : null;
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
  hitAt(px: number, py: number): { kind: 'agent' | 'screen' | 'zone'; id: string } | null { return this.pick(px, py); }
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

const KEYS = new Set(['w', 'a', 's', 'd', 'W', 'A', 'S', 'D', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

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
