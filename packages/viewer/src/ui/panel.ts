/**
 * The HTML layer's one container (visual notes §5): a stack of views, one visible at a time, in one of three
 * presentations — `sheet` (right, glass, level 1), `reader` (centred document, level 2), `viewer` (centred, sized
 * by what it shows — see `View.viewer` — level 2). Push shows a trail with a back chevron, Escape pops, the last pop closes. Re-renders morph only the
 * nodes that changed, so a live frame or a growing terminal never flickers or loses its scroll position.
 */
import { esc, type View, type ViewMode } from './content.js';
import { PanelStack, type Presentation } from './stack.js';
import { morph } from './morph.js';
import { pixelIcon } from './icons.js';
import { trapTab } from './keys.js';

/** What the "Surprise me" button sends; the daemon matches this to draft three company ideas. */
export const SURPRISE_ME = 'surprise me';
/** A screen rectangle a level-2 presentation grows from (the bezel that was clicked). */
export interface Origin { x: number; y: number; w: number; h: number }
export interface PanelDeps {
  viewOf(kind: string): View; onChat(text: string): void; onOpen(kind: string): void; onLocate(target: string): void;
  /** the stack emptied: the app restores the camera */ onEmpty(): void;
  /** a control inside the open view was used: `decide:yes`, `choose:3`, `thread:<id>`, `send`, `search:<text>` */
  onAction?(act: string, o: { comment: string; text: string }): void;
  /** an `obsidian:` link was clicked; it must never navigate (SP8 ruling P8-4) */
  onVaultLink?(url: string): void;
}

export const presentationOf = (mode: ViewMode): Presentation => (mode === 'doc' ? 'reader' : mode === 'viewer' ? 'viewer' : 'sheet');
/** A duration token in ms (1 under reduced motion). */
export const durMs = (token: string): number => { const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim(); return v.endsWith('ms') ? parseFloat(v) : v.endsWith('s') ? parseFloat(v) * 1000 : 200; };

/**
 * How far the toast has to rise so it never covers a fixed action bar (ruling P8-12): the distance from the bottom
 * of the viewport up to the top of the bar, plus a gap. 0 when no bar is on the screen, which is the usual case —
 * the toast then keeps its own place above the time bar. Pure, so the arithmetic is tested without a DOM.
 */
export function toastLift(barTop: number | null, viewportH: number, gap = 12): number {
  if (barTop === null || !Number.isFinite(barTop)) return 0;
  return Math.max(0, Math.round(viewportH - barTop + gap));
}

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
  private copyTimer = 0;
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
      // One Tab trap for the whole app (ui/keys.ts): the panel used to carry a second, near-identical copy.
      if (e.key === 'Tab' && this.isModal()) trapTab(this.panel, e, document.activeElement as HTMLElement | null);
    });
    // The comment field and the composer send on Enter, like every other one-line field in the product.
    this.body.addEventListener('keydown', (e) => {
      const el = e.target as HTMLElement;
      if (e.key !== 'Enter' || !(el instanceof HTMLInputElement)) return;
      if (el.dataset.key === 'composer') { e.preventDefault(); this.fire('send'); }
      else if (el.dataset.key === 'comment') { e.preventDefault(); this.fire('decide:yes'); }
    });
    // The search box filters as it is typed; the input is keyed, so the re-render keeps the node and the caret.
    this.body.addEventListener('input', (e) => {
      const el = e.target as HTMLElement;
      if (el instanceof HTMLInputElement && el.dataset.key === 'search') this.fire(`search:${el.value}`);
    });
    document.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      // An `obsidian:` href is a hand-off, never a navigation: the office window cannot load that scheme and goes
      // blank trying (SP8 ruling P8-4). Every one of them — panel header, a row's link, a rendered note — is caught
      // here, before anything else, and given to the shell or to the clipboard.
      const vault = t.closest<HTMLAnchorElement>('a[href^="obsidian:"]');
      if (vault) { e.preventDefault(); this.deps.onVaultLink?.(vault.getAttribute('href') ?? ''); return; }
      const control = t.closest<HTMLElement>('[data-act]');
      if (control && this.panel.contains(control)) { e.preventDefault(); this.fire(control.dataset.act!); return; }
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

  /** One control was used. The two one-line fields travel with it, so a view never has to keep their text. */
  private fire(act: string): void {
    const comment = this.body.querySelector<HTMLInputElement>('input[data-key="comment"]')?.value.trim() ?? '';
    const text = this.body.querySelector<HTMLInputElement>('input[data-key="composer"]')?.value.trim() ?? '';
    this.deps.onAction?.(act, { comment, text });
  }

  /** Empty the composer after a send: the app has the text, and the field must not keep offering to send it again. */
  clearComposer(): void { const el = this.body.querySelector<HTMLInputElement>('input[data-key="composer"]'); if (el) el.value = ''; }
  /**
   * Put a sentence in the composer for the owner to finish and send.
   *
   * The cabin's own field is the one the CEO reads, so a request the office wants to make on the owner's behalf —
   * a hire dropped out of the dock (SP9b) — is written there rather than sent for them. The caret lands at the
   * first placeholder, which is the word they have to replace.
   */
  prefillComposer(text: string): void {
    const el = this.body.querySelector<HTMLInputElement>('input[data-key="composer"]') ?? this.input;
    el.value = text;
    el.focus();
    const at = text.indexOf('<');
    if (at >= 0) el.setSelectionRange(at, text.indexOf('>', at) + 1);
  }

  get current(): string | null { return this.stack.current()?.kind ?? null; }
  isModal(): boolean { const p = this.stack.current()?.presentation; return p === 'reader' || p === 'viewer'; }

  /**
   * Open `kind` on top of the stack (re-opening the current kind just re-renders it).
   *
   * `root` starts a new trail. A breadcrumb is a way back to where you came from, and the header nav is not a
   * way in from anywhere — so opening Messages from the bar while a decision reader was up read "Decisions ›
   * Messages", and after a few clicks every panel in the office claimed to live under Decisions.
   */
  show(kind: string, v: View, origin?: Origin, opts: { root?: boolean } = {}): void {
    if (!this.stack.depth) this.returnTo = document.activeElement as HTMLElement | null;
    const wasCurrent = this.current === kind;
    if (opts.root && !wasCurrent) this.stack.clear();
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
    clearTimeout(this.copyTimer); this.copyBtn.textContent = 'Copy';
    this.body.innerHTML = '';
    this.liftToast();
    this.deps.onEmpty();
    this.returnTo?.focus?.(); this.returnTo = null;
  }

  private render(kind: string, v: View, fresh: boolean, origin?: Origin): void {
    const pres = presentationOf(v.mode);
    const wasHidden = this.layer.hidden;
    const presChanged = this.layer.dataset.presentation !== pres;
    this.layer.dataset.presentation = pres;
    // Which viewer is up (ui/content.ts `View.viewer`): the browser box and the terminal box are sized differently.
    if (v.viewer) this.layer.dataset.viewer = v.viewer; else delete this.layer.dataset.viewer;
    // A sheet that asks for two panes (Messages) is given the width for them; the panes split themselves.
    if (v.wide) this.layer.dataset.wide = 'true'; else delete this.layer.dataset.wide;
    // The sheet is the one glass presentation; .glass carries the @supports fallback for no backdrop-filter.
    this.panel.classList.toggle('glass', pres === 'sheet');
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
    // A conversation scrolls inside the view, not with the sheet: it follows its newest turn unless the reader has
    // scrolled up to read something older (ui/messages.ts renders it with `data-key="thread"`).
    const threadPinned = this.threadAtBottom();
    if (fresh || presChanged) { this.body.innerHTML = v.html; } else { morph(this.body, v.html); }
    this.applySegments(kind);
    this.view = v;
    if (v.mode === 'chat' && (fresh || pinned)) this.body.scrollTop = this.body.scrollHeight;
    else if (v.live && !fresh && pinned) this.body.scrollTop = this.body.scrollHeight;
    else if (fresh) this.body.scrollTop = 0;
    const thread = this.body.querySelector<HTMLElement>('[data-key="thread"]');
    if (thread && (fresh || threadPinned)) thread.scrollTop = thread.scrollHeight;
    this.jump.hidden = !(v.live && !this.atBottom());
    this.liftToast();
    if (fresh) {
      // Land on the panel, which suppresses its own ring, and let Tab move in. Focusing the first control inside the
      // body instead painted an accent ring on the first segment of a fresh sheet: it read as pre-activated.
      if (v.mode === 'chat') this.input.focus(); else this.panel.focus?.({ preventScroll: true });
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

  /** Publish the lift for `#toast` (one rule, in the stylesheet): a toast never covers a fixed action bar. */
  private liftToast(): void {
    const bar = this.layer.hidden ? null : this.body.querySelector<HTMLElement>('.actionbar');
    const top = bar?.getBoundingClientRect?.().top ?? null;
    document.documentElement.style.setProperty('--toast-lift', `${toastLift(top ?? null, window.innerHeight)}px`);
  }

  private atBottom(): boolean { return this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 40; }
  /** True when there is no conversation open, or when it is already showing its newest turn. */
  private threadAtBottom(): boolean {
    const t = this.body.querySelector<HTMLElement>('[data-key="thread"]');
    return !t || t.scrollHeight - t.scrollTop - t.clientHeight < 40;
  }

  private selectSegment(id: string): void { if (this.current) { this.segChoice.set(this.current, id); this.applySegments(this.current); } }
  /** Segmented controls come from HTML with the first tab selected; re-apply the viewer's choice after every render. */
  private applySegments(kind: string): void {
    const want = this.segChoice.get(kind);
    if (!want) return;
    for (const tab of this.body.querySelectorAll<HTMLElement>('[data-seg]')) tab.setAttribute('aria-selected', String(tab.dataset.seg === want));
    for (const pane of this.body.querySelectorAll<HTMLElement>('[data-pane]')) pane.hidden = pane.dataset.pane !== want;
  }

  /** After a chat send: a one-line acknowledgement under the thread. */
  note(text: string): void { if (this.current === 'cabin') { const p = document.createElement('div'); p.className = 'day'; p.textContent = text; this.body.appendChild(p); this.body.scrollTop = this.body.scrollHeight; } }

  /** "Copied" reverts after `--t-copy`. The timer is cleared first, so two copies in a row do not race, and again
   *  on close, so a reverted label never lands on a panel that has since opened something else. */
  private async copy(): Promise<void> {
    try { await navigator.clipboard.writeText(this.copyText || this.body.innerText); this.copyBtn.textContent = 'Copied'; } catch { this.copyBtn.textContent = 'Copy failed'; }
    clearTimeout(this.copyTimer);
    this.copyTimer = window.setTimeout(() => { this.copyBtn.textContent = 'Copy'; }, durMs('--t-copy'));
  }
}
