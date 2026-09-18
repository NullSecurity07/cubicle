/** Inline markdown only (bold, code) for chat bubbles and row titles; everything else is escaped text. */
export function inline(src: string): string { return esc(src).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>'); }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/**
 * `_emphasis_`, and only where it is emphasis (W5-3).
 *
 * Anchored on whitespace and punctuation rather than on "not a word character", so `score_inputs`,
 * `job_20260918_c70b39` and a URL's own underscores are printed as they were typed, and only a run of text the
 * note really wrapped becomes italic. `*` is left to `**bold**`, which is the only star this reader has ever
 * rendered. Run over already-escaped text, so `_<b>_` is still shown, never obeyed.
 *
 * `<em>`, not `<i>`: `<i>` is this reader's [[wikilink]], and `.prose i` is deliberately *not* italic. Two
 * meanings need two tags, or rendering the emphasis would have printed it upright.
 */
const EM = /(^|[\s(["'>])_([^_`\n]+)_(?=$|[\s.,;:!?)\]"'<])/g;

/** A line that is only three or more `-`, `*` or `_`: a horizontal rule, which the reader used to print as text. */
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Tiny markdown → HTML: frontmatter stripped, headings, rules, bullets, fences, bold, italics, inline code,
 * links, [[wikilinks]].
 *
 * An `obsidian:` link is rendered as a secondary affordance (`.vaultlink`) and carries `data-obsidian`: the panel's
 * delegated handler never lets one navigate — a scheme the office window cannot load blanks it (SP8 ruling P8-4) —
 * and hands it to the shell, or copies the note's path.
 */
export function md(src: string): string {
  const text = src.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const out: string[] = [];
  let inCode = false, inList = false;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('```')) { if (inList) { out.push('</ul>'); inList = false; } inCode = !inCode; out.push(inCode ? '<pre>' : '</pre>'); continue; }
    if (inCode) { out.push(esc(raw)); continue; }
    if (RULE.test(raw)) { if (inList) { out.push('</ul>'); inList = false; } out.push('<hr>'); continue; }
    const line = esc(raw).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(EM, '$1<em>$2</em>').replace(/\[\[([^\]]+)\]\]/g, '<i>$1</i>').replace(/\[([^\]]+)\]\(((?:https?|obsidian):[^)\s]+)\)/g, (_m, t: string, u: string) => `<a href="${u.replace(/"/g, '%22')}"${u.startsWith('http') ? ' target="_blank" rel="noopener"' : ' class="vaultlink" data-obsidian="1"'}>${t}</a>`);
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
