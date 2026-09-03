/**
 * What each office surface shows when opened: pure builders from State → { title, html, mode }.
 * `drawer` = right-side cards and rows; `doc` = the centered document modal; `chat` = the CEO thread.
 * No DOM here, so every builder is unit-testable.
 */
import type { State, JobView } from '../state.js';
import { SURFACES } from '../world/surface-registry.js';
import { md, inline } from './markdown.js';

export type ViewMode = 'drawer' | 'doc' | 'chat';
export interface View { title: string; sub?: string; html: string; mode: ViewMode; /** raw text for the Copy button (docs) */ copy?: string; /** obsidian:// link for the modal header */ link?: string }
export interface Ctx { frames: Record<string, string>; tokenQuery: string; vaultName: string }

export const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** obsidian://open link for a vault file when the vault name is known (`?vault=`), else ''. */
export function obsidianUrl(vaultName: string, file: string): string {
  return vaultName ? `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file.replace(/\.md$/, ''))}` : '';
}

const KIND_LABEL: Record<string, string> = { spend: 'Spend', outbound_batch: 'Send batch', brand_change: 'Brand', charter_change: 'Charter', file_change: 'File change', hire: 'Hire', fire: 'Fire', message: 'Question' };
export const kindLabel = (k: string): string => KIND_LABEL[k] ?? k.replace(/_/g, ' ');

const DISPLAY: Record<string, string> = { ceo: 'CEO', cto: 'CTO', coo: 'COO', engineer: 'Engineer', growth: 'Growth', head_of_growth: 'Head of Growth', tech_lead: 'Tech Lead', qa: 'QA', critic: 'Critic', research_analyst: 'Research' };
export const who = (s: State, role: string): string => s.agents[role]?.display ?? DISPLAY[role] ?? role;
const roleTitle = (s: State, role: string): string => s.agents[role]?.title || role;
const teamName = (s: State, id?: string): string => (id ? s.teams.find((t) => t.id === id)?.name ?? id : 'Unassigned');

export function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
export function fmtWhen(ts: string, now = new Date()): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? fmtTime(ts) : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${fmtTime(ts)}`;
}

export const chip = (status: string, label = status): string => `<span class="chip ${esc(status)}">${esc(label)}</span>`;
export const section = (title: string, body: string, count?: number | string): string => `<div class="section"><h3>${esc(title)}${count !== undefined ? `<span class="count">${esc(String(count))}</span>` : ''}</h3>${body}</div>`;
export const empty = (text: string): string => `<div class="empty">${esc(text)}</div>`;
export const rows = (items: string[]): string => `<div class="rows">${items.join('')}</div>`;
/** A list row: [left chip] [title + optional small line] [right meta]. `open` makes it a button that opens another view. */
export function row(o: { left?: string; title: string; small?: string; right?: string; open?: string }): string {
  const inner = `${o.left ?? '<span></span>'}<span class="t">${esc(o.title)}${o.small ? `<small>${esc(o.small)}</small>` : ''}</span><span class="when">${o.right ?? ''}</span>`;
  return o.open ? `<button class="row click" data-open="${esc(o.open)}">${inner}</button>` : `<div class="row">${inner}</div>`;
}

const statusChip = (status: string): string => (status === 'in_review' ? chip('in_review', 'in review') : chip(status));
const jobRow = (j: JobView, s: State): string => row({ left: statusChip(j.status), title: j.title, small: `${who(s, j.assigned)} · ${teamName(s, j.team)} · ${j.type} · step ${j.checkpoint_step}`, right: esc(fmtWhen(j.updated)), open: `job:${j.id}` });
export const byUpdated = (a: JobView, b: JobView): number => b.updated.localeCompare(a.updated);
/** Jobs the office is still working on (as opposed to done / failed / cancelled). */
export const isOpen = (status: string): boolean => ['queued', 'running', 'blocked', 'in_review'].includes(status);

/** Section-per-team breakdown of a job list, ordered by state.teams then "Unassigned" last. */
export function teamJobs(jobs: JobView[], s: State): string {
  const order = [...s.teams.map((t) => t.id), ''];
  const groups = new Map<string, JobView[]>();
  for (const j of jobs) { const key = j.team ?? ''; const g = groups.get(key) ?? []; g.push(j); groups.set(key, g); }
  return [...groups.keys()]
    .sort((x, y) => order.indexOf(x) - order.indexOf(y))
    .map((k) => section(teamName(s, k || undefined), rows(groups.get(k)!.map((j) => jobRow(j, s))), groups.get(k)!.length))
    .join('');
}

/** Total free-tier calls made today, across every provider and model the daemon reported. */
export const callsToday = (s: State): number => s.quota.reduce((n, q) => n + (q.rpd_used || 0), 0);

/** The decision feed: decisions, proposals, vetoes, guardrail hits, deploys and org changes, newest first. */
export function feedHtml(s: State): string {
  const items = s.feed.slice(-30).reverse();
  return section('Decision feed', items.length ? rows(items.map((f) => row({ title: f.text, right: esc(fmtTime(f.ts)) }))) : empty('Nothing decided yet. Decisions, proposals and guardrail hits appear here.'), items.length || undefined);
}

/** Title of a Runs/ brief from its path (Runs/2026-09-03-1016.md → "Brief · 3 Sep 10:16"). */
export function briefTitle(path: string): string {
  const m = path.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/);
  return m ? `Brief · ${fmtWhen(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`)}` : 'Latest brief';
}

export function viewFor(kind: string, s: State, ctx: Ctx): View {
  if (kind.startsWith('job:')) return jobView(kind.slice(4), s, ctx);
  const def = SURFACES[kind];
  if (def) return def.view(s, ctx);
  // The org chart has no place on the map: it is opened from the top bar, not by walking to a building.
  if (kind === 'org') {
    if (!s.teams.length) return { mode: 'drawer', title: 'Org', html: empty('No teams yet. Start the daemon once to create the default org.') };
    const jobList = Object.values(s.jobs);
    const html = s.teams.map((t) => {
      const openCount = jobList.filter((j) => j.team === t.id && isOpen(j.status)).length;
      const leadRow = row({ left: chip('kind', 'Lead'), title: who(s, t.lead), small: t.mission, open: `agent:${t.lead}` });
      const memberRows = t.members.map((m) => row({ title: who(s, m), small: roleTitle(s, m), open: `agent:${m}` }));
      return section(t.name, rows([leadRow, ...memberRows]), `${openCount} open`);
    }).join('');
    return { mode: 'drawer', title: 'Org', sub: `${s.teams.length} teams`, html };
  }
  return { mode: 'drawer', title: kind, html: empty('Nothing here yet.') };
}

function jobView(id: string, s: State, ctx: Ctx): View {
  const j = s.jobs[id];
  if (!j) return { mode: 'drawer', title: 'Job', html: empty('This job is not in the current snapshot.') };
  const body = `<p>${chip(j.status)} &nbsp;<span class="muted">${esc(who(s, j.assigned))} · ${esc(j.type)} · priority ${j.priority} · step ${j.checkpoint_step}</span></p><p class="muted">Updated ${esc(fmtWhen(j.updated))}. The full note, checkpoint log and result live in the vault.</p>`;
  return { mode: 'doc', title: j.title, sub: `Jobs/${j.id}.md`, html: body, link: obsidianUrl(ctx.vaultName, `Jobs/${j.id}.md`) };
}

export function chatHtml(s: State): string {
  const pinned = s.latestRun ? `<details class="pinned"><summary>${esc(briefTitle(s.latestRun.path))}</summary><div class="prose">${md(s.latestRun.body)}</div></details>` : '';
  if (!s.chat.length) return pinned + `<div class="empty first-run"><b>What company will you start today?</b><span>Describe the company you want, or type “surprise me” for three ideas.</span><button data-action="surprise-me">Surprise me</button></div>`;
  let lastDay = '';
  const out: string[] = [pinned];
  for (const m of s.chat.slice(-60)) {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) { lastDay = day; out.push(`<div class="day">${esc(day === new Date().toDateString() ? 'Today' : new Date(m.ts).toLocaleDateString([], { day: 'numeric', month: 'short' }))}</div>`); }
    out.push(`<div class="msg ${m.from === 'you' ? 'me' : 'ceo'}"><div class="who"><b>${m.from === 'you' ? 'You' : 'CEO'}</b><span>${esc(fmtTime(m.ts))}</span></div><div class="bubble">${inline(m.text)}</div></div>`);
  }
  return out.join('');
}
