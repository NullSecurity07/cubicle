/** HTML chrome around the Phaser minimap camera: a frame, floor ticks in floor colours, an M toggle, click-to-pan. */
import { morph } from './morph.js';

/**
 * Building rows 2..54 inclusive — roof to ground — is 53 rows, not 52: the four floors span 2–15, 15–28, 28–41 and
 * 41–54 in `office.json`, sharing a slab row each, so the pitch is 13 but the total is 4 × 13 + 1. The minimap camera
 * (`BUILDING` in OfficeScene) frames exactly that rect, so the ticks must be 13/53 of its height, not 13/52.
 */
export const FLOOR_ROWS = 13, BUILDING_ROWS = 53;

export function tickLayout(heightPx: number, colours: Record<number, string>): { floor: number; top: number; height: number; color: string }[] {
  const h = heightPx * FLOOR_ROWS / BUILDING_ROWS;
  return [4, 3, 2, 1].map((floor, i) => ({ floor, top: Math.round(i * h), height: Math.round(h), color: colours[floor] ?? '' }));
}
/**
 * Minimap pixel → world pixel: the camera's scroll plus the offset divided by its zoom. `scrollX/scrollY` must be the
 * camera's top-left *in world space* — on a zoomed Phaser camera that is `worldView.x/y`, not the raw `scrollX`.
 */
export function minimapPointToWorld(px: number, py: number, cam: { scrollX: number; scrollY: number; zoom: number }): { x: number; y: number } {
  return { x: cam.scrollX + px / cam.zoom, y: cam.scrollY + py / cam.zoom };
}

/**
 * Everything `layout()` would write, as one string. The chrome is laid out from the rAF loop twice a second, and it
 * used to write four inline styles and morph four ticks every beat — including while it was hidden, where none of it
 * is on the screen at all. A beat whose key matches the last one writes nothing.
 */
export function layoutKey(cam: { x: number; y: number; width: number; height: number }, colours: Record<number, string>): string {
  return `${cam.x},${cam.y},${cam.width},${cam.height}|${[1, 2, 3, 4].map((n) => colours[n] ?? '').join(',')}`;
}

/** `camera()` reports the minimap viewport in screen pixels plus its world top-left (see `minimapPointToWorld`). */
export interface MinimapDeps { camera(): { x: number; y: number; width: number; height: number; scrollX: number; scrollY: number; zoom: number } | null; colours(): Record<number, string>; onPan(wx: number, wy: number): void; onToggle(visible: boolean): void }

export class MinimapChrome {
  private el = document.getElementById('minimap-chrome')!;
  private showBtn: HTMLButtonElement;
  /** What the element was last laid out for (`layoutKey`); '' means "nothing written yet". */
  private laidOut = '';
  visible = true;
  constructor(private deps: MinimapDeps) {
    // The click surface is a pointer shortcut only, never a tab stop: the keyboard reaches every floor through the
    // rail (1–4 / L), so a focusable pan target with no meaningful "activate" would only add a dead stop.
    this.el.innerHTML = `<div class="ticks" aria-hidden="true"></div><div class="click" aria-hidden="true"></div><button class="toggle glass" aria-label="Hide minimap (M)">M</button>`;
    this.el.querySelector('.toggle')!.addEventListener('click', () => this.toggle());
    this.el.querySelector<HTMLElement>('.click')!.addEventListener('click', (e) => {
      const cam = this.deps.camera(); if (!cam) return;
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const w = minimapPointToWorld(e.clientX - r.left, e.clientY - r.top, cam);
      this.deps.onPan(w.x, w.y);
    });
    this.showBtn = document.createElement('button');
    this.showBtn.id = 'minimap-toggle-hidden'; this.showBtn.className = 'mini'; this.showBtn.textContent = 'Map'; this.showBtn.setAttribute('aria-label', 'Show minimap (M)'); this.showBtn.hidden = true;
    this.showBtn.addEventListener('click', () => this.toggle());
    document.body.appendChild(this.showBtn);
  }
  /** Sit exactly over the minimap camera's viewport; call on resize and periodically (the camera appears after create). */
  layout(): void {
    const cam = this.deps.camera();
    if (!cam) { this.el.hidden = true; return; }
    this.el.hidden = !this.visible;
    if (!this.visible) return;                       // hidden: there is nothing on the screen to lay out
    const colours = this.deps.colours();
    const key = layoutKey(cam, colours);
    if (key === this.laidOut) return;                // the window has not moved and the floors have not changed hue
    this.laidOut = key;
    Object.assign(this.el.style, { left: `${cam.x - 1}px`, top: `${cam.y - 1}px`, width: `${cam.width + 2}px`, height: `${cam.height + 2}px` });
    const ticks = tickLayout(cam.height, colours).map((t) => `<i class="tick" data-key="tick-${t.floor}" style="top:${t.top}px;height:${t.height - 2}px;background:${t.color}"></i>`).join('');
    morph(this.el.querySelector('.ticks')!, ticks);
  }
  toggle(): void { this.visible = !this.visible; this.el.hidden = !this.visible; this.showBtn.hidden = this.visible; this.deps.onToggle(this.visible); }
}
