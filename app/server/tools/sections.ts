// The markdown headings of a document and the text that belongs to each, for the two doc tools that must not lose a
// colleague's work: write_doc checks what a rewrite would drop, and replace_section swaps the text under one heading.
// A line inside a fenced code block is never a heading, however it starts.

export type Heading = { level: number; title: string; line: number };

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

export const headingKey = (title: string) => title.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();

export function headings(text: string): Heading[] {
  const found: Heading[] = [];
  let fenced = false;
  text.split('\n').forEach((line, index) => {
    if (FENCE.test(line)) { fenced = !fenced; return; }
    const match = fenced ? null : HEADING.exec(line);
    if (match) found.push({ level: match[1].length, title: match[2], line: index });
  });
  return found;
}

// Why a whole-document rewrite would lose too much of what is already there, or null when it would not: more than
// 40% of the headings gone, or more than half of the characters. Small models asked to change one section have
// been seen to hand back only that section, and with it the rest of a shared document was gone.
export function rewriteLoss(before: string, after: string): string | null {
  const old = before.trim();
  if (!old) return null;
  const kept = new Set(headings(after).map((one) => headingKey(one.title)));
  const had = headings(old);
  const lost = had.filter((one) => !kept.has(headingKey(one.title)));
  const reasons: string[] = [];
  if (had.length && lost.length / had.length > 0.4) reasons.push(`it drops ${lost.length} of its ${had.length} sections (${lost.map((one) => `"${one.title}"`).join(', ')})`);
  if (after.trim().length < old.length * 0.5) reasons.push(`it keeps only ${after.trim().length} of its ${old.length} characters`);
  return reasons.length ? reasons.join(' and ') : null;
}

// The document with the text under one heading swapped for `body`: everything from the line after the heading up to
// the next heading of the same or a higher level (fewer #), or the end. The heading line itself stays as it was.
export function replaceSection(text: string, heading: string, body: string): { text: string } | { error: string } {
  const all = headings(text);
  const key = headingKey(heading);
  const hits = all.filter((one) => headingKey(one.title) === key);
  const listed = all.map((one) => `"${one.title}"`).join(', ') || 'none';
  if (!hits.length) return { error: `no heading "${heading.replace(/^#+\s*/, '').trim()}" in this document. Its headings: ${listed}. To add a new section, use append_doc.` };
  if (hits.length > 1) return { error: `more than one heading is called "${hits[0].title}", so it is not clear which to change. Its headings: ${listed}. Rewrite the whole document with write_doc, keeping one of them.` };
  const [hit] = hits;
  const next = all.find((one) => one.line > hit.line && one.level <= hit.level);
  const lines = text.split('\n');
  // A model often repeats the heading at the top of the new text; it is already there, so it is not written twice.
  let fresh = body.replace(/\s+$/, '');
  const first = HEADING.exec(fresh.split('\n')[0] ?? '');
  if (first && headingKey(first[2]) === key) fresh = fresh.split('\n').slice(1).join('\n');
  fresh = fresh.replace(/^\s*\n/, '').trim();
  const head = lines.slice(0, hit.line + 1).join('\n');
  const tail = next ? lines.slice(next.line).join('\n') : '';
  return { text: `${head}\n\n${fresh ? `${fresh}\n` : ''}${tail ? `\n${tail}` : ''}`.replace(/\n{3,}$/, '\n\n') };
}

// One of `named` that this write adds a second copy of, or null. A second "## 5. Verdict" appended at the end is how a
// judge once wrote a verdict the checks on the first never saw.
export function addedTwice(before: string, after: string, named: string[]): string | null {
  const keys = new Set(named.map(headingKey));
  const count = (text: string) => {
    const seen = new Map<string, { title: string; times: number }>();
    for (const one of headings(text)) {
      const key = headingKey(one.title);
      if (keys.has(key)) seen.set(key, { title: one.title, times: (seen.get(key)?.times ?? 0) + 1 });
    }
    return seen;
  };
  const was = count(before);
  for (const [key, now] of count(after)) {
    const had = was.get(key)?.times ?? 0;
    if (had >= 1 && now.times > had) return now.title;
  }
  return null;
}
