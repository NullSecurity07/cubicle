import Phaser from 'phaser';
import { makeTileset, makeDecorSheet, makeLampGlow, makeSky, makeOwnerSprite, TILE, roleColor } from '../world/tileset.js';
import { buildWorld, floorAt, type World, type Tile, type Anchor, type FloorInfo } from '../world/map.js';
import { T } from '../world/tiles.js';
import { AgentSprite } from '../world/agents.js';
import { Surface } from '../world/surfaces.js';
import { SURFACES } from '../ui/surfaces.js';
import { DecorLayer, RoomSigns } from '../world/decor.js';
import { initialElevator, request, cancel, step, type ElevatorState, type ElevatorEvent, type Rider } from '../world/elevator.js';
import { ZOOM_STEPS, zoomSnap, fitZoom, floorZoom } from '../world/camera.js';
import { skyRect, nightRect, backdropColour } from '../world/backdrop.js';
import { planRoute, type Leg } from '../world/route.js';
import type { State } from '../state.js';
import { tintFor, nightColourFor, skyFor, lampAlphaFor, hourBucket, type HourBucket } from '../ui/time.js';
import { litRooms, roomContaining } from '../world/lights.js';
import { PALETTE, floorPalette, hexToInt } from '../world/palette.js';
import { DUR, EASE, dur } from '../world/motion.js';
import { OwnerAvatar, boardSessionOpen } from '../world/owner.js';

export interface FloorSummary { floor: number; label: string; color: string; agents: { role: string; color: number; state: string }[]; meetings: number }
export interface SceneHooks {
  getState(): State; frames(): Record<string, string>; onSurfaceClick(kind: string): void; onAgentClick(role: string): void; hour(): number;
  /** wall clock live, event clock in replay (bubbles expire against it) */ clock(): number;
  /** the camera's floor changed (the floor rail highlights it) */ onFloorChange?(n: number): void;
  /** the visual layer's elevator car; a plain box when absent */ makeCar?(scene: Phaser.Scene, geo: { shaft: Anchor; floors: FloorInfo[] }): Phaser.GameObjects.Container;
  /** the car's own doors/digits (main-camera only — the minimap would otherwise show them as amber smudges) */ elevatorIgnorables?(): Phaser.GameObjects.GameObject[];
  /** every elevator event, for the indicator and sounds */ onElevator?(ev: ElevatorEvent): void;
  /** the scene's `Phaser.Scenes.Events.SHUTDOWN` fired — the visual layer disposes what it created in `makeCar` */ onSceneShutdown?(): void;
}

export const BUILDING = { x0: 4, x1: 54, y0: 2, y1: 54 } as const;   // tiles, inclusive; what the minimap frames
const SHAFT_CENTRE_X = 52.5 * TILE;                   // the car's x

/** The office: tilemap, sprites driven by the reducer state, surfaces, the elevator, camera controls, minimap, day/night. */
export class OfficeScene extends Phaser.Scene {
  private world!: World;
  private agents = new Map<string, AgentSprite>();
  private surfaces = new Map<string, Surface>();
  private night!: Phaser.GameObjects.Rectangle;
  private sky: Phaser.GameObjects.Image | null = null;
  private skyStops = '';
  private skyStep = NaN;
  private readonly tiles: Record<string, Tile> = {};   // one record reused every frame: the decor and lamp passes both read it
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
  private prevZoom: number | null = null;
  private elev!: ElevatorState;
  private car!: Phaser.GameObjects.Container;
  private lastFloor = 0;
  private decor!: DecorLayer;
  private signs!: RoomSigns;
  private owner: OwnerAvatar | null = null;
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
    makeDecorSheet(this);
    this.decor = new DecorLayer(this, this.world.decor);
    this.signs = new RoomSigns(this, this.world.signs);
    this.elev = initialElevator(this.world.floors, 1);
    // Phaser calls `scene.sys.shutdown()`, never a `shutdown()` method on the Scene itself — it emits this event on
    // `this.events`, which is only guaranteed to exist once we're inside a lifecycle callback like `create()`.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      // Surfaces own a forever-tween and two base64 textures keyed by kind: both outlive a scene restart unless
      // the surface disposes of them here (the sprites' own tweens go the same way).
      for (const su of this.surfaces.values()) su.destroy();
      this.surfaces.clear();
      for (const ag of this.agents.values()) ag.destroy();
      this.agents.clear();
      this.hooks.onSceneShutdown?.();
    });
    this.car = (this.hooks.makeCar?.(this, { shaft: this.world.anchors.shaft, floors: this.world.floors }) ?? this.defaultCar()).setDepth(3);
    this.car.setPosition(SHAFT_CENTRE_X, this.elev.row * TILE);
    // The sky is screen-space: sized to the world it left a slab of page background either side of the tower at
    // every zoom, and that slab never darkened. At scrollFactor 0 it is the surround, so the surround is the sky.
    this.applySky(skyFor(this.hour()));
    // The night tint covers the building only. Over the sky as well it multiplied the designed night gradient
    // down to near-black; the sky's own night stops are the night sky.
    const nr = nightRect(BUILDING, TILE);
    this.night = this.add.rectangle(nr.x, nr.y, nr.width, nr.height, nightColourFor(this.hour()), 0).setOrigin(0).setDepth(50).setScrollFactor(1);
    makeLampGlow(this);
    for (const d of this.world.decor.filter((x) => x.kind === 'lamp')) {
      const room = roomContaining(this.world.rooms, d.tile);
      const tint = hexToInt(floorPalette(d.floor).lamp);
      const img = this.add.image(d.tile.tx * TILE + TILE / 2, d.tile.ty * TILE + TILE, 'lamp-glow').setBlendMode(Phaser.BlendModes.ADD).setTint(tint).setAlpha(0).setDepth(51);   // above the night rect (50): a glow multiplied down by the very tint it exists to punch through reads as nothing at all
      this.lamps.push({ img, room });
    }
    // camera: drag / WASD / wheel
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => { if (p.button === 0) this.dragging = true; });
    this.input.on('pointerup', () => { this.dragging = false; });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => { if (this.dragging && p.isDown) { this.cameras.main.scrollX -= (p.x - p.prevPosition.x) / this.cameras.main.zoom; this.cameras.main.scrollY -= (p.y - p.prevPosition.y) / this.cameras.main.zoom; } });
    this.input.on('wheel', (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => { this.zoomAbout(zoomSnap(this.cameras.main.zoom, dy > 0 ? -1 : 1), p.x, p.y); });
    // `0` is bound once, in ui/keys.ts, and calls `fitTower()` here. A second binding in this scene meant one
    // keypress ran two different fit implementations that then fought over the camera.
    this.keys = this.input.keyboard!.addKeys('W,A,S,D,UP,LEFT,DOWN,RIGHT') as Record<string, Phaser.Input.Keyboard.Key>;
    // minimap: the building as a portrait tower strip, bottom-right, with a rectangle showing where the main camera looks
    const bw = (BUILDING.x1 - BUILDING.x0 + 1) * TILE, bh = (BUILDING.y1 - BUILDING.y0 + 1) * TILE;
    const mmH = 160, mmW = Math.round(mmH * bw / bh);
    this.minimap = this.cameras.add(this.scale.width - mmW - 12, this.scale.height - mmH - 12, mmW, mmH)
      .setZoom(Math.min(mmW / bw, mmH / bh)).setBounds(BUILDING.x0 * TILE, BUILDING.y0 * TILE, bw, bh).setBackgroundColor(hexToInt(PALETTE.minimapBg)).setName('minimap');
    this.minimap.centerOn((BUILDING.x0 + BUILDING.x1 + 1) / 2 * TILE, (BUILDING.y0 + BUILDING.y1 + 1) / 2 * TILE);
    this.viewRect = this.add.rectangle(0, 0, 1, 1, hexToInt(PALETTE.wipe), 0).setStrokeStyle(2 / this.minimap.zoom, hexToInt(PALETTE.amber), 0.9).setOrigin(0).setDepth(60);
    this.cameras.main.ignore(this.viewRect);
    // The minimap does NOT ignore the night rect: the tower it frames has to read as night when the office is
    // night (ruling F3). It does ignore the sky, which is screen-space and would simply fill the little camera.
    this.minimap.ignore([this.sky!, ...this.lamps.map((l) => l.img), ...this.decor.images(), ...this.signs.texts, ...(this.hooks.elevatorIgnorables?.() ?? [])]);
    this.scale.on('resize', (g: Phaser.Structs.Size) => { this.minimap.setPosition(g.width - mmW - 12, g.height - mmH - 12); this.applySky(skyFor(this.hour())); });
    // the owner's avatar: seated in the owner chair, shown only while a board meeting is open
    const ownerTile = this.world.reserved.owner;
    if (ownerTile) { this.owner = new OwnerAvatar(this, ownerTile, makeOwnerSprite(this)); this.minimap.ignore(this.owner.container); }
    this.focusFloor(this.pendingFloor ?? 1, this.pendingFloor === null ? 2 : undefined);   // default zoom 2, opened on F1
    this.pendingFloor = null;
    if (this.pendingFocus) { const f = this.pendingFocus; this.pendingFocus = null; this.focusOn(f); }
  }

  /**
   * (Re)draw the sky gradient and stretch it over the whole viewport. `sky` is a screen-space image, so this is
   * the only thing that has to happen on a resize, an hour change or a theme change for the surround to follow.
   */
  private applySky(stops: [string, string]): void {
    this.skyStops = stops.join('|');
    const r = skyRect(this.scale.width, this.scale.height);
    makeSky(this, 'sky', stops, r.height);
    if (!this.sky) this.sky = this.add.image(0, 0, 'sky').setOrigin(0).setScrollFactor(0).setDepth(-10);
    this.sky.setTexture('sky').setPosition(r.x, r.y).setDisplaySize(r.width, r.height);
    // The canvas clear colour can only show for the frame before the texture exists — which is exactly the white
    // flash the review caught — so it follows the horizon rather than the page theme.
    this.cameras.main.setBackgroundColor(backdropColour(stops));
  }

  /** A grey box with a strip of glass: enough to see the ride until plan 2 draws the real car. */
  private defaultCar(): Phaser.GameObjects.Container {
    const w = 3 * TILE - 4, h = 3 * TILE - 4;
    const box = this.add.rectangle(0, 2, w, h, hexToInt(PALETTE.steel), 1).setOrigin(0.5, 0).setStrokeStyle(2, hexToInt(PALETTE.screenFrame), 1);
    const glass = this.add.rectangle(0, 6, w - 8, 10, hexToInt(PALETTE.glassLit), 0.5).setOrigin(0.5, 0);
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
    this.owner?.setVisible(boardSessionOpen(s.meetings));
    // each role's current tile, shared by the decor layer's occupancy checks and the lamp block's lit-rooms check
    const tiles = this.tiles;
    for (const k of Object.keys(tiles)) if (!this.agents.has(k)) delete tiles[k];
    for (const [role, ag] of this.agents) tiles[role] = ag.tile();
    this.decor.update(this.hooks.clock(), s.agents, tiles);
    // surfaces at ~4 fps
    if (time - this.lastRender > 250) { this.lastRender = time; const fr = this.hooks.frames(); for (const su of this.surfaces.values()) su.render(s, fr, this.hooks.clock()); }
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
    // The sky is only re-rasterised when the gradient actually changes. `skyFor` allocates, so it is asked once
    // per tenth of an hour rather than once per frame (a ten-minute step is finer than the gradient's own ramps).
    const skyStep = Math.round(hour * 10);
    if (skyStep !== this.skyStep) { this.skyStep = skyStep; const stops = skyFor(hour); if (stops.join('|') !== this.skyStops) this.applySky(stops); }
    const bucket = hourBucket(hour);
    if (bucket !== this.bucket) {
      const from = this.bucket === 'day' ? T.WINDOW_DAY : this.bucket === 'dusk' ? T.WINDOW_DUSK : this.bucket === 'night' ? T.WINDOW_NIGHT : T.WINDOW_DAY;
      const to = bucket === 'day' ? T.WINDOW_DAY : bucket === 'dusk' ? T.WINDOW_DUSK : T.WINDOW_NIGHT;
      this.world.map.getLayer('walls')!.tilemapLayer.replaceByIndex(from, to);
      this.bucket = bucket;
    }
    const lampAlpha = lampAlphaFor(hour);
    if (lampAlpha > 0) {
      const lit = litRooms(s.agents, tiles, this.world.rooms);
      for (const l of this.lamps) l.img.setAlpha(l.room && lit.has(l.room) ? lampAlpha : 0);
    } else for (const l of this.lamps) l.img.setAlpha(0);
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
