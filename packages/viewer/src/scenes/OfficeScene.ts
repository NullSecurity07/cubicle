import Phaser from 'phaser';
import { makeTileset, makeLampGlow, makeSky, TILE, roleColor } from '../world/tileset.js';
import { buildWorld, floorAt, type World, type Tile } from '../world/map.js';
import { T } from '../world/tiles.js';
import { AgentSprite } from '../world/agents.js';
import { Surface } from '../world/surfaces.js';
import { SURFACES } from '../ui/surfaces.js';
import { initialElevator, request, cancel, step, type ElevatorState, type ElevatorEvent, type Rider } from '../world/elevator.js';
import { floorZoom } from '../world/camera.js';
import { planRoute, type Leg } from '../world/route.js';
import type { State } from '../state.js';
import { tintFor, nightColourFor, skyFor, lampAlphaFor, hourBucket, type HourBucket } from '../ui/time.js';
import { litRooms, roomContaining } from '../world/lights.js';
import { floorPalette, hexToInt } from '../world/palette.js';

export interface FloorSummary { floor: number; label: string; color: string; agents: { role: string; color: number; state: string }[]; meetings: number }
export interface SceneHooks {
  getState(): State; frames(): Record<string, string>; onSurfaceClick(kind: string): void; onAgentClick(role: string): void; hour(): number;
  /** wall clock live, event clock in replay (bubbles expire against it) */ clock(): number;
  /** the camera's floor changed (the floor rail highlights it) */ onFloorChange?(n: number): void;
  /** the visual layer's elevator car; a plain box when absent */ makeCar?(scene: Phaser.Scene): Phaser.GameObjects.Container;
  /** every elevator event, for the indicator and sounds */ onElevator?(ev: ElevatorEvent): void;
}

const MINIMAP = { w: 120, h: 130, margin: 10 };
const BUILDING = { x0: 4, x1: 54, y0: 2, y1: 54 };   // tiles; what the minimap frames
const SHAFT_CENTRE_X = 52.5 * TILE;                   // the car's x

/** The office: tilemap, sprites driven by the reducer state, surfaces, the elevator, camera controls, minimap, day/night. */
export class OfficeScene extends Phaser.Scene {
  private world!: World;
  private agents = new Map<string, AgentSprite>();
  private surfaces = new Map<string, Surface>();
  private night!: Phaser.GameObjects.Rectangle;
  private sky!: Phaser.GameObjects.Image;
  private skyStops = '';
  private bucket: HourBucket | null = null;
  private lamps: { img: Phaser.GameObjects.Image; room: string | null }[] = [];
  private hourOverride: number | null = null;
  private minimap!: Phaser.Cameras.Scene2D.Camera;
  private viewRect!: Phaser.GameObjects.Rectangle;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private dragging = false;
  private lastRender = 0;
  private seatIndex: Record<string, number> = {};
  private pendingFocus: string | null = null;
  private pendingFloor: number | null = null;
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

  /** Overrides the wall-clock hour (for the console/debug harness); null returns to `hooks.hour()`. */
  setHourOverride(h: number | null): void { this.hourOverride = h; }
  private hour(): number { return this.hourOverride ?? this.hooks.hour(); }

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
    makeSky(this, 'sky', skyFor(this.hour()), h);
    this.sky = this.add.image(0, 0, 'sky').setOrigin(0).setDisplaySize(w, h).setDepth(-1);
    this.night = this.add.rectangle(0, 0, w, h, nightColourFor(this.hour()), 0).setOrigin(0).setDepth(50).setScrollFactor(1);
    makeLampGlow(this);
    for (const d of this.world.decor.filter((x) => x.kind === 'lamp')) {
      const room = roomContaining(this.world.rooms, d.tile);
      const tint = hexToInt(floorPalette(d.floor).lamp);
      const img = this.add.image(d.tile.tx * TILE + TILE / 2, d.tile.ty * TILE + TILE, 'lamp-glow').setBlendMode(Phaser.BlendModes.ADD).setTint(tint).setAlpha(0).setDepth(49);
      this.lamps.push({ img, room });
    }
    // camera: drag / WASD / wheel
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => { if (p.button === 0) this.dragging = true; });
    this.input.on('pointerup', () => { this.dragging = false; });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => { if (this.dragging && p.isDown) { this.cameras.main.scrollX -= (p.x - p.prevPosition.x) / this.cameras.main.zoom; this.cameras.main.scrollY -= (p.y - p.prevPosition.y) / this.cameras.main.zoom; } });
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => { this.cameras.main.setZoom(Phaser.Math.Clamp(this.cameras.main.zoom * (dy > 0 ? 0.9 : 1.1), 0.8, 5)); });
    this.keys = this.input.keyboard!.addKeys('W,A,S,D,UP,LEFT,DOWN,RIGHT') as Record<string, Phaser.Input.Keyboard.Key>;
    // minimap: the building as a tower strip, bottom-right, with a rectangle showing where the main camera looks
    const bw = (BUILDING.x1 - BUILDING.x0 + 1) * TILE, bh = (BUILDING.y1 - BUILDING.y0 + 1) * TILE;
    const zoom = Math.min(MINIMAP.w / bw, MINIMAP.h / bh);
    this.minimap = this.cameras.add(this.scale.width - MINIMAP.w - MINIMAP.margin, this.scale.height - MINIMAP.h - MINIMAP.margin, MINIMAP.w, MINIMAP.h)
      .setZoom(zoom).setBounds(BUILDING.x0 * TILE, BUILDING.y0 * TILE, bw, bh).setBackgroundColor(0x000000).setName('minimap');
    this.minimap.centerOn(BUILDING.x0 * TILE + bw / 2, BUILDING.y0 * TILE + bh / 2);
    this.viewRect = this.add.rectangle(0, 0, 10, 10).setOrigin(0).setStrokeStyle(1 / zoom, 0xffffff, 0.9).setDepth(60);
    this.cameras.main.ignore(this.viewRect);
    this.minimap.ignore([this.night, this.sky, ...this.lamps.map((l) => l.img)]);
    this.scale.on('resize', (g: Phaser.Structs.Size) => this.minimap.setPosition(g.width - MINIMAP.w - MINIMAP.margin, g.height - MINIMAP.h - MINIMAP.margin));
    this.focusFloor(this.pendingFloor ?? 1);
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
    if (time - this.lastRender > 250) { this.lastRender = time; const fr = this.hooks.frames(); for (const su of this.surfaces.values()) su.render(s, fr); }
    // camera keys
    const cam = this.cameras.main, v = 260 * dt / cam.zoom;
    if (this.keys.A.isDown || this.keys.LEFT.isDown) cam.scrollX -= v;
    if (this.keys.D.isDown || this.keys.RIGHT.isDown) cam.scrollX += v;
    if (this.keys.W.isDown || this.keys.UP.isDown) cam.scrollY -= v;
    if (this.keys.S.isDown || this.keys.DOWN.isDown) cam.scrollY += v;
    // which floor the camera is on, for the floor rail
    const f = this.currentFloor();
    if (f !== this.lastFloor) { this.lastFloor = f; this.hooks.onFloorChange?.(f); }
    // the viewport rectangle on the minimap
    const wv = cam.worldView;
    this.viewRect.setPosition(wv.x, wv.y).setSize(wv.width, wv.height);
    // day / night
    const hour = this.hour();
    this.night.setFillStyle(nightColourFor(hour), tintFor(hour));
    const stops = skyFor(hour), stopsKey = stops.join('|');
    if (stopsKey !== this.skyStops) { this.skyStops = stopsKey; makeSky(this, 'sky', stops, this.world.height * TILE); this.sky.setTexture('sky').setDisplaySize(this.world.width * TILE, this.world.height * TILE); }
    const bucket = hourBucket(hour);
    if (bucket !== this.bucket) {
      const from = this.bucket === 'day' ? T.WINDOW_DAY : this.bucket === 'dusk' ? T.WINDOW_DUSK : this.bucket === 'night' ? T.WINDOW_NIGHT : T.WINDOW_DAY;
      const to = bucket === 'day' ? T.WINDOW_DAY : bucket === 'dusk' ? T.WINDOW_DUSK : T.WINDOW_NIGHT;
      this.world.map.getLayer('walls')!.tilemapLayer.replaceByIndex(from, to);
      this.bucket = bucket;
    }
    const lampAlpha = lampAlphaFor(hour);
    if (lampAlpha > 0) {
      const tiles: Record<string, { tx: number; ty: number }> = {};
      for (const [role, ag] of this.agents) tiles[role] = ag.tile();
      const lit = litRooms(s.agents, tiles, this.world.rooms);
      for (const l of this.lamps) l.img.setAlpha(l.room && lit.has(l.room) ? lampAlpha : 0);
    } else for (const l of this.lamps) l.img.setAlpha(0);
  }

  /** Pan to floor n at the zoom that fits one floor. */
  focusFloor(n: number): void {
    if (!this.world) { this.pendingFloor = n; return; }
    const f = this.world.floors.find((x) => x.n === n);
    if (!f) return;
    const cam = this.cameras.main;
    cam.setZoom(floorZoom(this.scale.width, this.scale.height));
    cam.pan(((BUILDING.x0 + BUILDING.x1) / 2) * TILE, (f.y0 + 7) * TILE, 350, 'Sine.easeInOut');
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

  /** Pan to `agent:<role>` (where the sprite is now), `desk:<desk id>` (its chair), or any anchor by name. */
  focusOn(name: string): void {
    if (!this.world) { this.pendingFocus = name; return; }   // the snapshot can arrive before the map has loaded
    let t: { x: number; y: number } | null = null;
    if (name.startsWith('agent:')) { const ag = this.agents.get(name.slice(6)); if (ag) t = { x: ag.container.x, y: ag.container.y }; }
    else if (name.startsWith('desk:')) { const d = this.world.desks[name.slice(5)]; if (d) t = { x: d.tx * TILE + TILE / 2, y: d.ty * TILE }; }
    else { const a = this.world.anchors[name]; if (a) t = { x: (a.tx + a.tw / 2) * TILE, y: (a.ty + a.th / 2) * TILE }; }
    if (t) this.cameras.main.pan(t.x, t.y, 400, 'Sine.easeInOut');
  }
}
