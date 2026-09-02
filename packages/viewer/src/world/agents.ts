import Phaser from 'phaser';
import type { World } from './map.js';
import { TILE, makeSprite, roleColor } from './tileset.js';
import { toPx } from './map.js';
import type { AgentView, ToolIcon } from '../state.js';

// Drawn glyphs (no emoji: headless/minimal systems lack emoji fonts). letter + colour per tool family.
const ICON: Record<Exclude<ToolIcon, null>, { t: string; c: string }> = { browser: { t: 'W', c: '#2a6fdb' }, terminal: { t: '>_', c: '#2b2f3a' }, envelope: { t: 'M', c: '#c0392b' }, doc: { t: 'D', c: '#7a5c2e' }, chart: { t: '%', c: '#2e7d32' }, chat: { t: '…', c: '#6a3fb0' } };
const SPEED = 70; // px/s

/** One sprite per role; its pose and position follow the reducer state (never local persistence). */
export class AgentSprite {
  readonly container: Phaser.GameObjects.Container;
  private body: Phaser.GameObjects.Sprite;
  private label: Phaser.GameObjects.Text;
  private icon: Phaser.GameObjects.Text;
  private badge: Phaser.GameObjects.Text;
  private bubble: Phaser.GameObjects.Container;
  private bubbleText: Phaser.GameObjects.Text;
  private bubbleBg: Phaser.GameObjects.Graphics;
  private path: { x: number; y: number }[] = [];
  private currentTarget: string | null = null;
  private walkingTo: string | null = null;
  private frameTimer = 0;
  private dir = 0;
  private step = 0;
  seat: { tx: number; ty: number } | null = null;
  private gone = false;

  constructor(private scene: Phaser.Scene, private world: World, public view: AgentView, private onClick: (role: string) => void) {
    const key = makeSprite(scene, view.sprite || view.role);
    this.body = scene.add.sprite(0, 0, key, '0').setOrigin(0.5, 1);
    this.label = scene.add.text(0, 2, view.display, { fontFamily: 'system-ui', fontSize: '9px', color: '#fff', stroke: '#000', strokeThickness: 2 }).setOrigin(0.5, 0);
    this.icon = scene.add.text(10, -27, '', { fontFamily: 'ui-monospace, monospace', fontSize: '8px', color: '#fff', backgroundColor: '#2a6fdb', padding: { x: 2, y: 1 } }).setOrigin(0.5);
    this.badge = scene.add.text(-10, -27, '', { fontFamily: 'ui-monospace, monospace', fontSize: '8px', color: '#fff', backgroundColor: '#c0392b', padding: { x: 2, y: 1 } }).setOrigin(0.5);
    this.bubbleBg = scene.add.graphics();
    this.bubbleText = scene.add.text(0, 0, '', { fontFamily: 'system-ui', fontSize: '9px', color: '#111', wordWrap: { width: 140 } }).setOrigin(0.5, 1);
    this.bubble = scene.add.container(0, -30, [this.bubbleBg, this.bubbleText]).setVisible(false);
    this.container = scene.add.container(0, 0, [this.body, this.label, this.icon, this.badge, this.bubble]).setDepth(10);
    this.body.setInteractive({ useHandCursor: true }).on('pointerdown', () => this.onClick(view.role));
    const ring = scene.add.circle(0, -2, 5, roleColor(view.role), 0.9).setStrokeStyle(1, 0x000000, 0.6);
    this.container.addAt(ring, 0);
    const home = this.homeTile();
    const p = toPx(view.state === 'entering' ? this.world.standTile('door') ?? home : home);
    this.container.setPosition(p.x, p.y + 6);
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

  update(view: AgentView, dt: number, nowMs: number): void {
    const prev = this.view;
    this.view = view;
    // target changes drive walking
    const want = view.state === 'leaving' ? 'door' : view.state === 'entering' ? 'home' : view.target ?? (view.state === 'walking' && !view.target ? 'home' : this.currentTarget ?? 'home');
    if (want !== this.currentTarget) { this.currentTarget = want; void this.goTo(want === 'boardroom' || want === 'meetingroom' ? (this.seat ? 'seat' : want) : want); }
    // move along the path
    if (this.path.length) {
      const next = this.path[0];
      const dx = next.x - this.container.x, dy = next.y - this.container.y;
      const d = Math.hypot(dx, dy);
      const stepLen = SPEED * dt;
      if (d <= stepLen) { this.container.setPosition(next.x, next.y); this.path.shift(); }
      else { this.container.x += (dx / d) * stepLen; this.container.y += (dy / d) * stepLen; }
      this.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 1 : 2) : dy < 0 ? 3 : 0;
      this.frameTimer += dt;
      if (this.frameTimer > 0.12) { this.frameTimer = 0; this.step = (this.step + 1) % 3; }
      this.body.setFrame(String(this.dir * 3 + (this.step === 0 ? 1 : this.step === 1 ? 2 : 0)));
      if (!this.path.length && view.state === 'leaving') { this.gone = true; this.container.setVisible(false); }
    } else {
      this.step = 0;
      const seated = view.state !== 'walking';
      this.body.setFrame(String((seated && this.currentTarget === 'home' ? 3 : this.dir) * 3));
      if (view.state === 'working' && nowMs % 600 < 300) this.body.setFrame(String(3 * 3 + 1)); // typing twitch
    }
    if (view.tool) { const ic = ICON[view.tool]; this.icon.setText(ic.t).setStyle({ backgroundColor: ic.c }).setVisible(true); } else this.icon.setVisible(false);
    if (view.badge) { this.badge.setText(view.badge === 'error' ? '!' : '?').setStyle({ backgroundColor: view.badge === 'error' ? '#c0392b' : '#e0a030' }).setVisible(true); } else this.badge.setVisible(false);
    if (view.bubble && view.bubble.until > nowMs) {
      if (!this.bubble.visible || this.bubbleText.text !== view.bubble.text) {
        this.bubbleText.setText(view.bubble.text);
        const b = this.bubbleText.getBounds();
        this.bubbleBg.clear().fillStyle(0xffffff, 0.95).lineStyle(1, 0x333333, 1).fillRoundedRect(-b.width / 2 - 4, -b.height - 4, b.width + 8, b.height + 6, 4).strokeRoundedRect(-b.width / 2 - 4, -b.height - 4, b.width + 8, b.height + 6, 4);
        this.bubble.setVisible(true);
      }
    } else this.bubble.setVisible(false);
    this.container.setDepth(10 + this.container.y / 10000);
    if (prev.state === 'leaving' && !view.active && this.gone) this.container.setVisible(false);
    if (view.state === 'offline') this.container.setAlpha(0.35); else this.container.setAlpha(1);
  }

  debug(): Record<string, unknown> { return { role: this.view.role, state: this.view.state, target: this.view.target, currentTarget: this.currentTarget, walkingTo: this.walkingTo, pathLen: this.path.length, tile: this.tile(), seat: this.seat }; }

  destroy(): void { this.container.destroy(); }
}
