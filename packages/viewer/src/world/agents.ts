import Phaser from 'phaser';
import type { World } from './map.js';
import { TILE, makeSprite, makeFaces, makeEmotes, roleColor, POSE, SPRITE_H, EMOTE_H } from './tileset.js';
import { toPx } from './map.js';
import type { AgentView, ToolIcon, Bubble } from '../state.js';
import { BLINK_MS, GESTURE_MS, nextBlinkDelay, nextGestureDelay, pickGesture, walkBob, typingFrame, emoteBob, faceToward, thinkingDots, type Gesture } from './expressions.js';

// Drawn glyphs (no emoji: headless/minimal systems lack emoji fonts). letter + colour per tool family.
const ICON: Record<Exclude<ToolIcon, null>, { t: string; c: string }> = { browser: { t: 'W', c: '#2a6fdb' }, terminal: { t: '>_', c: '#2b2f3a' }, envelope: { t: 'M', c: '#c0392b' }, doc: { t: 'D', c: '#7a5c2e' }, chart: { t: '%', c: '#2e7d32' }, chat: { t: '…', c: '#6a3fb0' } };
const SPEED = 70; // px/s
const COFFEE_STOP_MS = 2500;
const RES = 3; // bubble text rasterised at 3× for crisp glyphs under zoom

export interface SpriteContext { /** the sprite currently speaking in a meeting, for the others to glance at */ speaker: { x: number; y: number; role: string } | null }

const DOT = 4; // minimap dot, in minimap pixels: the scene scales it by 1/minimapZoom so it reads at any map size

/**
 * One sprite per role; its pose and position follow the reducer state (never local persistence).
 * The sprite adds only what the state cannot know: blinks, idle gestures, the walking bob, a coffee stop after a
 * finished job, and where a seated agent looks during a meeting.
 */
export class AgentSprite {
  readonly container: Phaser.GameObjects.Container;
  /** Position marker the minimap renders instead of the sprite (the main camera ignores it). */
  readonly dot: Phaser.GameObjects.Rectangle;
  private body: Phaser.GameObjects.Sprite;
  private face: Phaser.GameObjects.Image;
  private label: Phaser.GameObjects.Text;
  private icon: Phaser.GameObjects.Text;
  private badge: Phaser.GameObjects.Text;
  private emote: Phaser.GameObjects.Image;
  private bubble: Phaser.GameObjects.Container;
  private bubbleText: Phaser.GameObjects.Text;
  private bubbleBg: Phaser.GameObjects.Graphics;
  private lastBubble = '';
  private path: { x: number; y: number }[] = [];
  private currentTarget: string | null = null;
  private walkingTo: string | null = null;
  private frameTimer = 0;
  private dir = 0;
  private step = 0;
  private walked = 0;
  // small life
  private blinkIn = nextBlinkDelay();
  private blinking = 0;
  private gestureIn = nextGestureDelay();
  private gesture: Gesture = 'none';
  private gestureLeft = 0;
  private detour: 'kitchen' | 'coffee' | null = null;
  private coffeeLeft = 0;
  seat: { tx: number; ty: number } | null = null;
  private gone = false;

  constructor(private scene: Phaser.Scene, private world: World, public view: AgentView, private onClick: (role: string) => void) {
    const key = makeSprite(scene, view.sprite || view.role);
    makeFaces(scene); makeEmotes(scene);
    this.body = scene.add.sprite(0, 0, key, '0').setOrigin(0.5, 1);
    this.face = scene.add.image(-4, -SPRITE_H + 4, 'faces', 'neutral:0').setOrigin(0, 0);
    this.label = scene.add.text(0, 2, view.display, { fontFamily: 'system-ui', fontSize: `${9 * RES}px`, color: '#fff', stroke: '#000', strokeThickness: 2 * RES }).setOrigin(0.5, 0).setScale(1 / RES);
    this.icon = scene.add.text(10, -27, '', { fontFamily: 'ui-monospace, monospace', fontSize: '8px', color: '#fff', backgroundColor: '#2a6fdb', padding: { x: 2, y: 1 } }).setOrigin(0.5);
    this.badge = scene.add.text(-10, -27, '', { fontFamily: 'ui-monospace, monospace', fontSize: '8px', color: '#fff', backgroundColor: '#c0392b', padding: { x: 2, y: 1 } }).setOrigin(0.5);
    this.emote = scene.add.image(0, -SPRITE_H - 8, 'emotes', '!').setOrigin(0.5, 1).setVisible(false);
    this.bubbleBg = scene.add.graphics();
    this.bubbleText = scene.add.text(0, 0, '', { fontFamily: 'system-ui', fontSize: `${8 * RES}px`, color: '#111', wordWrap: { width: 130 * RES }, align: 'left' }).setOrigin(0.5, 1).setScale(1 / RES);
    this.bubble = scene.add.container(0, -SPRITE_H - 6, [this.bubbleBg, this.bubbleText]).setVisible(false);
    this.container = scene.add.container(0, 0, [this.body, this.face, this.label, this.icon, this.badge, this.emote, this.bubble]).setDepth(10);
    this.body.setInteractive({ useHandCursor: true }).on('pointerdown', () => this.onClick(view.role));
    const ring = scene.add.circle(0, -2, 5, roleColor(view.role), 0.9).setStrokeStyle(1, 0x000000, 0.6);
    this.container.addAt(ring, 0);
    this.dot = scene.add.rectangle(0, 0, DOT, DOT, roleColor(view.role), 1).setDepth(9);
    const home = this.homeTile();
    const p = toPx(view.state === 'entering' ? this.world.standTile('door') ?? home : home);
    this.container.setPosition(p.x, p.y + 6);
    this.dot.setPosition(p.x, p.y + 6);
    if (view.state === 'entering') this.goTo('home');
  }

  homeTile(): { tx: number; ty: number } {
    return this.world.desks[this.view.desk] ?? this.world.standTile('door') ?? { tx: 24, ty: 32 };
  }

  private tile(): { tx: number; ty: number } {
    return { tx: Math.floor(this.container.x / TILE), ty: Math.floor((this.container.y - 6) / TILE) };
  }

  /** Walk to a named place: 'home', 'door', an anchor name, 'desk:<role>' or a room (seat assigned by caller). */
  async goTo(target: string): Promise<void> {
    if (this.walkingTo === target) return;
    this.walkingTo = target;
    const dest = target === 'home' ? this.homeTile() : target === 'seat' && this.seat ? this.seat : this.world.standTile(target);
    if (!dest) { this.walkingTo = null; return; }
    let path: { tx: number; ty: number }[] | null = null;
    try { path = await this.world.findPath(this.tile(), dest); } catch (err) { console.warn('[agent] findPath failed', this.view.role, target, err); }
    if (!path) console.warn('[agent] no path', this.view.role, target, this.tile(), dest);
    if (this.walkingTo !== target) return; // superseded
    this.path = (path ?? [dest]).map((t) => { const p = toPx(t); return { x: p.x, y: p.y + 6 }; });
    if (this.path.length && Phaser.Math.Distance.Between(this.path[0].x, this.path[0].y, this.container.x, this.container.y) < 4) this.path.shift();
  }

  update(view: AgentView, dt: number, nowMs: number, ctx: SpriteContext = { speaker: null }): void {
    const prev = this.view;
    this.view = view;
    // A finished job earns a coffee: detour past the kitchen on the way home (only when nothing else is asked).
    if (prev.job && !view.job && view.state === 'walking' && !view.target && !this.detour && this.world.standTile('kitchen')) { this.detour = 'kitchen'; this.currentTarget = 'home'; void this.goTo('kitchen'); }
    if (this.detour && (view.target || (view.state !== 'walking' && view.state !== 'idle_at_desk'))) { this.detour = null; this.coffeeLeft = 0; }
    // target changes drive walking
    const want = view.state === 'leaving' ? 'door' : view.state === 'entering' ? 'home' : view.target ?? (view.state === 'walking' && !view.target ? 'home' : this.currentTarget ?? 'home');
    if (want !== this.currentTarget && !this.detour) { this.currentTarget = want; void this.goTo(want === 'boardroom' || want === 'meetingroom' ? (this.seat ? 'seat' : want) : want); }
    // move along the path
    if (this.path.length) {
      const next = this.path[0];
      const dx = next.x - this.container.x, dy = next.y - this.container.y;
      const d = Math.hypot(dx, dy);
      const stepLen = SPEED * dt;
      if (d <= stepLen) { this.container.setPosition(next.x, next.y); this.path.shift(); }
      else { this.container.x += (dx / d) * stepLen; this.container.y += (dy / d) * stepLen; }
      this.walked += stepLen;
      this.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 1 : 2) : dy < 0 ? 3 : 0;
      this.frameTimer += dt;
      if (this.frameTimer > 0.12) { this.frameTimer = 0; this.step = (this.step + 1) % 3; }
      this.body.setFrame(String(this.dir * 3 + (this.step === 0 ? 1 : this.step === 1 ? 2 : 0)));
      this.body.y = walkBob(this.walked);
      if (!this.path.length && view.state === 'leaving') { this.gone = true; this.container.setVisible(false); }
      if (!this.path.length && this.detour === 'kitchen') { this.detour = 'coffee'; this.coffeeLeft = COFFEE_STOP_MS; }
      this.gesture = 'none';
    } else {
      this.step = 0;
      this.body.y = 0;
      if (this.detour === 'coffee') {
        this.coffeeLeft -= dt * 1000;
        this.body.setFrame(String(POSE.COFFEE)); this.dir = 0;
        if (this.coffeeLeft <= 0) { this.detour = null; this.currentTarget = null; }
      } else if (view.emote?.kind === 'wave') { this.body.setFrame(String(POSE.WAVE)); this.dir = 0; }
      else if (this.currentTarget === 'home' && view.state !== 'walking') {
        // at the desk: seated, facing the viewer; typing while working; the odd stretch or glance when idle
        this.dir = 0;
        this.idleLife(dt, nowMs, view);
        if (this.gesture === 'stretch') this.body.setFrame(String(POSE.STRETCH));
        else if (this.gesture === 'yawn') this.body.setFrame(String(POSE.STRETCH));
        else if (view.state === 'working' || view.mood === 'thinking') this.body.setFrame(String(typingFrame(nowMs) ? POSE.TYPING : POSE.SEATED));
        else this.body.setFrame(String(POSE.SEATED));
        if (this.gesture === 'look_left') this.dir = 1; else if (this.gesture === 'look_right') this.dir = 2;
      } else {
        // standing somewhere (a surface, a meeting seat): face the speaker if there is one, else keep the walking direction
        if (ctx.speaker && ctx.speaker.role !== view.role && (view.target === 'boardroom' || view.target === 'meetingroom')) this.dir = faceToward({ x: this.container.x, y: this.container.y }, ctx.speaker);
        this.body.setFrame(String(this.dir * 3));
      }
    }
    this.updateFace(dt, view);
    if (view.tool) { const ic = ICON[view.tool]; this.icon.setText(ic.t).setStyle({ backgroundColor: ic.c }).setVisible(true); } else this.icon.setVisible(false);
    // emote icon above the head (a wave is a pose, not an icon; a coffee stop shows the cup)
    const emoteKind = this.detour === 'coffee' ? 'coffee' : view.emote && view.emote.kind !== 'wave' ? view.emote.kind : null;
    // the persistent badge (! failed, ? blocked) yields while an emote says the same thing more expressively
    if (view.badge && !emoteKind) { this.badge.setText(view.badge === 'error' ? '!' : '?').setStyle({ backgroundColor: view.badge === 'error' ? '#c0392b' : '#e0a030' }).setVisible(true); } else this.badge.setVisible(false);
    if (emoteKind) { this.emote.setFrame(emoteKind).setVisible(true); this.emote.y = -SPRITE_H - 6 + emoteBob(nowMs); } else this.emote.setVisible(false);
    this.updateBubble(view.bubble, nowMs, emoteKind ? -SPRITE_H - EMOTE_H - 8 : -SPRITE_H - 6);
    this.container.setDepth(10 + this.container.y / 10000);
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

  private updateFace(dt: number, view: AgentView): void {
    if (this.dir === 3) { this.face.setVisible(false); return; }
    this.face.setVisible(true).setPosition(-4 + (this.dir === 1 ? -1 : this.dir === 2 ? 1 : 0), -SPRITE_H + 4 + this.body.y);
    if (view.mood !== 'asleep') {
      if (this.blinking > 0) this.blinking -= dt * 1000;
      else { this.blinkIn -= dt; if (this.blinkIn <= 0) { this.blinkIn = nextBlinkDelay(); this.blinking = BLINK_MS; } }
    }
    const frame = view.mood === 'asleep' ? `asleep:${this.dir}` : this.blinking > 0 ? `blink:${this.dir}` : `${view.mood}:${this.dir}`;
    if (this.face.frame.name !== frame) this.face.setFrame(frame);
  }

  /** Speech (white, tail, role-coloured border), thought (cloud, grey, animated dots) or action (dark strip with the verb). */
  private updateBubble(b: Bubble | null, nowMs: number, y: number): void {
    if (!b) { this.bubble.setVisible(false); this.lastBubble = ''; return; }
    const text = b.kind === 'thought' && !b.text ? thinkingDots(nowMs) : b.kind === 'thought' ? `${b.text} ${thinkingDots(nowMs)}` : b.text;
    const sig = `${b.kind}|${text}`;
    this.bubble.y = y;
    if (sig === this.lastBubble && this.bubble.visible) return;
    this.lastBubble = sig;
    const color = b.kind === 'action' ? '#e7e9ee' : b.kind === 'thought' ? '#4b5160' : '#111';
    this.bubbleText.setStyle({ color, fontStyle: b.kind === 'thought' ? 'italic' : 'normal', fontSize: `${(b.kind === 'action' ? 7 : 8) * RES}px` }).setText(text);
    const w = this.bubbleText.width / RES, h = this.bubbleText.height / RES;
    const g = this.bubbleBg.clear();
    if (b.kind === 'speech') {
      const tint = roleColor(this.view.role);
      g.fillStyle(0xffffff, 0.96).lineStyle(1, tint, 1).fillRoundedRect(-w / 2 - 4, -h - 4, w + 8, h + 6, 4).strokeRoundedRect(-w / 2 - 4, -h - 4, w + 8, h + 6, 4);
      g.fillStyle(0xffffff, 0.96).fillTriangle(-3, 2, 3, 2, 0, 6); // tail
      g.lineStyle(1, tint, 1).lineBetween(-3, 2, 0, 6).lineBetween(3, 2, 0, 6);
    } else if (b.kind === 'thought') {
      g.fillStyle(0xf4f6fa, 0.95).lineStyle(1, 0x9aa3b5, 1);
      g.fillRoundedRect(-w / 2 - 5, -h - 5, w + 10, h + 8, 6).strokeRoundedRect(-w / 2 - 5, -h - 5, w + 10, h + 8, 6);
      g.fillCircle(-2, 5, 2).strokeCircle(-2, 5, 2).fillCircle(-5, 9, 1.2).strokeCircle(-5, 9, 1.2); // trailing thought circles
    } else {
      g.fillStyle(0x1b1f2a, 0.94).lineStyle(1, 0x343a48, 1).fillRoundedRect(-w / 2 - 4, -h - 3, w + 8, h + 5, 3).strokeRoundedRect(-w / 2 - 4, -h - 3, w + 8, h + 5, 3);
    }
    this.bubble.setVisible(true);
  }

  debug(): Record<string, unknown> { return { role: this.view.role, state: this.view.state, mood: this.view.mood, emote: this.view.emote?.kind ?? null, bubble: this.view.bubble?.kind ?? null, target: this.view.target, currentTarget: this.currentTarget, walkingTo: this.walkingTo, detour: this.detour, pathLen: this.path.length, tile: this.tile(), seat: this.seat, desk: this.view.desk, home: this.homeTile() }; }

  destroy(): void { this.container.destroy(); this.dot.destroy(); }
}
