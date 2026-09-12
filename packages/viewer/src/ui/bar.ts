/** The top bar: brand, connection status, the amber approvals pill, text buttons (their `data-open` is routed by Panel). */
export class TopBar {
  private name = document.getElementById('brand-name')!;
  private tagline = document.getElementById('brand-tagline')!;
  private pending = document.getElementById('pending')!;
  private conn = document.getElementById('conn')!;
  private connText = document.getElementById('conn-text')!;

  setBrand(name: string, tagline: string): void {
    this.name.textContent = name || 'Your company';
    this.tagline.textContent = name ? tagline : 'No name yet. Tell the CEO your idea.';
  }
  /** Nothing to approve is the absence of the pill, not a grey "0 to approve" parked beside the primary button. */
  setPending(n: number): void {
    this.pending.hidden = n === 0;
    if (!n) return;
    this.pending.textContent = n === 1 ? '1 to approve' : `${n} to approve`;
    this.pending.dataset.count = String(n);
    this.pending.setAttribute('aria-label', `${n} proposals need you`);
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
