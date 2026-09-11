/** Ctrl/Cmd+K or "/": fuzzy jump to a screen, a person, or a room. Pure scoring and item lists; a thin palette on top. */
import type { State } from '../state.js';
import { ROOM_LABELS, esc } from './content.js';
import { pixelIcon } from './icons.js';

export interface QuickItem { kind: string; label: string; group: 'Screens' | 'People' | 'Rooms'; hint?: string }
export const SCREEN_LABELS: Record<string, string> = { cabin: 'Talk to the CEO', newsstand: 'Brief', whiteboard: 'Plan', noticeboard: 'Queue', postoffice: 'Post office', org: 'Org', bank: 'Bank', vault: 'Vault', terminal: 'Terminal', billboard: 'Billboard', workshop: 'Workshop' };

/** 0 = no match. Subsequence match; +2 per char at a word start, +3 for a whole-prefix match, minus gaps. Empty query = 1. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase(), t = text.toLowerCase();
  if (!q) return 1;
  if (t.startsWith(q)) return 100 + q.length * 3;
  let ti = 0, score = 10, gaps = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return 0;
    if (at === 0 || /\s/.test(t[at - 1])) score += 2;
    gaps += at - ti; ti = at + 1;
  }
  return Math.max(1, score - gaps);
}

export function quickItems(s: State): QuickItem[] {
  const screens: QuickItem[] = Object.entries(SCREEN_LABELS).map(([kind, label]) => ({ kind, label, group: 'Screens' }));
  const people: QuickItem[] = Object.values(s.agents).filter((a) => a.active).map((a) => ({ kind: `agent:${a.role}`, label: a.display, group: 'People', hint: a.title }));
  const rooms: QuickItem[] = [
    ...s.teams.filter((t) => t.room && t.room !== 'ceo_office').map((t) => ({ kind: t.room!, label: t.name, group: 'Rooms' as const, hint: t.floor ? `Floor ${t.floor}` : undefined })),
    ...Object.entries(ROOM_LABELS).filter(([id]) => id !== 'ceo_office').map(([kind, label]) => ({ kind, label, group: 'Rooms' as const })),
  ];
  return [...screens, ...people, ...rooms];
}

export function rank(items: QuickItem[], query: string, limit = 8): QuickItem[] {
  return items.map((it) => ({ it, s: Math.max(fuzzyScore(query, it.label), it.hint ? fuzzyScore(query, it.hint) * 0.8 : 0) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.it);
}

export class QuickOpen {
  private el: HTMLElement; private input: HTMLInputElement; private list: HTMLElement; private sel = 0; private shown: QuickItem[] = [];
  private returnTo: HTMLElement | null = null;
  visible = false;
  constructor(private deps: { items(): QuickItem[]; onPick(kind: string): void }) {
    this.el = document.createElement('div'); this.el.id = 'quickopen'; this.el.hidden = true; this.el.setAttribute('role', 'dialog'); this.el.setAttribute('aria-modal', 'true'); this.el.setAttribute('aria-label', 'Quick open');
    this.el.innerHTML = `<input type="search" placeholder="Jump to a screen, a person, a room" aria-label="Quick open" autocomplete="off" /><div class="list" role="listbox"></div>`;
    document.body.appendChild(this.el);
    this.input = this.el.querySelector('input')!; this.list = this.el.querySelector('.list')!;
    this.input.addEventListener('input', () => { this.sel = 0; this.render(); });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.sel = Math.min(this.shown.length - 1, this.sel + 1); this.render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.sel = Math.max(0, this.sel - 1); this.render(); }
      else if (e.key === 'Enter') { e.preventDefault(); this.pick(this.sel); }
      // Escape belongs to the palette while it is open: stopping it keeps the panel's window handler from popping the sheet under it.
      else if (e.key === 'Escape') { e.stopPropagation(); this.close(); }
    });
    this.list.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]'); if (b) this.pick(Number(b.dataset.i)); });
    document.addEventListener('pointerdown', (e) => { if (this.visible && !this.el.contains(e.target as Node)) this.close(); });
  }
  open(): void { this.returnTo = document.activeElement as HTMLElement | null; this.el.hidden = false; this.visible = true; this.input.value = ''; this.sel = 0; this.render(); this.input.focus(); }
  close(): void { this.el.hidden = true; this.visible = false; this.returnTo?.focus?.(); }
  private pick(i: number): void { const it = this.shown[i]; if (!it) return; this.close(); this.deps.onPick(it.kind); }
  private render(): void {
    this.shown = rank(this.deps.items(), this.input.value.trim());
    const icon = (g: QuickItem['group']): string => pixelIcon(g === 'People' ? 'chat' : g === 'Rooms' ? 'doc' : 'chart');
    this.list.innerHTML = this.shown.length
      ? this.shown.map((it, i) => `<button class="item" role="option" data-i="${i}" aria-selected="${i === this.sel}">${icon(it.group)}<span>${esc(it.label)}${it.hint ? ` <span class="muted">${esc(it.hint)}</span>` : ''}</span><span class="k">${it.group}</span></button>`).join('')
      : `<div class="empty">${pixelIcon('doc', { size: 16 })}<b>No match</b></div>`;
  }
}
