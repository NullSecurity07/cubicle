import { cutWords } from './content.js';

/** The top bar: brand, connection status, the amber approvals pill, text buttons (their `data-open` is routed by Panel). */
export class TopBar {
  private name = document.getElementById('brand-name')!;
  private tagline = document.getElementById('brand-tagline')!;
  private pending = document.getElementById('pending')!;
  private conn = document.getElementById('conn')!;
  private connText = document.getElementById('conn-text')!;
  private said = '';

  constructor() { window.addEventListener('resize', () => this.paintBrand()); }

  setBrand(name: string, tagline: string): void {
    this.name.textContent = name || 'Your company';
    this.said = name ? tagline : 'No name yet. Tell the CEO your idea.';
    this.paintBrand();
  }

  /**
   * The tagline, cut at a word.
   *
   * CSS ellipsis cuts wherever the box ends, which gave "three manual, actionable website …" — a sentence that
   * stops mid-word reads as a broken string rather than as a line that goes on. The budget follows the window,
   * and the stylesheet's own ellipsis stays as the backstop for a window narrower than any budget.
   */
  private paintBrand(): void {
    this.tagline.textContent = cutWords(this.said, Math.max(24, Math.floor(window.innerWidth / 16)));
    this.tagline.title = this.said;
  }
  /**
   * Nothing to approve is the absence of the pill, not a grey "0 to approve" parked beside the primary button.
   *
   * `n` is `needsYouCount` and nothing else (ruling W6-12b) — the pill read 1 while the sheet beside it read 2.
   * The label is the pill's own words plus the noun, counted: "1 proposals need you" was on screen all run.
   */
  setPending(n: number): void {
    this.pending.hidden = n === 0;
    if (!n) return;
    this.pending.textContent = n === 1 ? '1 to approve' : `${n} to approve`;
    this.pending.dataset.count = String(n);
    this.pending.setAttribute('aria-label', n === 1 ? '1 decision needs you' : `${n} decisions need you`);
  }
  /**
   * The socket's own state, and only when it is worth saying.
   *
   * There used to be two live indicators on the screen at once: a green "live" dot up here and the Live segment of
   * the time bar's mode control (visual QA M1). The mode is the time bar's; a healthy connection is the absence of
   * a warning, so the top bar shows this only while the socket is connecting or down.
   */
  setConn(ok: boolean, text: string): void {
    this.connText.textContent = text;
    this.conn.className = `status ${ok ? 'ok' : 'bad'}`;
    this.conn.hidden = ok;
  }
}
