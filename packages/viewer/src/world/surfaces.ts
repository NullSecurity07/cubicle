import Phaser from 'phaser';
import type { World, Anchor } from './map.js';
import { TILE } from './tileset.js';
import type { State } from '../state.js';

export type SurfaceKind = 'billboard' | 'terminal' | 'postoffice' | 'newsstand' | 'bank' | 'vault' | 'workshop' | 'whiteboard' | 'noticeboard' | 'cabin';

/**
 * A place on the map that renders a small live preview of one stream (spec §10 "Surface") and opens a panel on click.
 * Adding an integration = an anchor in the map + a `render` case here.
 */
export class Surface {
  readonly container: Phaser.GameObjects.Container;
  private bg: Phaser.GameObjects.Rectangle;
  private text: Phaser.GameObjects.Text;
  private image: Phaser.GameObjects.Image | null = null;
  private bars: Phaser.GameObjects.Graphics;
  private badge: Phaser.GameObjects.Text;
  private lastKey = '';

  constructor(private scene: Phaser.Scene, world: World, public readonly kind: SurfaceKind, public readonly anchor: Anchor, onClick: (k: SurfaceKind) => void) {
    const x = anchor.tx * TILE, y = kind === 'whiteboard' ? (anchor.ty - 3) * TILE : anchor.ty * TILE;
    const w = anchor.tw * TILE, h = kind === 'whiteboard' ? TILE * 3 : Math.max(TILE * 2, (anchor.th - 1) * TILE);
    const inset = anchor.type === 'surface' && anchor.th > 1 ? 4 : 0;
    this.bg = scene.add.rectangle(w / 2, h / 2 + inset, w - inset * 2, h - inset, 0x0b0d11, 0.92).setStrokeStyle(1, 0x3a4050, 1);
    this.text = scene.add.text(6, 8 + inset, '', { fontFamily: 'ui-monospace, monospace', fontSize: '7px', color: '#cfe3ff', wordWrap: { width: w - 12 }, lineSpacing: 1 }).setOrigin(0, 0);
    this.bars = scene.add.graphics();
    this.badge = scene.add.text(w - 4, 4, '', { fontFamily: 'system-ui', fontSize: '9px', color: '#fff', backgroundColor: '#c0392b', padding: { x: 3, y: 1 } }).setOrigin(1, 0).setVisible(false);
    const title = scene.add.text(w / 2, -9, String(anchor.props.label ?? kind).split('—')[0].trim(), { fontFamily: 'system-ui', fontSize: '8px', color: '#ffe9a8', stroke: '#000', strokeThickness: 2 }).setOrigin(0.5, 1);
    this.container = scene.add.container(x, y, [this.bg, this.text, this.bars, this.badge, title]).setDepth(5);
    this.bg.setInteractive({ useHandCursor: true }).on('pointerdown', () => onClick(kind));
  }

  private setImage(dataUrlOrKey: string | null): void {
    if (!dataUrlOrKey) { this.image?.setVisible(false); return; }
    const key = `surface:${this.kind}`;
    const w = this.bg.width - 4, h = this.bg.height - 4;
    const apply = () => {
      if (!this.image) { this.image = this.scene.add.image(this.bg.x, this.bg.y, key).setDepth(6); this.container.add(this.image); }
      else this.image.setTexture(key);
      this.image.setDisplaySize(w, h).setVisible(true);
      this.text.setVisible(false);
    };
    if (dataUrlOrKey === this.lastKey) return;
    this.lastKey = dataUrlOrKey;
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    this.scene.textures.addBase64(key, dataUrlOrKey);
    this.scene.textures.once(`addtexture-${key}`, apply);
  }

  private setLines(lines: string[]): void {
    this.image?.setVisible(false);
    this.text.setVisible(true).setText(lines.join('\n'));
  }

  render(s: State, frames: Record<string, string>): void {
    switch (this.kind) {
      case 'billboard': {
        const active = Object.values(s.surfaces).filter((x) => x.streamKind === 'browser').sort((a, b) => Number(b.active) - Number(a.active));
        const cur = active[0];
        const data = cur ? frames[cur.streamId] : undefined;
        if (data) this.setImage(data);
        else this.setLines([cur ? (cur.active ? 'browser session live…' : 'last screenshot') : 'no browser session', cur?.lastFrame ? `/screens/${cur.lastFrame.replace('.cubicle/screens/', '')}` : '']);
        this.badge.setText(cur?.active ? 'LIVE' : '').setVisible(!!cur?.active);
        break;
      }
      case 'terminal': this.setLines(s.terminal.slice(-9).map((l) => l.slice(0, 60))); break;
      case 'postoffice': { const pending = s.pendingProposals; this.setLines(s.mail.slice(-6).map((m) => m.text.slice(0, 48))); this.badge.setText(String(pending)).setVisible(pending > 0); break; }
      case 'newsstand': this.setLines([s.latestRun ? s.latestRun.body.split('\n').filter((l) => l && !l.startsWith('---') && !l.includes(':')).slice(0, 5).join('\n') : 'no brief yet', ...s.feed.slice(-3).map((f) => `• ${f.text.slice(0, 44)}`)]); break;
      case 'bank': {
        this.text.setVisible(false); this.image?.setVisible(false);
        this.bars.clear();
        const rows = s.quota.filter((q) => q.limits.rpd > 0).slice(0, 7);
        const w = this.bg.width - 12;
        rows.forEach((q, i) => {
          const pct = Math.min(1, q.rpd_used / q.limits.rpd);
          const y = 12 + i * 11;
          this.bars.fillStyle(0x2a2e37, 1).fillRect(6, y, w, 7);
          this.bars.fillStyle(pct > 0.9 ? 0xc0392b : pct > 0.6 ? 0xe0a030 : 0x3fa34d, 1).fillRect(6, y, w * (1 - pct), 7);
        });
        if (!rows.length) this.setLines(['quota: no limits configured', 'calls today: ' + s.quota.reduce((a, q) => a + q.rpd_used, 0)]);
        break;
      }
      case 'vault': this.setLines(['click → open in Obsidian', `${Object.keys(s.jobs).length} jobs`, `${s.pendingProposals} awaiting you`]); break;
      case 'workshop': this.setLines([s.deploys.length ? `deployed: ${s.deploys.at(-1)!.url}` : 'not deployed yet', 'click → site preview']); break;
      case 'whiteboard': this.setLines(s.plan.split('\n').filter((l) => l && !l.startsWith('---') && !/^\w+:/.test(l)).slice(0, 7).map((l) => l.slice(0, 52))); break;
      case 'noticeboard': { const open = Object.values(s.jobs).filter((j) => ['queued', 'running', 'blocked'].includes(j.status)); this.setLines(open.slice(0, 4).map((j) => `${j.status[0]} ${j.assigned}: ${j.title.slice(0, 20)}`)); break; }
      case 'cabin': { const last = s.feed.filter((f) => f.text.startsWith('CEO → you')).at(-1); this.setLines([last ? last.text.slice(0, 80) : 'click → talk to the CEO']); break; }
    }
  }
}
