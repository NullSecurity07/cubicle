/**
 * The HTML layer's one container (visual notes §5): a stack of views, one visible at a time, in one of three
 * presentations — `sheet` (right, glass, level 1), `reader` (centred document, level 2), `viewer` (centred 16:10,
 * level 2). Push shows a trail with a back chevron, Escape pops, the last pop closes. Re-renders morph only the
 * nodes that changed, so a live frame or a growing terminal never flickers or loses its scroll position.
 */
import { esc, type View, type ViewMode } from './content.js';
import { PanelStack, type Presentation } from './stack.js';
import { morph } from './morph.js';
import { pixelIcon } from './icons.js';

/** What the "Surprise me" button sends; the daemon matches this to draft three company ideas. */
export const SURPRISE_ME = 'surprise me';
/** A screen rectangle a level-2 presentation grows from (the bezel that was clicked). */
export interface Origin { x: number; y: number; w: number; h: number }
export interface PanelDeps { viewOf(kind: string): View; onChat(text: string): void; onOpen(kind: string): void; onLocate(target: string): void; /** the stack emptied: the app restores the camera */ onEmpty(): void }

export const presentationOf = (mode: ViewMode): Presentation => (mode === 'doc' ? 'reader' : mode === 'viewer' ? 'viewer' : 'sheet');
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** A duration token in ms (1 under reduced motion). */
export const durMs = (token: string): number => { const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim(); return v.endsWith('ms') ? parseFloat(v) : v.endsWith('s') ? parseFloat(v) * 1000 : 200; };

export class Panel {
  readonly stack = new PanelStack();
  private layer = document.getElementById('layer')!;
  private scrim = document.getElementById('scrim')!;
  private panel = document.getElementById('panel')!;
  private backBtn = document.getElementById('panel-back') as HTMLButtonElement;
  private trail = document.getElementById('panel-trail')!;
  private title = document.getElementById('panel-title')!;
  private sub = document.getElementById('panel-sub')!;
  private link = document.getElementById('panel-link') as HTMLAnchorElement;
  private copyBtn = document.getElementById('panel-copy') as HTMLButtonElement;
  private body = document.getElementById('panel-body')!;
  private jump = document.getElementById('panel-jump') as HTMLButtonElement;
  private form = document.getElementById('chat') as HTMLFormElement;
  private input = document.getElementById('chat-text') as HTMLInputElement;
  private view: View | null = null;
  private copyText = '';
  private returnTo: HTMLElement | null = null;
  private segChoice = new Map<string, string>();

  constructor(private deps: PanelDeps) {
    this.backBtn.innerHTML = pixelIcon('chevron', { rotate: 180 });
    document.getElementById('panel-close')!.innerHTML = pixelIcon('close');
    this.backBtn.addEventListener('click', () => this.back());
    document.getElementById('panel-close')!.addEventListener('click', () => this.close());
    this.scrim.addEventListener('click', () => this.back());
    this.copyBtn.addEventListener('click', () => void this.copy());
    this.jump.addEventListener('click', () => { this.body.scrollTop = this.body.scrollHeight; this.jump.hidden = true; });
    this.body.addEventListener('scroll', () => { if (this.view?.live) this.jump.hidden = this.atBottom(); });
    this.form.addEventListener('submit', (e) => { e.preventDefault(); const t = this.input.value.trim(); if (t) { this.deps.onChat(t); this.input.value = ''; } });
    // Escape goes back one level (visual notes: "Forgiveness"). Other keys live in ui/keys.ts.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.stack.depth) { e.preventDefault(); this.back(); return; }
      if (e.key === 'Tab' && this.isModal()) this.trapTab(e);
    });
    document.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const act = t.closest<HTMLElement>('[data-action="surprise-me"]');
      if (act) { e.preventDefault(); this.deps.onChat(SURPRISE_ME); return; }   // same path as the composer, so the daemon's regex fires
      const seg = t.closest<HTMLElement>('[data-seg]');
      if (seg && this.panel.contains(seg)) { this.selectSegment(seg.dataset.seg!); return; }
      const crumb = t.closest<HTMLElement>('[data-depth]');
      if (crumb && this.panel.contains(crumb)) { this.popTo(Number(crumb.dataset.depth)); return; }
      const loc = t.closest<HTMLElement>('[data-locate]');
      if (loc) { e.preventDefault(); this.deps.onLocate(loc.dataset.locate!); return; }
      const el = t.closest<HTMLElement>('[data-open]');
      if (el) { e.preventDefault(); this.deps.onOpen(el.dataset.open!); }
    });
  }

  get current(): string | null { return this.stack.current()?.kind ?? null; }
  isModal(): boolean { const p = this.stack.current()?.presentation; return p === 'reader' || p === 'viewer'; }

  /** Open `kind` on top of the stack (re-opening the current kind just re-renders it). */
  show(kind: string, v: View, origin?: Origin): void {
    if (!this.stack.depth) this.returnTo = document.activeElement as HTMLElement | null;
    const wasCurrent = this.current === kind;
    this.stack.push({ kind, title: v.title, presentation: presentationOf(v.mode) });
    this.render(kind, v, !wasCurrent, wasCurrent ? undefined : origin);
  }

  /** Re-render whatever is open from fresh state (called after every event). */
  update(kind: string, v: View): void { if (kind === this.current) this.render(kind, v, false); }

  /** Back one level; the last pop closes the panel and restores the camera. */
  back(): void { this.popTo(this.stack.depth - 1); }
  close(): void { this.popTo(0); }
  private popTo(depth: number): void {
    while (this.stack.depth > depth) this.stack.pop();
    const top = this.stack.current();
    if (!top) { this.hide(); return; }
    this.render(top.kind, this.deps.viewOf(top.kind), true);
  }
  private hide(): void {
    this.layer.hidden = true; this.scrim.hidden = true; this.view = null; this.panel.classList.remove('chat', 'flip');
    this.body.innerHTML = '';
    this.deps.onEmpty();
    this.returnTo?.focus?.(); this.returnTo = null;
  }

  private render(kind: string, v: View, fresh: boolean, origin?: Origin): void {
    const pres = presentationOf(v.mode);
    const wasHidden = this.layer.hidden;
    const presChanged = this.layer.dataset.presentation !== pres;
    this.layer.dataset.presentation = pres;
    this.layer.hidden = false;
    this.scrim.hidden = pres === 'sheet';
    this.panel.setAttribute('role', pres === 'sheet' ? 'complementary' : 'dialog');
    if (pres === 'sheet') this.panel.removeAttribute('aria-modal'); else this.panel.setAttribute('aria-modal', 'true');
    // header
    const entries = this.stack.entries();
    this.trail.innerHTML = entries.slice(0, -1).map((e, i) => `<button class="crumb" data-depth="${i + 1}">${esc(e.title)}</button><i class="sep">${pixelIcon('chevron')}</i>`).join('');
    this.backBtn.hidden = entries.length < 2;
    this.title.innerHTML = `${v.icon ? pixelIcon(v.icon) : ''}<span>${esc(v.title)}</span>`;
    this.sub.textContent = v.sub ?? ''; this.sub.hidden = !v.sub;
    this.link.hidden = !v.link; if (v.link) this.link.href = v.link;
    this.copyText = v.copy ?? ''; this.copyBtn.hidden = v.mode === 'chat' || v.mode === 'viewer';
    this.panel.classList.toggle('chat', v.mode === 'chat');
    this.form.hidden = v.mode !== 'chat';
    // body: fresh views replace, live views morph (keyed nodes keep identity: <img data-key="frame">, <pre data-key="term">)
    const pinned = this.atBottom();
    if (fresh || presChanged) { this.body.innerHTML = v.html; } else { morph(this.body, v.html); }
    this.applySegments(kind);
    this.view = v;
    if (v.mode === 'chat' && (fresh || pinned)) this.body.scrollTop = this.body.scrollHeight;
    else if (v.live && !fresh && pinned) this.body.scrollTop = this.body.scrollHeight;
    else if (fresh) this.body.scrollTop = 0;
    this.jump.hidden = !(v.live && !this.atBottom());
    if (fresh) {
      if (v.mode === 'chat') this.input.focus(); else (this.body.querySelector<HTMLElement>(FOCUSABLE) ?? this.panel).focus?.({ preventScroll: true });
      if ((wasHidden || presChanged) && origin && pres !== 'sheet') this.flipFrom(origin);
      else this.panel.classList.remove('flip');
    }
  }

  /** Grow a level-2 presentation from the screen rect that was clicked (FLIP: measure the final rect, play from the origin). */
  private flipFrom(o: Origin): void {
    const r = this.panel.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.panel.classList.add('flip');
    this.panel.animate([{ transform: `translate(${o.x - r.x}px, ${o.y - r.y}px) scale(${o.w / r.width}, ${o.h / r.height})`, opacity: 0.4 }, { transform: 'none', opacity: 1 }], { duration: durMs('--d-reader'), easing: 'cubic-bezier(.2,.8,.2,1)' });
  }

  private atBottom(): boolean { return this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 40; }

  private selectSegment(id: string): void { if (this.current) { this.segChoice.set(this.current, id); this.applySegments(this.current); } }
  /** Segmented controls come from HTML with the first tab selected; re-apply the viewer's choice after every render. */
  private applySegments(kind: string): void {
    const want = this.segChoice.get(kind);
    if (!want) return;
    for (const tab of this.body.querySelectorAll<HTMLElement>('[data-seg]')) tab.setAttribute('aria-selected', String(tab.dataset.seg === want));
    for (const pane of this.body.querySelectorAll<HTMLElement>('[data-pane]')) pane.hidden = pane.dataset.pane !== want;
  }

  private trapTab(e: KeyboardEvent): void {
    const items = [...this.panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hidden && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1], active = document.activeElement;
    if (e.shiftKey && (active === first || !this.panel.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  /** After a chat send: a one-line acknowledgement under the thread. */
  note(text: string): void { if (this.current === 'cabin') { const p = document.createElement('div'); p.className = 'day'; p.textContent = text; this.body.appendChild(p); this.body.scrollTop = this.body.scrollHeight; } }

  private async copy(): Promise<void> {
    try { await navigator.clipboard.writeText(this.copyText || this.body.innerText); this.copyBtn.textContent = 'Copied'; } catch { this.copyBtn.textContent = 'Copy failed'; }
    setTimeout(() => { this.copyBtn.textContent = 'Copy'; }, 1500);
  }
}
