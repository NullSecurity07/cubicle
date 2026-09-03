import Phaser from 'phaser';
import { makeTileset, TILE } from '../world/tileset.js';
import { buildWorld, type World } from '../world/map.js';
import { AgentSprite } from '../world/agents.js';
import { Surface } from '../world/surfaces.js';
import { SURFACES } from '../world/surface-registry.js';
import type { State } from '../state.js';

export interface SceneHooks { getState(): State; frames(): Record<string, string>; onSurfaceClick(kind: string): void; onAgentClick(role: string): void; hour(): number; /** wall clock live, event clock in replay (bubbles expire against it) */ clock(): number; }

/** The office: tilemap, sprites driven by the reducer state, surfaces, camera controls, minimap, day/night. */
export class OfficeScene extends Phaser.Scene {
  private world!: World;
  private agents = new Map<string, AgentSprite>();
  private surfaces = new Map<string, Surface>();
  private night!: Phaser.GameObjects.Rectangle;
  private minimap!: Phaser.Cameras.Scene2D.Camera;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private dragging = false;
  private lastRender = 0;
  private seatIndex: Record<string, number> = {};
  private pendingFocus: string | null = null;
  hooks!: SceneHooks;

  constructor() { super('office'); }

  preload(): void { this.load.tilemapTiledJSON('office', '/office.json'); }

  create(): void {
    makeTileset(this);
    this.world = buildWorld(this, 'office');
    const w = this.world.width * TILE, h = this.world.height * TILE;
    this.cameras.main.setBounds(-64, -64, w + 128, h + 128).setZoom(2.2).centerOn(w * 0.4, h * 0.4).setRoundPixels(true);
    // One Surface per registry entry that has an anchor of the same name: placing a tile is all a new one needs.
    for (const def of Object.values(SURFACES)) {
      const a = this.world.anchors[def.kind];
      if (!a) { console.warn(`[office] surface "${def.kind}" has no anchor in the map; not placed`); continue; }
      this.surfaces.set(def.kind, new Surface(this, def, def.anchorAdjust ? def.anchorAdjust(a) : a, (k) => this.hooks.onSurfaceClick(k)));
    }
    this.night = this.add.rectangle(0, 0, w, h, 0x0a1030, 0).setOrigin(0).setDepth(50).setScrollFactor(1);
    // camera: drag / WASD / wheel
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => { if (p.button === 0) this.dragging = true; });
    this.input.on('pointerup', () => { this.dragging = false; });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => { if (this.dragging && p.isDown) { this.cameras.main.scrollX -= (p.x - p.prevPosition.x) / this.cameras.main.zoom; this.cameras.main.scrollY -= (p.y - p.prevPosition.y) / this.cameras.main.zoom; } });
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => { this.cameras.main.setZoom(Phaser.Math.Clamp(this.cameras.main.zoom * (dy > 0 ? 0.9 : 1.1), 0.8, 5)); });
    this.keys = this.input.keyboard!.addKeys('W,A,S,D,UP,LEFT,DOWN,RIGHT') as Record<string, Phaser.Input.Keyboard.Key>;
    // minimap
    this.minimap = this.cameras.add(this.scale.width - 190, this.scale.height - 130, 180, 120).setZoom(180 / w).setBounds(0, 0, w, h).setBackgroundColor(0x000000).setName('minimap');
    this.minimap.ignore(this.night);
    this.scale.on('resize', (g: Phaser.Structs.Size) => this.minimap.setPosition(g.width - 190, g.height - 130));
    if (this.pendingFocus) { const f = this.pendingFocus; this.pendingFocus = null; this.focusOn(f); }
  }

  private assignSeat(role: string, room: 'boardroom' | 'meetingroom'): void {
    const seats = this.world.seats[room] ?? [];
    if (!seats.length) return;
    const i = (this.seatIndex[room] = ((this.seatIndex[room] ?? -1) + 1) % seats.length);
    const ag = this.agents.get(role);
    if (ag) ag.seat = seats[i];
  }

  update(time: number, deltaMs: number): void {
    const s = this.hooks.getState();
    const dt = Math.min(deltaMs, 100) / 1000;
    // sprites; whoever is talking with a speech bubble is the one the seated others glance at
    const talking = Object.values(s.agents).find((v) => v.state === 'talking' && v.bubble?.kind === 'speech');
    const talkingSprite = talking ? this.agents.get(talking.role) : undefined;
    const ctx = { speaker: talkingSprite ? { x: talkingSprite.container.x, y: talkingSprite.container.y, role: talking!.role } : null };
    for (const [role, view] of Object.entries(s.agents)) {
      let ag = this.agents.get(role);
      if (!ag) {
        ag = new AgentSprite(this, this.world, view, (r) => this.hooks.onAgentClick(r));
        this.agents.set(role, ag);
        // The sprite (with its bubbles, labels and emotes) is main-camera only; the minimap shows its dot instead,
        // sized in minimap pixels so it stays legible however large the map is.
        this.minimap.ignore(ag.container);
        this.cameras.main.ignore(ag.dot);
        ag.dot.setScale(1 / this.minimap.zoom);
      }
      if ((view.target === 'boardroom' || view.target === 'meetingroom') && !ag.seat) this.assignSeat(role, view.target);
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
    // day / night
    const hr = this.hooks.hour();
    const dark = hr < 6 ? 0.55 : hr < 8 ? 0.55 * (8 - hr) / 2 : hr < 18 ? 0 : hr < 21 ? 0.55 * (hr - 18) / 3 : 0.55;
    this.night.setAlpha(dark);
  }

  debugAgents(): Record<string, unknown>[] { return [...this.agents.values()].map((a) => a.debug()); }
  debugAnchors(): Record<string, unknown> { return Object.fromEntries(Object.entries(this.world.anchors).map(([k, a]) => [k, { tx: a.tx, ty: a.ty, props: a.props }])); }

  focusOn(name: string): void {
    if (!this.world) { this.pendingFocus = name; return; }   // the snapshot can arrive before the map has loaded
    const a = this.world.anchors[name] ?? null;
    const d = this.world.desks[name];
    const t = a ? { x: (a.tx + a.tw / 2) * TILE, y: (a.ty + a.th / 2) * TILE } : d ? { x: d.tx * TILE, y: d.ty * TILE } : null;
    if (t) this.cameras.main.pan(t.x, t.y, 400, 'Sine.easeInOut');
  }
}
