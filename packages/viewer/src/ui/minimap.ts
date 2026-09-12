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

/**
 * Which of the two controls is on the screen: the strip itself, and the "Map" button that brings it back.
 *
 * `on` is whether the strip shows now; `wanted` is what the owner last asked for, as against what the current
 * elevation wants (the tower fit puts the strip away by itself — at that fit it is the same picture as the main
 * view with a viewport rectangle over all of it, visual QA R-M8). The button is the way back from a minimap the
 * owner hid, so it appears only then: offering to undo a decision the scene made and will unmake by itself is one
 * more control on the screen saying nothing.
 */
export function chromeVisibility(on: boolean, wanted: boolean | null): { strip: boolean; showBtn: boolean } {
  return { strip: on, showBtn: !on && wanted === false };
}

/**
 * Whether the strip belongs on the screen at this camera zoom, `floor` being the floor elevation's own zoom.
 *
 * It answers one question — where in the building am I — and it answers it at the floor elevation. Above that it
 * is a picture of a room laid over the room itself: in `08-board` it covered the right third of the notice board,
 * and in `11-terminal` and `14-sales` it covered desk names (visual QA R2-M4). Below it, at the tower fit, it is
 * the same picture as the main view with a viewport rectangle over all of it (R-M8).
 */
export function minimapWanted(zoom: number, floor: number): boolean { return zoom >= 1 - 1e-6 && zoom <= floor + 1e-6; }

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
    // The time bar has to stop short of this column, and only the minimap knows how wide it is (visual QA R-I3).
    document.documentElement.style.setProperty('--mm-w', `${Math.round(document.body.clientWidth - cam.x)}px`);
    const ticks = tickLayout(cam.height, colours).map((t) => `<i class="tick" data-key="tick-${t.floor}" style="top:${t.top}px;height:${t.height - 2}px;background:${t.color}"></i>`).join('');
    morph(this.el.querySelector('.ticks')!, ticks);
  }
  toggle(): void { this.setVisible(!this.visible); }
  /**
   * Show or hide the strip. The tower elevation calls this: at that fit the minimap shows the same picture as the
   * main view with a viewport rectangle over all of it, which says nothing (visual QA R-M8). `auto` is the scene
   * asking rather than the owner, so it never overrides a minimap the owner has hidden themselves.
   */
  setVisible(on: boolean, auto = false): void {
    // Once the owner has an opinion, the elevation stops having one. Without this the scene's own rule fought
    // the `M` key every half-second: press it at a room elevation and the next layout beat hid the strip again.
    if (auto && this.wanted !== null) return;
    if (!auto) this.wanted = on;
    if (this.visible === on) return;
    this.visible = on;
    const v = chromeVisibility(on, this.wanted);
    this.el.hidden = !v.strip;
    this.showBtn.hidden = !v.showBtn;
    // The time bar's cap follows the strip: with no minimap there is nothing to stop short of.
    if (!on) document.documentElement.style.setProperty('--mm-w', '0px');
    this.deps.onToggle(on);
  }
  /** What the owner last asked for, or null while they have never asked and the elevation decides. */
  private wanted: boolean | null = null;
}
