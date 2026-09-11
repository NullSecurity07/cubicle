/**
 * What an in-world surface says at a glance: one head line and a few short lines. Each surface's preview lives
 * in its registry entry (ui/surfaces.ts); this module holds the text helpers they share. Previews are
 * deliberately terse so they always fit their box. A leaf: it imports nothing, so nothing here can cycle.
 */

export interface Headline { head: string; lines: string[]; badge?: string; /** what a screen too narrow for a sentence shows instead (a count, a word) */ short?: string }

/**
 * `s` in at most `n` columns, ending on a whole word. Slicing at a character count gave "What company wil…" and
 * "Queue…"; nothing is abbreviated where a word fits. A single word longer than the budget is still cut mid-word —
 * there is no boundary to fall back to — and a cut that would throw away more than half the budget keeps the
 * partial word rather than leaving a near-empty line.
 */
export const cut = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const room = Math.max(0, n - 1);                     // one column for the ellipsis
  const head = t.slice(0, room);
  const space = head.lastIndexOf(' ');
  const kept = space > room / 2 ? head.slice(0, space) : head;
  return kept.trimEnd() + '…';
};

/** Objective sentence and "This cycle" bullets from Plans/plan.md. */
export function planBits(plan: string): { objective: string; items: string[] } {
  const lines = plan.replace(/^---\n[\s\S]*?\n---\n?/, '').split('\n');
  let objective = '', sec = '';
  const items: string[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (/^##\s/.test(l)) { sec = l.replace(/^##\s*/, '').toLowerCase(); continue; }
    if (!l || l.startsWith('#')) continue;
    if (sec.startsWith('objective') && !objective) objective = l;
    if (sec.startsWith('this cycle') && /^[-*]\s|^\[ \]/.test(l)) items.push(l.replace(/^[-*]\s*(\[[ x]\]\s*)?/, ''));
  }
  return { objective, items };
}

/** "What happened" and "What needs you" bullets from a Runs/ brief. */
export function briefBits(body: string): { happened: string[]; needs: string[] } {
  const lines = body.replace(/^---\n[\s\S]*?\n---\n?/, '').split('\n');
  let sec = '';
  const happened: string[] = [], needs: string[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (l.startsWith('---')) break; // the "Facts used" footer
    if (/^##\s/.test(l)) { sec = l.replace(/^##\s*/, '').toLowerCase(); continue; }
    if (!/^[-*]\s/.test(l)) continue;
    const item = l.replace(/^[-*]\s*/, '');
    if (sec.includes('happened')) happened.push(item);
    else if (sec.includes('needs you')) needs.push(item);
  }
  return { happened, needs };
}
