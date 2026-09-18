/**
 * The dock: what the owner can add to the office.
 *
 * A frosted plate at the foot of the campus, above the time strip, with six things on it. It is HTML rather than
 * canvas for the same reason every other control in this product is: a glyph the keyboard can reach, a label a
 * screen reader can read, and a focus ring that comes from the stylesheet rather than from a hand-drawn rectangle.
 *
 * One gesture, two ways round. A press on a glyph arms it; letting go over the office puts the thing down there,
 * and letting go over the glyph leaves it armed for a second click on the floor. So dragging and click-then-click
 * are the same code path, and neither is the one that was bolted on afterwards.
 */
import type { DockKind } from '../world/editing.js';
import type { ToolName } from '../world/layout.js';
import { esc } from './content.js';

export interface DockItem { kind: DockKind; label: string; hint: string }

/** The six, in the spec's own order. Agent first: it is the one that adds a person rather than a thing. */
export const DOCK_ITEMS: DockItem[] = [
  { kind: 'agent', label: 'Agent', hint: 'Hire someone for this desk' },
  { kind: 'browser', label: 'Browser', hint: 'A browser kiosk' },
  { kind: 'doc', label: 'Document', hint: 'A note from the vault, on a board' },
  { kind: 'note', label: 'Note', hint: 'A sticky note of your own' },
  { kind: 'site', label: 'Site', hint: 'A screen showing the live site' },
  { kind: 'station', label: 'Tool', hint: 'A tool station' },
];

export const TOOL_ITEMS: { tool: ToolName; label: string }[] = [
  { tool: 'email', label: 'Email' }, { tool: 'deploy', label: 'Deploy' },
  { tool: 'analytics', label: 'Analytics' }, { tool: 'memory', label: 'Memory' },
];

/**
 * The glyphs, as inline SVG at 20 px on a 24-grid.
 *
 * Drawn here rather than taken from `ui/icons.ts`: those are pixel icons from the tower, and the campus is
 * flat-shaded vector. A dock of pixel art over a vector office would be the one place the two styles met.
 */
const GLYPH: Record<DockKind, string> = {
  agent: '<circle cx="12" cy="8" r="3.4"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/>',
  browser: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M3.5 9.5h17"/><circle cx="6.6" cy="7.2" r=".9" fill="currentColor" stroke="none"/>',
  doc: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="M9 12h6M9 15.5h6"/>',
  note: '<path d="M5 4.5h14v10l-4.5 5H5z"/><path d="M19 14.5h-4.5v5"/><path d="M8.5 8.5h7M8.5 11.5h4"/>',
  site: '<rect x="3" y="5" width="18" height="11" rx="1.8"/><path d="M9 20h6M12 16v4"/><path d="M3 8.6h18"/>',
  // a spanner, not a toolbox: a rounded box with an arc over it reads as a padlock at 20 px, which is the
  // opposite of what a tool station is (visual QA SP9b-2)
  station: '<path d="M15.2 4.6a4.2 4.2 0 0 0-1.1 7.9L6.4 20.2a1.9 1.9 0 0 1-2.7-2.7l7.7-7.7a4.2 4.2 0 0 1 5.3-5.3z"/><circle cx="16.6" cy="6" r="2.6"/>',
};

const glyphSvg = (kind: DockKind): string =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPH[kind]}</svg>`;

export interface DockDeps {
  /** a glyph was taken: arm it, and show its ghost under the pointer */
  onArm(kind: DockKind, extra?: { tool?: ToolName; path?: string; label?: string }): void;
  /** the press that armed it was let go over the office, at these canvas coordinates */
  onDrop(x: number, y: number): void;
  /** nothing is armed any more */
  onCancel(): void;
  /** the vault notes a Document may show: `{ path, label }`, newest first */
  notes(): { path: string; label: string }[];
}

export class Dock {
  private el = document.getElementById('dock')!;
  private menuEl: HTMLDivElement;
  visible = false;
  private armed: DockKind | null = null;

  constructor(private deps: DockDeps) {
    this.el.innerHTML = `<div class="items" role="toolbar" aria-label="Add to the office">${DOCK_ITEMS.map((i) =>
      `<button class="item" data-kind="${esc(i.kind)}" aria-pressed="false" title="${esc(i.hint)}"><span class="g">${glyphSvg(i.kind)}</span><span class="l">${esc(i.label)}</span></button>`).join('')}</div><div class="menu" hidden role="menu"></div>`;
    this.menuEl = this.el.querySelector<HTMLDivElement>('.menu')!;
    this.el.hidden = true;

    for (const b of this.el.querySelectorAll<HTMLButtonElement>('.item')) {
      const kind = b.dataset.kind as DockKind;
      // The press arms; where the release lands decides whether it was a drag or a click.
      b.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        this.pick(kind, b);
      });
      b.addEventListener('pointerup', (e) => {
        if (b.hasPointerCapture(e.pointerId)) b.releasePointerCapture(e.pointerId);
        if (!this.armed || this.menuOpen) return;
        const over = document.elementFromPoint(e.clientX, e.clientY);
        if (over && (over === b || over.closest('#dock'))) return;          // a click: it stays armed
        const canvas = document.querySelector<HTMLCanvasElement>('#game canvas');
        if (!canvas) return;
        const r = canvas.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
        this.deps.onDrop(e.clientX - r.left, e.clientY - r.top);
        this.setArmed(null);
      });
      // The keyboard route: Enter or Space arms it, and the office is then placed with a click or the Org sheet.
      b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.pick(kind, b); } });
    }
    document.addEventListener('pointerdown', (e) => {
      if (this.menuOpen && !this.el.contains(e.target as Node)) this.closeMenu();
    }, true);
  }

  private get menuOpen(): boolean { return !this.menuEl.hidden; }

  /** A glyph was taken. Two of the six ask a question first. */
  private pick(kind: DockKind, from: HTMLButtonElement): void {
    this.closeMenu();
    if (this.armed === kind) { this.setArmed(null); this.deps.onCancel(); return; }
    if (kind === 'station') { this.openMenu(from, TOOL_ITEMS.map((t) => ({ label: t.label, run: () => { this.setArmed(kind); this.deps.onArm(kind, { tool: t.tool }); } }))); return; }
    if (kind === 'doc') {
      const notes = this.deps.notes();
      if (!notes.length) { this.openMenu(from, [{ label: 'No notes yet', run: () => undefined, disabled: true }]); return; }
      this.openMenu(from, notes.slice(0, 8).map((n) => ({ label: n.label, run: () => { this.setArmed(kind); this.deps.onArm(kind, { path: n.path, label: n.label }); } })));
      return;
    }
    this.setArmed(kind);
    this.deps.onArm(kind);
  }

  private setArmed(kind: DockKind | null): void {
    this.armed = kind;
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('.item')) b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
  }
  /** The office put the thing down, or dropped the idea: the dock stops looking armed. */
  clear(): void { this.setArmed(null); this.closeMenu(); }

  private openMenu(from: HTMLButtonElement, items: { label: string; run: () => void; disabled?: boolean }[]): void {
    this.menuEl.innerHTML = items.map((it, i) => `<button role="menuitem" data-i="${i}"${it.disabled ? ' disabled' : ''}>${esc(it.label)}</button>`).join('');
    this.menuEl.hidden = false;
    const r = from.getBoundingClientRect(), d = this.el.getBoundingClientRect();
    this.menuEl.style.left = `${Math.round(r.left - d.left + r.width / 2)}px`;
    for (const b of this.menuEl.querySelectorAll<HTMLButtonElement>('button')) {
      b.addEventListener('click', () => { const it = items[Number(b.dataset.i)]; this.closeMenu(); it.run(); });
    }
    this.menuEl.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }
  private closeMenu(): void { this.menuEl.hidden = true; this.menuEl.innerHTML = ''; }

  toggle(): boolean { return this.setVisible(!this.visible); }
  setVisible(on: boolean): boolean {
    this.visible = on;
    this.el.hidden = !on;
    if (!on) { this.clear(); this.deps.onCancel(); }
    else this.el.querySelector<HTMLButtonElement>('.item')?.focus();
    return this.visible;
  }
}
