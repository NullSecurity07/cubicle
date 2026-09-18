/**
 * The minimap: a small isometric thumbnail of the campus, bottom-right, with the viewport rectangle over it.
 *
 * The chrome owns the canvas now rather than framing a second camera — there is one renderer, and it draws the
 * thumbnail into whatever canvas it is handed (`world/minimap-draw.ts`). What is left here is the frame, the M
 * toggle, click-to-pan, and the rule about when the strip belongs on the screen at all.
 */

/** The thumbnail's size in CSS pixels. The campus is 2:1 in this projection, so the box is too, plus a little air. */
export const MINIMAP_W = 208, MINIMAP_H = 116;

/**
 * Whether the strip belongs on the screen at this camera zoom.
 *
 * It answers one question — where in the campus am I — and it answers it once the camera is close enough that the
 * answer is not already on the screen. At the campus overview the main view *is* the minimap, with a viewport
 * rectangle drawn over all of it, which says nothing.
 */
export function minimapWanted(zoom: number, overview: number): boolean { return zoom > overview * 1.25; }

/**
 * Which of the two controls is on the screen: the strip itself, and the "Map" button that brings it back.
 *
 * `on` is whether the strip shows now; `wanted` is what the owner last asked for. The button is the way back from
 * a minimap the owner hid, so it appears only then.
 */
export function chromeVisibility(on: boolean, wanted: boolean | null): { strip: boolean; showBtn: boolean } {
  return { strip: on, showBtn: !on && wanted === false };
}

export interface MinimapDeps {
  /** hand the renderer the canvas to draw the thumbnail into */
  attach(canvas: HTMLCanvasElement | null): void;
  /** a click inside the thumbnail, as a fraction of its box */
  onPan(px: number, py: number, w: number, h: number): void;
  onToggle(visible: boolean): void;
}

export class MinimapChrome {
  private el = document.getElementById('minimap-chrome')!;
  private canvas: HTMLCanvasElement;
  private showBtn: HTMLButtonElement;
  visible = true;
  private wanted: boolean | null = null;
  private placed = '';

  constructor(private deps: MinimapDeps) {
    this.el.innerHTML = '<canvas class="mm" aria-hidden="true"></canvas><div class="click" aria-hidden="true"></div><button class="toggle glass" aria-label="Hide minimap (M)">M</button>';
    this.canvas = this.el.querySelector<HTMLCanvasElement>('canvas.mm')!;
    Object.assign(this.canvas.style, { width: '100%', height: '100%', display: 'block' });
    this.el.querySelector('.toggle')!.addEventListener('click', () => this.toggle());
    this.el.querySelector<HTMLElement>('.click')!.addEventListener('click', (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      this.deps.onPan(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    });
    this.showBtn = document.createElement('button');
    this.showBtn.id = 'minimap-toggle-hidden';
    this.showBtn.className = 'mini';
    this.showBtn.textContent = 'Map';
    this.showBtn.setAttribute('aria-label', 'Show minimap (M)');
    this.showBtn.hidden = true;
    this.showBtn.addEventListener('click', () => this.toggle());
    document.body.appendChild(this.showBtn);
    this.deps.attach(this.canvas);
  }

  /** Put the strip in the bottom-right corner, above the time bar; called on resize and on a slow beat. */
  layout(): void {
    this.el.hidden = !this.visible;
    if (!this.visible) return;
    const key = `${document.body.clientWidth}x${document.body.clientHeight}`;
    if (key === this.placed) return;
    this.placed = key;
    Object.assign(this.el.style, { width: `${MINIMAP_W}px`, height: `${MINIMAP_H}px` });
    // The time bar has to stop short of this column, and only the minimap knows how wide it is.
    document.documentElement.style.setProperty('--mm-w', `${MINIMAP_W + 28}px`);
  }

  toggle(): void { this.setVisible(!this.visible); }

  /**
   * Show or hide the strip. `auto` is the renderer asking rather than the owner, so it never overrides a minimap
   * the owner has hidden themselves.
   */
  setVisible(on: boolean, auto = false): void {
    if (auto && this.wanted !== null) return;
    if (!auto) this.wanted = on;
    if (this.visible === on) return;
    this.visible = on;
    const v = chromeVisibility(on, this.wanted);
    this.el.hidden = !v.strip;
    this.showBtn.hidden = !v.showBtn;
    this.placed = '';
    if (!on) document.documentElement.style.setProperty('--mm-w', '0px');
    this.deps.attach(on ? this.canvas : null);
    this.deps.onToggle(on);
  }
}
