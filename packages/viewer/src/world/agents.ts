// packages/viewer/src/world/agents.ts
import Phaser from 'phaser';
import type { World, Tile } from './map.js';
import { TILE, makeSprite, makeFaces, makeEmotes, makeShadow, roleColor, SPRITE_H, EMOTE_H } from './tileset.js';
import { toPx, portalFor } from './map.js';
import { planRoute, type Leg } from './route.js';
import type { ElevatorPort, ElevatorEvent } from './elevator.js';
import type { AgentView, ToolIcon, Bubble } from '../state.js';
import { BLINK_MS, GESTURE_MS, nextBlinkDelay, nextGestureDelay, pickGesture, emoteBob, faceToward, thinkingDots, type Gesture } from './expressions.js';
import { frameFor, poseFor, faceFrame, talkOpen, isSeatedPose, WALK_FRAMES, WALK_STEP_MS, BOB, type Dir, type PoseCtx } from './frames.js';
import { DUR, EASE, dur } from './motion.js';
import { RES, FONT, MONO, nameLabelStyle, nameLabelView, nameLabelText, worldTextVisible } from './text.js';
import { addText } from './text-crisp.js';
import { PALETTE, hexToInt } from './palette.js';
import { Latch } from './latch.js';
import { bubbleOffsetX } from './bubble.js';

// Drawn glyphs (no emoji: headless/minimal systems lack emoji fonts). letter + colour per tool family.
const ICON: Record<Exclude<ToolIcon, null>, { t: string; c: string }> = {
  browser: { t: 'W', c: PALETTE.tool.browser }, terminal: { t: '>_', c: PALETTE.tool.terminal }, envelope: { t: 'M', c: PALETTE.tool.envelope },
  doc: { t: 'D', c: PALETTE.tool.doc }, chart: { t: '%', c: PALETTE.tool.chart }, chat: { t: '…', c: PALETTE.tool.chat },
};
const SPEED = 70; // px/s
const DOT = 4; // minimap dot, in minimap pixels: the scene scales it by 1/minimapZoom so it reads at any map size

/** The pantry: a coffee after a finished job, and now and then after a long quiet spell at the desk. */
export const PANTRY_AFTER_MS = 90_000;
export const PANTRY_ROLL = 0.3;
export const PANTRY_STAY_MS = 6_000;

export interface SpriteContext { /** the sprite currently speaking in a meeting, for the others to glance at */ speaker: { x: number; y: number; role: string } | null }
/** What the scene lends a sprite: the elevator, a way to take a seat in a room, and a die for the pantry roll. */
export interface SpriteDeps { elevator?: ElevatorPort; seatFor?: (role: string, room: string) => Tile | null; roll?: () => number }

/**
 * One sprite per role; its pose and position follow the reducer state (never local persistence).
 * The sprite adds only what the state cannot know: blinks, idle gestures, the walking bob, the route (walk legs and
 * elevator rides between floors), a coffee in the pantry, and where a seated agent looks during a meeting.
 */
export class AgentSprite {
  readonly container: Phaser.GameObjects.Container;
  /** Position marker the minimap renders instead of the sprite (the main camera ignores it). */
  readonly dot: Phaser.GameObjects.Rectangle;
  readonly shadow: Phaser.GameObjects.Image;
  private body: Phaser.GameObjects.Sprite;
  private face: Phaser.GameObjects.Image;
  private label: Phaser.GameObjects.Text;
  private icon: Phaser.GameObjects.Text;
  private badge: Phaser.GameObjects.Text;
  private emote: Phaser.GameObjects.Image;
  private bubble: Phaser.GameObjects.Container;
  private bubbleText: Phaser.GameObjects.Text;
  private bubbleBg: Phaser.GameObjects.Graphics;
  private hovered = false;
  /** Whether the sprite is in a seated pose: a bubble spoken sitting down goes beside the speaker, not over them. */
  private seated = false;
  /** Set by the scene when this sprite is the one the panel is focused on: its name shows at any zoom. */
  selected = false;
  /**
   * Every display name at the desks of this sprite's room, this one included — set by the scene when the roster
   * changes. A desk label is only readable against its neighbours (visual QA I1), so the label needs the row.
   */
  siblings: string[] = [];
  private readonly labelLatch = new Latch();
  private readonly iconLatch = new Latch();
  private readonly badgeLatch = new Latch();
  private readonly depthLatch = new Latch<number>();
  private lastBubble = '';
  private lastBubbleText = '';
  private path: { x: number; y: number }[] = [];
  private legs: Leg[] = [];
  private currentTarget: string | null = null;
  private walkingTo: string | null = null;
  private waitingRide: { from: number; to: number } | null = null;
  private car: { x: number; y: number } | null = null;
  private pendingTarget: string | null = null;
  private frameTimer = 0;
  private dir = 0;
  private step = 0;
  private walked = 0;
  private departing = 0;   // seconds left of the departure ease
  private wasMoving = false;
  private hiding = false;
  // small life
  private blinkIn = nextBlinkDelay();
  private blinking = 0;
  private gestureIn = nextGestureDelay();
  private gesture: Gesture = 'none';
  private gestureLeft = 0;
  private detour: 'pantry' | 'sit' | null = null;
  private sitLeft = 0;
  private pantryIdle = 0;
  private pantrySeat: Tile | null = null;
  seat: Tile | null = null;
  private gone = false;
  private riding = false;
  private bubbleSince = 0;           // clock ms when the current speech bubble appeared
  private readonly glasses: boolean;
  setRiding(on: boolean): void { this.riding = on; }

  constructor(private scene: Phaser.Scene, private world: World, public view: AgentView, private onClick: (role: string) => void, private deps: SpriteDeps = {}) {
    this.glasses = view.family === 'advisor' || view.team === 'research';
    const key = makeSprite(scene, { role: view.role, sprite: view.sprite, family: view.family, team: view.team });
    makeFaces(scene); makeEmotes(scene);
    makeShadow(scene);
    this.shadow = scene.add.image(0, 0, 'shadow').setOrigin(0.5, 0.5).setAlpha(1);
    this.shadow.setPosition(0, -1);
    this.body = scene.add.sprite(0, 0, key, 'idle:0').setOrigin(0.5, 1);
    this.face = scene.add.image(-4, -SPRITE_H + 4, 'faces', 'neutral:0').setOrigin(0, 0);
    // Hidden until the camera is close enough to read it, then held at a constant screen size (ruling F1, applied
    // every frame by `applyLabel`): a container child is scaled by the camera zoom, so the label divides it back out.
    this.label = addText(scene, 0, 2, view.display, nameLabelStyle()).setOrigin(0.5, 0).setScale(1 / RES).setVisible(false);
    this.icon = addText(scene, 10, -27, '', { fontFamily: MONO, fontSize: '8px', color: PALETTE.labelInk, backgroundColor: PALETTE.tool.browser, padding: { x: 2, y: 1 } }).setOrigin(0.5);
    this.badge = addText(scene, -10, -27, '', { fontFamily: MONO, fontSize: '8px', color: PALETTE.labelInk, backgroundColor: PALETTE.bad, padding: { x: 2, y: 1 } }).setOrigin(0.5);
    this.emote = scene.add.image(0, -SPRITE_H - 8, 'emotes', '!').setOrigin(0.5, 1).setVisible(false);
    this.bubbleBg = scene.add.graphics();
    this.bubbleText = addText(scene, 0, 0, '', { fontFamily: FONT, fontSize: `${8 * RES}px`, color: PALETTE.bubbleInk, wordWrap: { width: 130 * RES }, align: 'left' }).setOrigin(0.5, 1).setScale(1 / RES);
    this.bubble = scene.add.container(0, -SPRITE_H - 6, [this.bubbleBg, this.bubbleText]).setVisible(false);
    this.container = scene.add.container(0, 0, [this.shadow, this.body, this.face, this.label, this.icon, this.badge, this.emote, this.bubble]).setDepth(10);
    this.body.setInteractive({ useHandCursor: true }).on('pointerdown', () => this.onClick(view.role))
      .on('pointerover', () => { this.hovered = true; })
      .on('pointerout', () => { this.hovered = false; });
    const ring = scene.add.circle(0, -2, 5, roleColor(view.role), 0.9).setStrokeStyle(1, hexToInt(PALETTE.labelStroke), 0.6);
    this.container.addAt(ring, 0);
    this.dot = scene.add.rectangle(0, 0, DOT, DOT, roleColor(view.role), 1).setDepth(9);
    const home = this.homeTile();
    this.place(view.state === 'entering' ? this.world.standTile('door') ?? home : home);
    this.dot.setPosition(this.container.x, this.container.y);
    if (view.state === 'entering') this.goTo('home');
  }

  /** The chair of this role's desk; a role with no desk (a hire on a full floor) stands at the entrance. */
  homeTile(): Tile {
    return this.world.desks[this.view.desk] ?? this.world.standTile('door') ?? { tx: 47, ty: 55 };
  }

  tile(): Tile {
    return { tx: Math.floor(this.container.x / TILE), ty: Math.floor((this.container.y - 6) / TILE) };
  }

  private place(t: Tile): void { const p = toPx(t); this.container.setPosition(p.x, p.y + 6); }

  /** Where a target name is on the map; a room that is the sprite's own room means its desk. */
  private resolve(target: string): Tile | null {
    if (target === 'home') return this.homeTile();
    if (target === 'seat' && this.seat) return this.seat;
    if (target === 'pantry' && this.pantrySeat) return this.pantrySeat;
    if (this.world.rooms[target] && this.world.deskInfo[this.view.desk]?.room === target) return this.homeTile();
    return this.world.standTile(target);
  }

  /**
   * Walk (and ride) to a named place: 'home', 'door', 'seat', 'pantry', an anchor name, 'desk:<desk id>' or a room.
   * A new target while waiting for the car cancels the call; while riding it is applied on arrival.
   */
  goTo(target: string): void {
    if (this.car) { this.pendingTarget = target; return; }
    if (this.walkingTo === target) return;
    if (this.waitingRide) { this.deps.elevator?.cancel(this.view.role); this.waitingRide = null; }
    this.walkingTo = target;
    const dest = this.resolve(target);
    if (!dest) { this.walkingTo = null; this.legs = []; this.path = []; return; }
    this.legs = planRoute(this.world, this.tile(), dest);
    this.departing = DUR.depart / 1000;
    void this.startLeg(target);
  }

  private async startLeg(target: string): Promise<void> {
    const leg = this.legs[0];
    if (!leg) return;
    if (leg.kind === 'ride') {
      if (!this.deps.elevator) { this.legs.shift(); this.place(portalFor(this.world, leg.to)); void this.startLeg(target); return; }   // no elevator wired (a headless scene): step across
      this.waitingRide = { from: leg.from, to: leg.to };
      this.path = []; this.dir = 2;   // wait at the door, facing it
      this.deps.elevator.request({ id: this.view.role, from: leg.from, to: leg.to });
      return;
    }
    let path: Tile[] | null = null;
    try { path = await this.world.findPath(this.tile(), leg.to); } catch (err) { console.warn('[agent] findPath failed', this.view.role, target, err); }
    if (!path) console.warn('[agent] no path', this.view.role, target, this.tile(), leg.to);
    if (this.walkingTo !== target || this.legs[0] !== leg) return; // superseded while the path was computed
    this.path = (path ?? [leg.to]).map((t) => { const p = toPx(t); return { x: p.x, y: p.y + 6 }; });
    if (this.path.length && Phaser.Math.Distance.Between(this.path[0].x, this.path[0].y, this.container.x, this.container.y) < 4) this.path.shift();
  }

  /** A walk leg ended: start the next leg, or finish the journey. */
  private walkFinished(view: AgentView): void {
    this.legs.shift();
    if (this.legs.length && this.walkingTo) { void this.startLeg(this.walkingTo); return; }
    if (view.state === 'leaving') { this.gone = true; this.container.setVisible(false); }
    if (this.detour === 'pantry') { this.detour = 'sit'; this.sitLeft = PANTRY_STAY_MS; }
  }

  /** In the car: seen inside it, masked to the shaft, standing on the car floor, facing the viewer. */
  attachTo(car: { x: number; y: number }): void {
    this.car = car; this.waitingRide = null; this.path = [];
    this.container.setVisible(true);
    const m = (car as Phaser.GameObjects.Container).mask;
    if (m) this.container.setMask(m as Phaser.Display.Masks.GeometryMask);
    this.container.setPosition(car.x, car.y + 3 * TILE - 2);
    this.setRiding(true); this.dir = 0;
  }
  /** Out of the car at a floor's elevator door. */
  detach(at: Tile): void { this.car = null; this.container.clearMask(); this.setRiding(false); this.place(at); this.container.setVisible(this.view.state !== 'offline' && !this.gone); }

  onElevator(ev: ElevatorEvent, car: { x: number; y: number }): void {
    if (ev.kind === 'boarded' && ev.id === this.view.role) this.attachTo(car);
    if (ev.kind === 'arrived' && ev.id === this.view.role) {
      this.detach(portalFor(this.world, ev.floor));
      if (this.legs[0]?.kind === 'ride') this.legs.shift();
      const pending = this.pendingTarget; this.pendingTarget = null;
      if (pending) { this.walkingTo = null; this.goTo(pending); }
      else if (this.walkingTo) void this.startLeg(this.walkingTo);
    }
  }

  private startPantry(): void {
    const seat = this.deps.seatFor?.(this.view.role, 'pantry') ?? null;
    if (!seat) return;
    this.pantrySeat = seat; this.detour = 'pantry'; this.currentTarget = 'home';
    this.goTo('pantry');
  }
  private endDetour(): void { this.detour = null; this.sitLeft = 0; this.pantrySeat = null; this.currentTarget = null; }

  update(view: AgentView, dt: number, nowMs: number, ctx: SpriteContext = { speaker: null }): void {
    const prev = this.view;
    this.view = view;
    // A finished job earns a coffee; so, sometimes, does a long quiet spell at the desk (only when nothing else is asked).
    if (prev.job && !view.job && view.state === 'walking' && !view.target && !this.detour) this.startPantry();
    if (this.detour && (view.target || (view.state !== 'walking' && view.state !== 'idle_at_desk'))) this.endDetour();
    if (!this.detour && view.state === 'idle_at_desk' && !view.job && !this.path.length && !this.car) {
      this.pantryIdle += dt * 1000;
      if (this.pantryIdle >= PANTRY_AFTER_MS) { this.pantryIdle = 0; if ((this.deps.roll ?? Math.random)() < PANTRY_ROLL) this.startPantry(); }
    } else if (view.state !== 'idle_at_desk') this.pantryIdle = 0;
    // target changes drive walking
    const want = view.state === 'leaving' ? 'door' : view.state === 'entering' ? 'home' : view.target ?? (view.state === 'walking' && !view.target ? 'home' : this.currentTarget ?? 'home');
    if (want !== this.currentTarget && !this.detour) { this.currentTarget = want; this.goTo(this.world.seats[want] ? (this.seat ? 'seat' : want) : want); }
    if (this.car) {
      // in the car: visible, masked to the shaft, standing on the car floor, riding (pose:ride), facing the viewer;
      // no shadow (there is no floor light to cast one onto), and any walk-settle squash in flight is cut short
      this.container.setPosition(this.car.x, this.car.y + 3 * TILE - 2);
      this.step = 0; this.body.y = 0; this.dir = 0;
      this.scene.tweens.killTweensOf(this.body); this.body.setScale(1, 1); this.wasMoving = false;
      this.body.setFrame(frameFor({ moving: false, dir: this.dir as Dir, step: 0, pose: 'ride' }));
      this.shadow.setVisible(false);
    } else {
      // a sprite is never seated in a chair while walking or waiting for the car; only the standing branch below can hide it
      this.shadow.setVisible(true);
      // move along the path
      if (this.path.length) {
        const next = this.path[0];
        const dx = next.x - this.container.x, dy = next.y - this.container.y;
        const d = Math.hypot(dx, dy);
        const ease = this.departing > 0 ? 1 - (this.departing / (DUR.depart / 1000)) * 0.6 : 1;   // 100 ms ease-in from 40 % speed
        this.departing = Math.max(0, this.departing - dt);
        const stepLen = SPEED * dt * ease;
        if (d <= stepLen) { this.container.setPosition(next.x, next.y); this.path.shift(); }
        else { this.container.x += (dx / d) * stepLen; this.container.y += (dy / d) * stepLen; }
        this.walked += stepLen;
        this.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 1 : 2) : dy < 0 ? 3 : 0;
        this.frameTimer += dt;
        if (this.frameTimer * 1000 > WALK_STEP_MS) { this.frameTimer = 0; this.step = (this.step + 1) % WALK_FRAMES; }
        this.body.setFrame(frameFor({ moving: true, dir: this.dir as Dir, step: this.step }));
        this.seated = false;
        this.body.y = BOB[this.step];
        this.shadow.setScale(BOB[this.step] ? 0.9 : 1, 1); this.wasMoving = true;
        if (!this.path.length) this.walkFinished(view);
        this.gesture = 'none';
      } else if (this.waitingRide) {
        // at the elevator door: stand facing it until the car opens
        this.step = 0; this.body.y = 0; this.dir = 2;
        this.body.setFrame(frameFor({ moving: false, dir: this.dir as Dir, step: 0 }));
      } else {
        if (this.wasMoving) {   // settle: a short squash, then spring back
          this.wasMoving = false;
          this.scene.tweens.killTweensOf(this.body);   // a multi-leg route can re-enter this branch before the previous settle finished
          this.body.setScale(1.06, 0.92);
          this.scene.tweens.add({ targets: this.body, scaleX: 1, scaleY: 1, duration: dur(DUR.settle), ease: EASE.spring });
        }
        this.shadow.setScale(1, 1);
        this.step = 0;
        this.body.y = 0;
        if (this.detour === 'sit') { this.sitLeft -= dt * 1000; this.dir = 0; if (this.sitLeft <= 0) this.endDetour(); }
        const atDesk = this.currentTarget === 'home' && view.state !== 'walking' && !this.riding;
        if (atDesk) { this.dir = 0; this.idleLife(dt, nowMs, view); if (this.gesture === 'look_left') this.dir = 1; else if (this.gesture === 'look_right') this.dir = 2; }
        else if (ctx.speaker && ctx.speaker.role !== view.role && (view.target === 'boardroom' || view.target === 'meetingroom')) this.dir = faceToward({ x: this.container.x, y: this.container.y }, ctx.speaker);
        const sideSeat: PoseCtx['sideSeat'] = this.seat && (view.target === 'boardroom' || view.target === 'meetingroom') && this.dir === 1 ? 'l' : this.seat && (view.target === 'boardroom' || view.target === 'meetingroom') && this.dir === 2 ? 'r' : null;
        const pose = poseFor(view, { atDesk, riding: this.riding, sideSeat, nowMs, gesture: this.gesture, detour: this.detour });
        this.seated = isSeatedPose(pose);
        this.shadow.setVisible(!this.riding && !this.seated);
        if (pose) this.dir = pose === 'sit_side_l' ? 1 : pose === 'sit_side_r' ? 2 : 0;
        this.body.setFrame(frameFor({ moving: false, dir: this.dir as Dir, step: 0, pose }));
      }
    }
    // the rest runs every frame — including while riding — so a bubble/icon/badge/emote frozen at boarding still
    // expires, and the offline alpha / minimap dot stay correct
    this.updateFace(dt, nowMs, view);
    // `setText` self-guards; `setStyle` does not — it re-rasterises the text canvas and re-uploads the texture.
    // Unguarded that is up to two canvas re-renders per sprite per frame, against a 4 ms scripting budget.
    if (view.tool) {
      const ic = ICON[view.tool];
      if (this.iconLatch.changed(view.tool)) this.icon.setStyle({ backgroundColor: ic.c });
      this.icon.setText(ic.t).setVisible(true);
    } else this.icon.setVisible(false);
    // emote icon above the head (a wave is a pose, not an icon; a coffee stop shows the cup)
    const emoteKind = this.detour === 'sit' ? 'coffee' : view.emote && view.emote.kind !== 'wave' ? view.emote.kind : null;
    // the persistent badge (! failed, ? blocked) yields while an emote says the same thing more expressively
    if (view.badge && !emoteKind) {
      if (this.badgeLatch.changed(view.badge)) this.badge.setStyle({ backgroundColor: view.badge === 'error' ? PALETTE.bad : PALETTE.warn });
      this.badge.setText(view.badge === 'error' ? '!' : '?').setVisible(true);
    } else this.badge.setVisible(false);
    if (emoteKind) { this.emote.setFrame(emoteKind).setVisible(true); this.emote.y = -SPRITE_H - 6 + emoteBob(nowMs); } else this.emote.setVisible(false);
    // A bubble is the loudest object in the office, and at the tower elevation it is an unreadable white smear over
    // one floor of a building (visual QA, alongside I10). In-world lettering is off there; so is this.
    if (!worldTextVisible(this.scene.cameras?.main?.zoom ?? 1)) this.bubble.setVisible(false);
    else this.updateBubble(view.bubble, nowMs, emoteKind ? -SPRITE_H - EMOTE_H - 8 : -SPRITE_H - 6, this.seated);
    // Depth is a function of y alone; setting it marks the whole display list dirty, so only set it when y moved.
    const depth = 10 + this.container.y / 10000;
    if (this.depthLatch.changed(depth)) this.container.setDepth(depth);
    this.applyLabel();
    this.dot.setPosition(this.container.x, this.container.y).setVisible(this.container.visible && view.state !== 'offline');
    if (prev.state === 'leaving' && !view.active && this.gone) this.container.setVisible(false);
    if (view.state === 'offline') this.container.setAlpha(0.35); else this.container.setAlpha(1);
  }

  /** Blinks and idle gestures: timers only, nothing here changes state. */
  private idleLife(dt: number, _nowMs: number, view: AgentView): void {
    if (this.gestureLeft > 0) { this.gestureLeft -= dt * 1000; if (this.gestureLeft <= 0) this.gesture = 'none'; return; }
    if (view.state !== 'idle_at_desk' && view.mood !== 'asleep') { this.gesture = 'none'; return; }
    this.gestureIn -= dt;
    if (this.gestureIn <= 0) { this.gestureIn = nextGestureDelay(); this.gesture = pickGesture(Math.random(), view.mood); this.gestureLeft = GESTURE_MS[this.gesture]; }
  }

  private updateFace(dt: number, nowMs: number, view: AgentView): void {
    if (this.dir === 3) { this.face.setVisible(false); return; }
    this.face.setVisible(true).setPosition(-4 + (this.dir === 1 ? -1 : this.dir === 2 ? 1 : 0), -SPRITE_H + 4 + this.body.y);
    if (view.mood !== 'asleep') {
      if (this.blinking > 0) this.blinking -= dt * 1000;
      else { this.blinkIn -= dt; if (this.blinkIn <= 0) { this.blinkIn = nextBlinkDelay(); this.blinking = BLINK_MS; } }
    }
    const talk = view.bubble?.kind === 'speech' && talkOpen(nowMs, this.bubbleSince);
    const frame = view.mood === 'asleep' ? faceFrame('asleep', this.dir as 0 | 1 | 2, { glasses: this.glasses }) : this.blinking > 0 ? faceFrame('blink', this.dir as 0 | 1 | 2, { glasses: this.glasses }) : faceFrame(view.mood, this.dir as 0 | 1 | 2, { talk, glasses: this.glasses });
    if (this.face.frame.name !== frame) this.face.setFrame(frame);
  }

  /** Speech (white, tail, role-coloured border), thought (cloud, grey, animated dots) or action (dark strip with the verb). */
  private updateBubble(b: Bubble | null, nowMs: number, y: number, seated = false): void {
    if (!b) {
      if (this.bubble.visible && !this.hiding) {
        this.hiding = true;
        this.scene.tweens.add({ targets: this.bubble, alpha: 0, duration: dur(DUR.bubbleOut), onComplete: () => { this.bubble.setVisible(false).setAlpha(1); this.hiding = false; } });
      }
      this.lastBubble = '';
      return;
    }
    const text = b.kind === 'thought' && !b.text ? thinkingDots(nowMs) : b.kind === 'thought' ? `${b.text} ${thinkingDots(nowMs)}` : b.text;
    // identity only: a thought's animated dots must redraw the text on change without re-triggering the pop-in tween
    const sig = `${b.kind}|${b.text}|${b.until}`;
    this.bubble.y = y;
    const isNew = sig !== this.lastBubble;
    const textChanged = text !== this.lastBubbleText;
    if (!isNew && !textChanged && this.bubble.visible) return;
    if (isNew && b.kind === 'speech') this.bubbleSince = nowMs;
    this.lastBubble = sig;
    this.lastBubbleText = text;
    const color = b.kind === 'action' ? PALETTE.bubbleActionInk : b.kind === 'thought' ? PALETTE.bubbleThoughtInk : PALETTE.bubbleInk;
    this.bubbleText.setStyle({ color, fontStyle: b.kind === 'thought' ? 'italic' : 'normal', fontSize: `${(b.kind === 'action' ? 7 : 8) * RES}px` }).setText(text);
    const w = this.bubbleText.width / RES, h = this.bubbleText.height / RES;
    // Which side of the speaker the bubble hangs on, and where its tail comes down.
    //
    // It used to clamp against the world only, so in `08-board` a bubble spoken at the table sat squarely over the
    // advisors' monitors and the screen they were looking at, and in `09-night` the bottom of the viewport cut it
    // (visual QA I10). The camera is what decides now, and a speaker who is sitting down — a meeting, the one
    // place a bubble reliably covers the thing it is about — gets the bubble beside them rather than over them,
    // on whichever side has more room in view. The tail then follows the speaker rather than the bubble, so an
    // offset bubble still points at who said it.
    const off = bubbleOffsetX(this.container.x, w, this.scene.cameras?.main?.worldView, this.world.width * TILE, seated);
    this.bubble.x = off;
    const tail = Math.max(-w / 2 + 4, Math.min(w / 2 - 4, -off));
    const g = this.bubbleBg.clear();
    if (b.kind === 'speech') {
      const tint = roleColor(this.view.role);
      g.fillStyle(hexToInt(PALETTE.bubbleFill), 0.96).lineStyle(1, tint, 1).fillRoundedRect(-w / 2 - 4, -h - 4, w + 8, h + 6, 4).strokeRoundedRect(-w / 2 - 4, -h - 4, w + 8, h + 6, 4);
      g.fillStyle(hexToInt(PALETTE.bubbleFill), 0.96).fillTriangle(tail - 3, 2, tail + 3, 2, tail, 6); // tail
      g.lineStyle(1, tint, 1).lineBetween(tail - 3, 2, tail, 6).lineBetween(tail + 3, 2, tail, 6);
    } else if (b.kind === 'thought') {
      g.fillStyle(hexToInt(PALETTE.bubbleThoughtFill), 0.95).lineStyle(1, hexToInt(PALETTE.bubbleThoughtStroke), 1);
      g.fillRoundedRect(-w / 2 - 5, -h - 5, w + 10, h + 8, 6).strokeRoundedRect(-w / 2 - 5, -h - 5, w + 10, h + 8, 6);
      g.fillCircle(tail + 2, 5, 2).strokeCircle(tail + 2, 5, 2).fillCircle(tail + 5, 9, 1.2).strokeCircle(tail + 5, 9, 1.2); // trailing thought circles
    } else {
      g.fillStyle(hexToInt(PALETTE.bubbleActionFill), 0.94).lineStyle(1, hexToInt(PALETTE.bubbleActionStroke), 1).fillRoundedRect(-w / 2 - 4, -h - 3, w + 8, h + 5, 3).strokeRoundedRect(-w / 2 - 4, -h - 3, w + 8, h + 5, 3);
    }
    if (isNew) {
      // A bubble arriving mid-fade would otherwise be hidden again by the outgoing tween's onComplete.
      this.scene.tweens.killTweensOf(this.bubble);
      this.bubble.setAlpha(1);
      this.hiding = false;
      if (b.kind === 'speech' || b.kind === 'thought') {
        this.bubble.setScale(0.85);
        this.scene.tweens.add({ targets: this.bubble, scaleX: 1, scaleY: 1, duration: dur(DUR.bubbleIn), ease: EASE.spring });
      } else {
        this.bubble.y = y + 4;
        this.scene.tweens.add({ targets: this.bubble, y, duration: dur(DUR.bubbleIn), ease: EASE.out });
      }
    }
    this.bubble.setVisible(true);
  }

  /** Ruling F1: the name is hidden below zoom 2 and held at a constant screen size above it, or on hover / selection. */
  private applyLabel(): void {
    const zoom = this.scene.cameras?.main?.zoom ?? 1;
    if (!this.labelLatch.changed(`${zoom}|${this.hovered}|${this.selected}|${this.siblings.length}`)) return;
    const v = nameLabelView(zoom, { hover: this.hovered, selected: this.selected });
    this.label.setVisible(v.visible).setScale(v.scale).setText(nameLabelText(this.view.display, v.chars, this.siblings));
  }

  debug(): Record<string, unknown> { return { role: this.view.role, state: this.view.state, mood: this.view.mood, emote: this.view.emote?.kind ?? null, bubble: this.view.bubble?.kind ?? null, target: this.view.target, currentTarget: this.currentTarget, walkingTo: this.walkingTo, detour: this.detour, pathLen: this.path.length, legs: this.legs, waitingRide: this.waitingRide, riding: !!this.car, pendingTarget: this.pendingTarget, tile: this.tile(), seat: this.seat, desk: this.view.desk, home: this.homeTile() }; }

  destroy(): void {
    if (this.waitingRide) this.deps.elevator?.cancel(this.view.role);
    // The settle squash and any bubble fade would otherwise keep tweening destroyed objects after a scene restart.
    this.scene.tweens.killTweensOf([this.body, this.bubble]);
    this.container.destroy();
    this.dot.destroy();
  }
}
