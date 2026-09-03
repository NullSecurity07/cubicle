/**
 * What an in-world surface says at a glance: one head line and a few short lines. Each surface's preview lives
 * in its registry entry (world/surface-registry.ts); this module holds the text helpers they share and
 * re-exports the lookup. Previews are deliberately terse so they always fit their box.
 */
export { headlineFor } from './surface-registry.js';

export interface Headline { head: string; lines: string[]; badge?: string; /** what a screen too narrow for a sentence shows instead (a count, a word) */ short?: string }

export const cut = (s: string, n: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, Math.max(0, n - 1)).trimEnd() + '…' : t; };

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
