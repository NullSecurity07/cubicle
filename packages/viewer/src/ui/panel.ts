/** Side panel: renders a title + markdown-ish body (headings, bullets, code fences, images) and an optional chat form. */
export class Panel {
  private el = document.getElementById('panel')!;
  private title = document.getElementById('panel-title')!;
  private body = document.getElementById('panel-body')!;
  private form = document.getElementById('chat') as HTMLFormElement;
  private input = document.getElementById('chat-text') as HTMLInputElement;
  current: string | null = null;
  onChat: ((text: string) => void) | null = null;

  constructor() {
    document.getElementById('panel-close')!.addEventListener('click', () => this.close());
    this.form.addEventListener('submit', (e) => { e.preventDefault(); const t = this.input.value.trim(); if (t && this.onChat) { this.onChat(t); this.input.value = ''; } });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
  }

  open(kind: string, title: string, html: string, opts: { chat?: boolean } = {}): void {
    this.current = kind;
    this.title.textContent = title;
    this.body.innerHTML = html;
    this.form.hidden = !opts.chat;
    this.el.classList.add('open');
    if (opts.chat) this.input.focus();
  }

  update(kind: string, html: string): void { if (this.current === kind) this.body.innerHTML = html; }
  close(): void { this.current = null; this.el.classList.remove('open'); }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Tiny markdown → HTML: frontmatter stripped, headings, bullets, fences, bold, inline code, links, [[wikilinks]]. */
export function md(src: string): string {
  const text = src.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const out: string[] = [];
  let inCode = false, inList = false;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('```')) { if (inList) { out.push('</ul>'); inList = false; } inCode = !inCode; out.push(inCode ? '<pre>' : '</pre>'); continue; }
    if (inCode) { out.push(esc(raw)); continue; }
    const line = esc(raw).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[\[([^\]]+)\]\]/g, '<i>$1</i>').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${li[1]}</li>`); continue; }
    if (inList) { out.push('</ul>'); inList = false; }
    if (h) out.push(`<h${h[1].length + 1}>${h[2]}</h${h[1].length + 1}>`);
    else if (line.trim() === '') out.push('');
    else out.push(`<p>${line}</p>`);
  }
  if (inList) out.push('</ul>');
  if (inCode) out.push('</pre>');
  return out.join('\n');
}
