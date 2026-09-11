import Phaser from 'phaser';
import { makeTileset, TILE, roleColor } from '../world/tileset.js';
import { buildWorld, floorAt, type World, type Tile } from '../world/map.js';
import { AgentSprite } from '../world/agents.js';
import { Surface } from '../world/surfaces.js';
import { SURFACES } from '../ui/surfaces.js';
import { initialElevator, request, cancel, step, type ElevatorState, type ElevatorEvent, type Rider } from '../world/elevator.js';
import { ZOOM_STEPS, zoomSnap, fitZoom, floorZoom } from '../world/camera.js';
import { planRoute, type Leg } from '../world/route.js';
import type { State } from '../state.js';
import { tintFor } from '../ui/time.js';
import { DUR, EASE, dur } from '../world/motion.js';

export interface FloorSummary { floor: number; label: string; color: string; agents: { role: string; color: number; state: string }[]; meetings: number }
export interface SceneHooks {
  getState(): State; frames(): Record<string, string>; onSurfaceClick(kind: string): void; onAgentClick(role: string): void; hour(): number;
  /** wall clock live, event clock in replay (bubbles expire against it) */ clock(): number;
  /** the camera's floor changed (the floor rail highlights it) */ onFloorChange?(n: number): void;
  /** the visual layer's elevator car; a plain box when absent */ makeCar?(scene: Phaser.Scene): Phaser.GameObjects.Container;
  /** every elevator event, for the indicator and sounds */ onElevator?(ev: ElevatorEvent): void;
}

export const BUILDING = { x0: 4, x1: 54, y0: 2, y1: 54 } as const;   // tiles, inclusive; what the minimap frames
const SHAFT_CENTRE_X = 52.5 * TILE;                   // the car's x

/** The office: tilemap, sprites driven by the reducer state, surfaces, the elevator, camera controls, minimap, day/night. */
export class OfficeScene extends Phaser.Scene {
  private world!: World;
  private agents = new Map<string, AgentSprite>();
  private surfaces = new Map<string, Surface>();
  private night!: Phaser.GameObjects.Rectangle;
  private minimap!: Phaser.Cameras.Scene2D.Camera;
  private viewRect!: Phaser.GameObjects.Rectangle;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private dragging = false;
  private lastRender = 0;
  private seatIndex: Record<string, number> = {};
  private pendingFocus: string | null = null;
  private pendingFloor: number | null = null;
  private prevZoom: number | null = null;
  private elev!: ElevatorState;
  private car!: Phaser.GameObjects.Container;
  private lastFloor = 0;
  hooks!: SceneHooks;
  /** The elevator: sprites call and cancel, the overlay reads the state. */
  readonly elevator = {
    state: (): ElevatorState => this.elev,
    request: (r: Rider): void => { this.elev = request(this.elev, r); },
    cancel: (id: string): void => { this.elev = cancel(this.elev, id); },
  };

  constructor() { super('office'); }

  preload(): void { this.load.tilemapTiledJSON('office', '/office.json'); }

  create(): void {
    makeTileset(this);
    this.world = buildWorld(this, 'office');
    const w = this.world.width * TILE, h = this.world.height * TILE;
    this.cameras.main.setBounds(-64, -64, w + 128, h + 128).setRoundPixels(true);
    // One Surface per registry entry that has an anchor of the same name: placing a tile is all a new one needs.
    for (const def of Object.values(SURFACES)) {
      const a = this.world.anchors[def.kind];
      if (!a) { console.warn(`[office] surface "${def.kind}" has no anchor in the map; not placed`); continue; }
      this.surfaces.set(def.kind, new Surface(this, def, a, (k) => this.hooks.onSurfaceClick(k)));
    }
    this.elev = initialElevator(this.world.floors, 1);
    this.car = (this.hooks.makeCar?.(this) ?? this.defaultCar()).setDepth(3);
    this.car.setPosition(SHAFT_CENTRE_X, this.elev.row * TILE);
    this.night = this.add.rectangle(0, 0, w, h, 0x0a1030, 0).setOrigin(0).setDepth(50).setScrollFactor(1);
    // camera: drag / WASD / wheel
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => { if (p.button === 0) this.dragging = true; });
    this.input.on('pointerup', () => { this.dragging = false; });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => { if (this.dragging && p.isDown) { this.cameras.main.scrollX -= (p.x - p.prevPosition.x) / this.cameras.main.zoom; this.cameras.main.scrollY -= (p.y - p.prevPosition.y) / this.cameras.main.zoom; } });
    this.input.on('wheel', (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => { this.zoomAbout(zoomSnap(this.cameras.main.zoom, dy > 0 ? -1 : 1), p.x, p.y); });
    this.keys = this.input.keyboard!.addKeys('W,A,S,D,UP,LEFT,DOWN,RIGHT,ZERO') as Record<string, Phaser.Input.Keyboard.Key>;
    // minimap: the building as a portrait tower strip, bottom-right, with a rectangle showing where the main camera looks
    const bw = (BUILDING.x1 - BUILDING.x0 + 1) * TILE, bh = (BUILDING.y1 - BUILDING.y0 + 1) * TILE;
    const mmH = 160, mmW = Math.round(mmH * bw / bh);
    this.minimap = this.cameras.add(this.scale.width - mmW - 12, this.scale.height - mmH - 12, mmW, mmH)
      .setZoom(Math.min(mmW / bw, mmH / bh)).setBounds(BUILDING.x0 * TILE, BUILDING.y0 * TILE, bw, bh).setBackgroundColor(0x0e1014).setName('minimap');
    this.minimap.centerOn((BUILDING.x0 + BUILDING.x1 + 1) / 2 * TILE, (BUILDING.y0 + BUILDING.y1 + 1) / 2 * TILE);
    this.viewRect = this.add.rectangle(0, 0, 1, 1, 0xffffff, 0).setStrokeStyle(2 / this.minimap.zoom, 0xe6a93c, 0.9).setOrigin(0).setDepth(60);
    this.cameras.main.ignore(this.viewRect);
    this.minimap.ignore(this.night);
    this.scale.on('resize', (g: Phaser.Structs.Size) => this.minimap.setPosition(g.width - mmW - 12, g.height - mmH - 12));
    this.focusFloor(this.pendingFloor ?? 1, this.pendingFloor === null ? 2 : undefined);   // default zoom 2, opened on F1
    this.pendingFloor = null;
    if (this.pendingFocus) { const f = this.pendingFocus; this.pendingFocus = null; this.focusOn(f); }
  }

  /** A grey box with a strip of glass: enough to see the ride until plan 2 draws the real car. */
  private defaultCar(): Phaser.GameObjects.Container {
    const w = 3 * TILE - 4, h = 3 * TILE - 4;
    const box = this.add.rectangle(0, 2, w, h, 0x8a94a8, 1).setOrigin(0.5, 0).setStrokeStyle(2, 0x343a48, 1);
    const glass = this.add.rectangle(0, 6, w - 8, 10, 0x5ad1ff, 0.5).setOrigin(0.5, 0);
    return this.add.container(0, 0, [box, glass]);
  }

  /** The next free seat in `room`, round-robin; null when the room has no seats. */
  takeSeat(room: string): Tile | null {
    const seats = this.world.seats[room] ?? [];
    if (!seats.length) return null;
    const i = (this.seatIndex[room] = ((this.seatIndex[room] ?? -1) + 1) % seats.length);
    return seats[i];
  }
  /** Give `role` a seat in `room` for a meeting (any room with seats: boardroom, meetingroom, pantry). */
  assignSeat(role: string, room: string): Tile | null {
    const seat = this.takeSeat(room);
    const ag = this.agents.get(role);
    if (ag && seat) ag.seat = seat;
    return seat;
  }

  update(time: number, deltaMs: number): void {
    const s = this.hooks.getState();
    const dt = Math.min(deltaMs, 100) / 1000;
    // the elevator first, so a sprite that boards this frame is hidden before it is drawn
    const stepped = step(this.elev, Math.min(deltaMs, 100), this.world.floors);
    this.elev = stepped.state;
    this.car.setPosition(SHAFT_CENTRE_X, this.elev.row * TILE);
    for (const ev of stepped.events) {
      if (ev.kind === 'boarded' || ev.kind === 'arrived') this.agents.get(ev.id)?.onElevator(ev, this.car);
      this.hooks.onElevator?.(ev);
    }
    // sprites; whoever is talking with a speech bubble is the one the seated others glance at
    const talking = Object.values(s.agents).find((v) => v.state === 'talking' && v.bubble?.kind === 'speech');
    const talkingSprite = talking ? this.agents.get(talking.role) : undefined;
    const ctx = { speaker: talkingSprite ? { x: talkingSprite.container.x, y: talkingSprite.container.y, role: talking!.role } : null };
    for (const [role, view] of Object.entries(s.agents)) {
      let ag = this.agents.get(role);
      if (!ag) {
        ag = new AgentSprite(this, this.world, view, (r) => this.hooks.onAgentClick(r), { elevator: this.elevator, seatFor: (_r, room) => this.takeSeat(room) });
        this.agents.set(role, ag);
        // The sprite (with its bubbles, labels and emotes) is main-camera only; the minimap shows its dot instead,
        // sized in minimap pixels so it stays legible however large the map is.
        this.minimap.ignore(ag.container);
        this.cameras.main.ignore(ag.dot);
        ag.dot.setScale(1 / this.minimap.zoom);
      }
      if (view.target && this.world.seats[view.target] && !ag.seat) this.assignSeat(role, view.target);
      if (!view.target && ag.seat) ag.seat = null;
      ag.update(view, dt, this.hooks.clock(), ctx);
    }
    for (const [role, ag] of this.agents) if (!s.agents[role]) { ag.destroy(); this.agents.delete(role); }
    // surfaces at ~4 fps
    if (time - this.lastRender > 250) { this.lastRender = time; const fr = this.hooks.frames(); for (const su of this.surfaces.values()) su.render(s, fr, this.hooks.clock()); }
    // camera keys
    const cam = this.cameras.main, v = 260 * dt / cam.zoom;
    if (this.keys.A.isDown || this.keys.LEFT.isDown) cam.scrollX -= v;
    if (this.keys.D.isDown || this.keys.RIGHT.isDown) cam.scrollX += v;
    if (this.keys.W.isDown || this.keys.UP.isDown) cam.scrollY -= v;
    if (this.keys.S.isDown || this.keys.DOWN.isDown) cam.scrollY += v;
    if (Phaser.Input.Keyboard.JustDown(this.keys.ZERO)) this.fitTower();
    // which floor the camera is on, for the floor rail
    const f = this.currentFloor();
    if (f !== this.lastFloor) { this.lastFloor = f; this.hooks.onFloorChange?.(f); }
    // the viewport rectangle on the minimap
    const wv = cam.worldView;
    this.viewRect.setPosition(wv.x, wv.y).setSize(wv.width, wv.height);
    // day / night
    this.night.setAlpha(tintFor(this.hooks.hour()));
  }

  /** Tween the zoom while keeping the world point under (px, py) fixed. */
  zoomAbout(target: number, px: number, py: number): void {
    const cam = this.cameras.main;
    if (Math.abs(cam.zoom - target) < 1e-3) return;
    const wp = cam.getWorldPoint(px, py);
    this.tweens.killTweensOf(cam);
    this.tweens.add({ targets: cam, zoom: target, duration: dur(DUR.zoom), ease: EASE.out, onUpdate: () => { const now = cam.getWorldPoint(px, py); cam.scrollX += wp.x - now.x; cam.scrollY += wp.y - now.y; } });
  }

  /** The whole tower in view: the one place a fractional zoom is allowed. */
  fitTower(): void {
    const cam = this.cameras.main;
    const bw = (BUILDING.x1 - BUILDING.x0 + 1) * TILE, bh = (BUILDING.y1 - BUILDING.y0 + 1) * TILE;
    const z = Math.max(0.25, fitZoom(this.scale.width, this.scale.height, bw + 2 * TILE, bh + 2 * TILE));
    this.prevZoom = null;
    cam.pan((BUILDING.x0 + BUILDING.x1 + 1) / 2 * TILE, (BUILDING.y0 + BUILDING.y1 + 1) / 2 * TILE, dur(DUR.pan), EASE.inOut);
    cam.zoomTo(z, dur(DUR.pan), EASE.inOut);
  }

  /** Pan to a floor; fit it (camera.ts floorZoom: 85 % of the viewport, snapped down) unless a zoom is given. */
  focusFloor(n: number, zoom?: number): void {
    if (!this.world) { this.pendingFloor = n; return; }
    const f = this.world.floors.find((x) => x.n === n) ?? this.world.floors[0];
    const z = zoom ?? floorZoom(this.scale.width, this.scale.height);
    const cam = this.cameras.main;
    cam.pan((BUILDING.x0 + BUILDING.x1 + 1) / 2 * TILE, (f.y0 + 7) * TILE, dur(DUR.pan), EASE.inOut);
    cam.zoomTo(z, dur(DUR.pan), EASE.inOut);
  }
  currentFloor(): number { return this.world ? floorAt(this.world, Math.floor(this.cameras.main.midPoint.y / TILE)) : 1; }
  /** Who is on each floor right now, and how many meetings are open there (the floor rail's badges). */
  floorSummary(): FloorSummary[] {
    const s = this.hooks.getState();
    const roomFloor = (room: string): number => Number(this.world.rooms[room === 'board' ? 'boardroom' : room === 'meeting' ? 'meetingroom' : room]?.props.floor ?? 1);
    return this.world.floors.map((f) => ({
      floor: f.n, label: f.label, color: f.color,
      agents: [...this.agents.values()].filter((a) => a.view.state !== 'offline' && floorAt(this.world, a.tile().ty) === f.n).map((a) => ({ role: a.view.role, color: roleColor(a.view.role), state: a.view.state })),
      meetings: Object.values(s.meetings).filter((m) => m.open && roomFloor(m.room) === f.n).length,
    }));
  }

  debugAgents(): Record<string, unknown>[] { return [...this.agents.values()].map((a) => a.debug()); }
  debugAnchors(): Record<string, unknown> { return Object.fromEntries(Object.entries(this.world.anchors).map(([k, a]) => [k, { tx: a.tx, ty: a.ty, props: a.props }])); }
  debugDesks(): Record<string, { tx: number; ty: number }> { return { ...this.world.desks }; }
  debugStand(name: string): { tx: number; ty: number } | null { return this.world.standTile(name); }
  /** The legs a sprite would take to `target` from where it stands now (for the console and the overlay). */
  debugRoute(role: string, target: string): Leg[] | null {
    const ag = this.agents.get(role);
    const dest = target === 'home' ? ag?.homeTile() ?? null : this.world.standTile(target);
    return ag && dest ? planRoute(this.world, ag.tile(), dest) : null;
  }

  /** Where `agent:<role>` (its sprite), `desk:<desk id>` (its chair), or any anchor by name resolves to. */
  private targetOf(name: string): { x: number; y: number } | null {
    if (name.startsWith('agent:')) { const ag = this.agents.get(name.slice(6)); return ag ? { x: ag.container.x, y: ag.container.y } : null; }
    if (name.startsWith('desk:')) { const d = this.world.desks[name.slice(5)]; return d ? { x: d.tx * TILE + TILE / 2, y: d.ty * TILE } : null; }
    const a = this.world.anchors[name];
    return a ? { x: (a.tx + a.tw / 2) * TILE, y: (a.ty + a.th / 2) * TILE } : null;
  }

  /** Pan to a place; with `zoom`, remember the current zoom once and go to 3 (restored by `restoreZoom`). */
  focusOn(name: string, opts: { zoom?: boolean } = {}): void {
    if (!this.world) { this.pendingFocus = name; return; }   // the snapshot can arrive before the map has loaded
    const t = this.targetOf(name);
    if (!t) return;
    const cam = this.cameras.main;
    cam.pan(t.x, t.y, dur(DUR.pan), EASE.inOut);
    if (opts.zoom) { if (this.prevZoom === null) this.prevZoom = (ZOOM_STEPS as readonly number[]).includes(cam.zoom) ? cam.zoom : 2; cam.zoomTo(3, dur(DUR.pan), EASE.inOut); }
  }

  /** Undo the last `focusOn(name, { zoom: true })`, once. */
  restoreZoom(): void {
    if (this.prevZoom === null) return;
    this.cameras.main.zoomTo(this.prevZoom, dur(DUR.zoom), EASE.out);
    this.prevZoom = null;
  }
}
