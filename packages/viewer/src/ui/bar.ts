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
  setPending(n: number): void {
    this.pending.textContent = n === 1 ? '1 to approve' : `${n} to approve`;
    this.pending.dataset.count = String(n);
    this.pending.setAttribute('aria-label', n ? `${n} proposals need you` : 'nothing to approve');
  }
  setConn(ok: boolean, text: string): void { this.connText.textContent = text; this.conn.className = `status ${ok ? 'ok' : 'bad'}`; }
}
