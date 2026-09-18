/**
 * The plate beside whatever the owner has picked.
 *
 * What is selected, what it is, and up to three things to do with it. It hangs at the thing's own top-right and
 * follows the camera, because a control that is about one desk has to be beside that desk and not in a corner of
 * the screen where it could be about anything.
 *
 * HTML, not canvas: these are three buttons and a text field, and the office already has a rule about where a
 * control lives (`scripts/test-overlay-clicks.ts` — a press on an HTML element is never a press on the office).
 */
import { esc } from './content.js';

export type SelAction = 'connect' | 'rename' | 'remove';

export interface SelectionView {
  id: string;
  kind: string;
  label: string;
  sub: string;
  actions: SelAction[];
}

export interface SelectionDeps {
  /** Connect was pressed: the office goes into "now click the other end". */
  onConnect(id: string): void;
  onRemove(id: string): void;
  onRename(id: string, name: string): void;
  onDismiss(): void;
}

const LABEL: Record<SelAction, string> = { connect: 'Connect', rename: 'Rename', remove: 'Remove' };

export class SelectionPlate {
  private el = document.getElementById('selection')!;
  private cur: SelectionView | null = null;
  private renaming = false;

  constructor(private deps: SelectionDeps) {
    this.el.hidden = true;
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      if (!b || !this.cur) return;
      const id = this.cur.id;
      if (b.dataset.act === 'connect') { this.deps.onConnect(id); return; }
      if (b.dataset.act === 'remove') { this.deps.onRemove(id); return; }
      if (b.dataset.act === 'rename') { this.renaming = true; this.paint(); this.el.querySelector('input')?.focus(); }
    });
    this.el.addEventListener('keydown', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.tagName !== 'INPUT') return;
      if (e.key === 'Enter') { e.preventDefault(); if (this.cur) this.deps.onRename(this.cur.id, input.value); this.renaming = false; this.paint(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.renaming = false; this.paint(); }
    });
  }

  /** Show the plate for a selection, or hide it. */
  show(sel: SelectionView | null): void {
    const same = sel && this.cur && sel.id === this.cur.id;
    this.cur = sel;
    if (!same) this.renaming = false;
    if (!sel) { this.el.hidden = true; this.el.innerHTML = ''; return; }
    this.el.hidden = false;
    this.paint();
  }

  /** Where it hangs, in canvas pixels; null parks it out of the way without losing the selection. */
  place(at: { x: number; y: number } | null): void {
    if (!this.cur || !at) return;
    // Kept inside the frame, so a thing selected at the edge of the campus still has its plate on the screen —
    // and clear of the zone rail, which the left clamp used to put it straight on top of.
    const w = this.el.offsetWidth || 180, h = this.el.offsetHeight || 64;
    const rail = document.getElementById('rail');
    const left = (rail && !rail.hidden ? rail.getBoundingClientRect().right : 0) + 8;
    const x = Math.max(left, Math.min(window.innerWidth - w - 8, at.x + 10));
    const y = Math.max(60, Math.min(window.innerHeight - h - 76, at.y - h - 6));
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  private paint(): void {
    const s = this.cur;
    if (!s) return;
    const head = this.renaming
      ? `<input type="text" value="${esc(s.label)}" aria-label="Name" />`
      : `<strong>${esc(s.label)}</strong><span class="caption dim">${esc(s.sub)}</span>`;
    const acts = s.actions.map((a) => `<button class="mini" data-act="${a}">${LABEL[a]}</button>`).join('');
    this.el.innerHTML = `<div class="who">${head}</div><div class="acts">${acts}</div>`;
  }
}
