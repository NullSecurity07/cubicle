/**
 * What an in-world surface says at a glance: one head line and a few short lines. The full content lives in
 * the HTML layer (ui/content.ts); these previews are deliberately terse so they always fit their box.
 */
import type { State } from '../state.js';
import { briefTitle, kindLabel } from '../ui/content.js';

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

const DISPLAY: Record<string, string> = { ceo: 'CEO', cto: 'CTO', coo: 'COO', engineer: 'Engineer', growth: 'Growth', head_of_growth: 'Head of Growth', tech_lead: 'Tech Lead', qa: 'QA', critic: 'Critic', research_analyst: 'Research' };
const who = (s: State, role: string): string => s.agents[role]?.display ?? DISPLAY[role] ?? role;

export function headlineFor(kind: string, s: State): Headline {
  switch (kind) {
    case 'whiteboard': { const p = planBits(s.plan); return p.objective || p.items.length ? { head: cut(p.objective || 'This cycle', 44), lines: p.items.slice(0, 3).map((i) => '• ' + cut(i, 40)) } : { head: 'No plan yet', lines: ['The CTO writes it on heartbeat #1'] }; }
    case 'newsstand': { if (!s.latestRun) return { head: 'No brief yet', lines: ['Written after each heartbeat'] }; const b = briefBits(s.latestRun.body); const needs = b.needs.filter((n) => !/^none\b/i.test(n)); return { head: briefTitle(s.latestRun.path).replace('Brief · ', 'Brief '), lines: [...b.happened.slice(0, 2).map((h) => '• ' + cut(h, 40)), ...(needs.length ? ['Needs you: ' + cut(needs[0], 30)] : [])], badge: needs.length ? String(needs.length) : undefined }; }
    case 'noticeboard': { const open = Object.values(s.jobs).filter((j) => ['queued', 'running', 'blocked', 'in_review'].includes(j.status)).sort((a, b) => a.priority - b.priority); return { head: open.length ? `${open.length} open` : 'Queue empty', short: String(open.length), lines: open.slice(0, 3).map((j) => `${j.status} · ${who(s, j.assigned)}: ${cut(j.title, 26)}`) }; }
    case 'postoffice': { const n = s.inbox.length || s.pendingProposals; return { head: n ? `${n} to approve` : 'Nothing to approve', short: String(n), lines: s.inbox.slice(0, 3).map((p) => `${kindLabel(p.kind)}: ${cut(p.title, 34)}`), badge: n ? String(n) : undefined }; }
    case 'terminal': { const last = s.terminal.slice(-3); return { head: last.length ? 'Shell' : 'Shell idle', lines: last.map((l) => cut(l, 44)) }; }
    case 'vault': { const all = Object.values(s.jobs); const c = (st: string) => all.filter((j) => j.status === st).length; return { head: `${all.length} jobs`, short: String(all.length), lines: [`${c('done')} done · ${c('running')} running · ${c('blocked')} blocked`, 'Open in Obsidian'] }; }
    case 'workshop': { const url = s.deploys.at(-1)?.url; return url ? { head: 'Deployed', lines: [cut(url.replace(/^https?:\/\//, ''), 40)] } : { head: 'Not deployed yet', lines: ['Preview of Site/dist'] }; }
    case 'cabin': { const last = s.chat.filter((c) => c.from === 'ceo').at(-1); return last ? { head: 'CEO', lines: [cut(last.text, 96)] } : { head: 'Talk to the CEO', lines: ['Click to start a company'] }; }
    case 'billboard': { const cur = Object.values(s.surfaces).filter((x) => x.streamKind === 'browser').sort((a, b) => Number(b.active) - Number(a.active))[0]; return { head: cur ? (cur.active ? 'Browser live' : 'Last screenshot') : 'No browser session', lines: cur ? [] : ['Growth and the Engineer browse here'], badge: cur?.active ? 'LIVE' : undefined }; }
    case 'bank': { const rows = s.quota.filter((q) => q.limits.rpd > 0).slice(0, 7); return { head: rows.length ? 'Runway' : 'No limits set', lines: rows.map((q) => cut(q.model, 16)) }; }
  }
  return { head: kind, lines: [] };
}
