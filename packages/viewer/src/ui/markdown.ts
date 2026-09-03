/** Inline markdown only (bold, code) for chat bubbles and row titles; everything else is escaped text. */
export function inline(src: string): string { return esc(src).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>'); }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Tiny markdown → HTML: frontmatter stripped, headings, bullets, fences, bold, inline code, links, [[wikilinks]]. */
export function md(src: string): string {
  const text = src.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const out: string[] = [];
  let inCode = false, inList = false;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('```')) { if (inList) { out.push('</ul>'); inList = false; } inCode = !inCode; out.push(inCode ? '<pre>' : '</pre>'); continue; }
    if (inCode) { out.push(esc(raw)); continue; }
    const line = esc(raw).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[\[([^\]]+)\]\]/g, '<i>$1</i>').replace(/\[([^\]]+)\]\(((?:https?|obsidian):[^)\s]+)\)/g, (_m, t: string, u: string) => `<a href="${u.replace(/"/g, '%22')}"${u.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${t}</a>`);
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
