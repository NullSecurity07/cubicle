/**
 * The HTML layer over the office: a right-side drawer (cards, rows, the CEO chat) and a centered document
 * modal (plan, brief, job notes). Both render a `View` from ui/content.ts; opening is routed by `view.mode`.
 */
import type { View } from './content.js';

/** What the "Surprise me" button sends; the daemon matches this to draft three company ideas. */
export const SURPRISE_ME = 'surprise me';

export class Ui {
  private drawer = document.getElementById('panel')!;
  private dTitle = document.getElementById('panel-title')!;
  private dSub = document.getElementById('panel-sub')!;
  private dCopy = document.getElementById('panel-copy') as HTMLButtonElement;
  private dBody = document.getElementById('panel-body')!;
  private form = document.getElementById('chat') as HTMLFormElement;
  private input = document.getElementById('chat-text') as HTMLInputElement;
  private modal = document.getElementById('modal')!;
  private mTitle = document.getElementById('modal-title')!;
  private mLink = document.getElementById('modal-link') as HTMLAnchorElement;
  private mBody = document.getElementById('modal-body')!;
  private brandName = document.getElementById('brand-name')!;
  private brandTagline = document.getElementById('brand-tagline')!;
  private pendingEl = document.getElementById('pending')!;
  private connEl = document.getElementById('conn')!;
  /** kind shown in the drawer / modal (e.g. `surface:cabin`, `job:job_x`), null when closed */
  current: string | null = null;
  currentDoc: string | null = null;
  private drawerCopy = '';
  private docCopy = '';
  onChat: ((text: string) => void) | null = null;
  /** any `[data-open]` click (top bar, rows) asks the app to open that kind */
  onOpen: ((kind: string) => void) | null = null;
  /** the drawer or the modal just closed (restores the camera zoom a focus zoomed in for) */
  onClose: (() => void) | null = null;

  constructor() {
    document.getElementById('panel-close')!.addEventListener('click', () => this.closeDrawer());
    document.getElementById('modal-close')!.addEventListener('click', () => this.closeDoc());
    this.modal.addEventListener('click', (e) => { if (e.target === this.modal) this.closeDoc(); });
    this.dCopy.addEventListener('click', () => void this.copy(this.drawerCopy || this.dBody.innerText, this.dCopy));
    document.getElementById('modal-copy')!.addEventListener('click', (e) => void this.copy(this.docCopy || this.mBody.innerText, e.currentTarget as HTMLButtonElement));
    this.form.addEventListener('submit', (e) => { e.preventDefault(); const t = this.input.value.trim(); if (t && this.onChat) { this.onChat(t); this.input.value = ''; } });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (this.currentDoc) this.closeDoc(); else this.closeDrawer(); } });
    document.addEventListener('click', (e) => {
      // "Surprise me" goes through the same path as the composer, so the daemon's existing regex fires.
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-action="surprise-me"]');
      if (act && this.onChat) { e.preventDefault(); this.onChat(SURPRISE_ME); return; }
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-open]');
      if (el && this.onOpen) { e.preventDefault(); this.onOpen(el.dataset.open!); }
    });
  }

  show(kind: string, v: View): void { if (v.mode === 'doc') this.openDoc(kind, v); else this.openDrawer(kind, v); }

  /** Re-render whatever is open from fresh state (called after every event). */
  update(kind: string, v: View): void {
    if (kind === this.current && v.mode !== 'doc') this.fillDrawer(v, false);
    if (kind === this.currentDoc && v.mode === 'doc') this.fillDoc(v);
  }

  private openDrawer(kind: string, v: View): void {
    this.current = kind;
    this.fillDrawer(v, true);
    this.drawer.classList.add('open');
    if (v.mode === 'chat') this.input.focus();
  }
  private fillDrawer(v: View, fresh: boolean): void {
    const atBottom = this.dBody.scrollHeight - this.dBody.scrollTop - this.dBody.clientHeight < 40;
    this.dTitle.textContent = v.title;
    this.dSub.textContent = v.sub ?? '';
    this.dSub.hidden = !v.sub;
    this.dBody.innerHTML = v.html;
    this.drawerCopy = v.copy ?? '';
    this.dCopy.hidden = v.mode === 'chat';
    this.drawer.classList.toggle('chat', v.mode === 'chat');
    this.form.hidden = v.mode !== 'chat';
    if (v.mode === 'chat' && (fresh || atBottom)) this.dBody.scrollTop = this.dBody.scrollHeight;
    else if (fresh) this.dBody.scrollTop = 0;
  }
  closeDrawer(): void { this.current = null; this.drawer.classList.remove('open', 'chat'); this.onClose?.(); }

  private openDoc(kind: string, v: View): void { this.currentDoc = kind; this.fillDoc(v); this.modal.classList.add('open'); this.mBody.scrollTop = 0; }
  private fillDoc(v: View): void {
    this.mTitle.textContent = v.title + (v.sub ? ` — ${v.sub}` : '');
    this.mBody.innerHTML = v.html;
    this.docCopy = v.copy ?? '';
    this.mLink.hidden = !v.link;
    if (v.link) this.mLink.href = v.link;
  }
  closeDoc(): void { this.currentDoc = null; this.modal.classList.remove('open'); this.onClose?.(); }

  /** After a chat send: a one-line acknowledgement under the thread. */
  note(text: string): void { if (this.current?.endsWith('cabin')) { const p = document.createElement('div'); p.className = 'day'; p.textContent = text; this.dBody.appendChild(p); this.dBody.scrollTop = this.dBody.scrollHeight; } }

  setBrand(name: string, tagline: string): void {
    this.brandName.textContent = name || 'Your company';
    this.brandTagline.textContent = name ? tagline : 'No name yet. Tell the CEO your idea.';
  }
  setPending(n: number): void { this.pendingEl.textContent = n === 1 ? '1 to approve' : `${n} to approve`; this.pendingEl.className = `pill${n ? ' attn' : ''}`; }
  setConn(ok: boolean, text: string): void { this.connEl.textContent = text; this.connEl.className = `pill ${ok ? 'quiet' : 'bad'}`; }

  private async copy(text: string, btn: HTMLButtonElement): Promise<void> {
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; } catch { btn.textContent = 'Copy failed'; }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  }
}
