/**
 * What each office surface shows when opened: pure builders from State → { title, html, mode }.
 * `drawer` = right-side cards and rows; `doc` = the centered document modal; `chat` = the CEO thread.
 * No DOM here, so every builder is unit-testable.
 */
import type { State, JobView } from '../state.js';
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
const who = (s: State, role: string): string => s.agents[role]?.display ?? DISPLAY[role] ?? role;
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
const rows = (items: string[]): string => `<div class="rows">${items.join('')}</div>`;
/** A list row: [left chip] [title + optional small line] [right meta]. `open` makes it a button that opens another view. */
function row(o: { left?: string; title: string; small?: string; right?: string; open?: string }): string {
  const inner = `${o.left ?? '<span></span>'}<span class="t">${esc(o.title)}${o.small ? `<small>${esc(o.small)}</small>` : ''}</span><span class="when">${o.right ?? ''}</span>`;
  return o.open ? `<button class="row click" data-open="${esc(o.open)}">${inner}</button>` : `<div class="row">${inner}</div>`;
}

const statusChip = (status: string): string => (status === 'in_review' ? chip('in_review', 'in review') : chip(status));
const jobRow = (j: JobView, s: State): string => row({ left: statusChip(j.status), title: j.title, small: `${who(s, j.assigned)} · ${teamName(s, j.team)} · ${j.type} · step ${j.checkpoint_step}`, right: esc(fmtWhen(j.updated)), open: `job:${j.id}` });
const byUpdated = (a: JobView, b: JobView): number => b.updated.localeCompare(a.updated);

/** Section-per-team breakdown of a job list, ordered by state.teams then "Unassigned" last. */
function byTeam(jobs: JobView[], s: State): string {
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
  switch (kind) {
    case 'whiteboard': return { mode: 'doc', title: 'Plan', sub: 'Plans/plan.md', html: s.plan ? md(s.plan) : `<p class="muted">No plan yet. The CTO writes the first one during heartbeat #1.</p>`, copy: s.plan, link: obsidianUrl(ctx.vaultName, 'Plans/plan.md') };
    case 'newsstand': return s.latestRun
      ? { mode: 'doc', title: briefTitle(s.latestRun.path), sub: s.latestRun.path, html: md(s.latestRun.body) + feedHtml(s), copy: s.latestRun.body, link: obsidianUrl(ctx.vaultName, s.latestRun.path) }
      : { mode: 'doc', title: 'Latest brief', html: `<p class="muted">No brief yet. One is written after every heartbeat.</p>` + feedHtml(s) };
    case 'noticeboard': {
      const open = Object.values(s.jobs).filter((j) => ['queued', 'running', 'blocked', 'in_review'].includes(j.status)).sort((a, b) => a.priority - b.priority || byUpdated(a, b));
      return { mode: 'drawer', title: 'Queue', sub: `${open.length} open`, html: open.length ? byTeam(open, s) : empty('Nothing queued. The next heartbeat plans new work.') };
    }
    case 'vault': {
      const all = Object.values(s.jobs).sort(byUpdated);
      const active = all.filter((j) => ['queued', 'running', 'blocked', 'in_review'].includes(j.status));
      const done = all.filter((j) => !['queued', 'running', 'blocked', 'in_review'].includes(j.status)).slice(0, 30);
      const link = ctx.vaultName ? `<p class="hintline"><a href="obsidian://open?vault=${encodeURIComponent(ctx.vaultName)}">Open the vault in Obsidian</a></p>` : `<p class="hintline">Add <code>?vault=&lt;name&gt;</code> to this URL to enable Obsidian links.</p>`;
      return { mode: 'drawer', title: 'Vault', sub: `${all.length} jobs`, html: section('In progress', active.length ? byTeam(active, s) : empty('Nothing running right now.'), active.length) + section('Finished', done.length ? byTeam(done, s) : empty('No finished jobs yet.'), done.length) + link };
    }
    case 'org': {
      if (!s.teams.length) return { mode: 'drawer', title: 'Org', html: empty('No teams yet. Start the daemon once to create the default org.') };
      const jobList = Object.values(s.jobs);
      const html = s.teams.map((t) => {
        const openCount = jobList.filter((j) => j.team === t.id && ['queued', 'running', 'blocked', 'in_review'].includes(j.status)).length;
        const leadRow = row({ left: chip('kind', 'Lead'), title: who(s, t.lead), small: t.mission, open: `agent:${t.lead}` });
        const memberRows = t.members.map((m) => row({ title: who(s, m), small: roleTitle(s, m), open: `agent:${m}` }));
        return section(t.name, rows([leadRow, ...memberRows]), `${openCount} open`);
      }).join('');
      return { mode: 'drawer', title: 'Org', sub: `${s.teams.length} teams`, html };
    }
    case 'postoffice': {
      const list = s.inbox.length ? rows(s.inbox.map((n) => row({ left: chip('kind', kindLabel(n.kind)), title: n.title, small: n.path.replace(/^00 Inbox\//, ''), right: ctx.vaultName ? `<a href="${esc(obsidianUrl(ctx.vaultName, n.path))}">Open</a>` : esc(fmtWhen(n.created)) }))) : empty('Nothing waiting for you.');
      const mail = s.mail.length ? rows(s.mail.slice(-20).reverse().map((m) => row({ title: m.text, right: esc(fmtTime(m.ts)) }))) : empty('No mail yet.');
      return { mode: 'drawer', title: 'Post office', sub: `${s.inbox.length} to approve`, html: section('Waiting for you', list + `<p class="hintline">Approve or reject each one in 00 Inbox/ by setting approved: true or false.</p>`, s.inbox.length) + section('Mail log', mail) };
    }
    case 'bank': {
      const table = s.quota.length ? `<table class="data"><tr><th>Model</th><th>Today</th><th>Runway</th><th></th></tr>${s.quota.map((q) => { const pct = q.limits.rpd ? q.rpd_used / q.limits.rpd : 0; const cls = pct > 0.9 ? 'hot' : pct > 0.6 ? 'warn' : ''; return `<tr><td>${esc(q.model)}<br><small class="muted">${esc(q.provider)}</small></td><td>${q.rpd_used}${q.limits.rpd ? ` / ${q.limits.rpd}` : ''}</td><td><div class="meter ${cls}"><i style="width:${Math.round((1 - Math.min(1, pct)) * 100)}%"></i></div></td><td>${q.cooling_until ? chip('blocked', 'cooling') : chip('done', 'ok')}</td></tr>`; }).join('')}</table>` : empty('No providers reported yet.');
      return { mode: 'drawer', title: 'Bank', sub: 'free-tier runway per model', html: section(`${callsToday(s)} calls today`, table) + `<p class="hintline">Free calls are the runway. Limits live in config/providers.yaml.</p>` };
    }
    case 'terminal': return { mode: 'drawer', title: 'Terminal shed', sub: 'shell output', html: `<pre class="term">${esc(s.terminal.slice(-160).join('\n')) || 'No commands run yet.'}</pre>` };
    case 'billboard': {
      const cur = Object.values(s.surfaces).filter((x) => x.streamKind === 'browser').sort((a, b) => Number(b.active) - Number(a.active))[0];
      const src = cur ? ctx.frames[cur.streamId] ?? (cur.lastFrame ? `/screens/${cur.lastFrame.replace('.cubicle/screens/', '')}${ctx.tokenQuery}` : '') : '';
      return { mode: 'drawer', title: 'Billboard', sub: cur?.active ? 'browser session live' : cur ? 'last screenshot' : 'browser', html: src ? `<img class="frame" src="${esc(src)}" alt="browser" />` : empty('No browser session yet. Growth and the Engineer stand here while browsing.') };
    }
    case 'workshop': {
      const url = s.deploys.at(-1)?.url ?? '';
      return { mode: 'drawer', title: 'Workshop', sub: url ? `deployed at ${url}` : 'site preview', html: `${url ? `<p class="hintline">Last deploy: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></p>` : ''}<iframe class="site" src="/site/${ctx.tokenQuery}" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" title="site preview"></iframe><p class="hintline">Site/dist, isolated from the office. Not deployed until you approve it.</p>` };
    }
    case 'cabin': return { mode: 'chat', title: s.agents.ceo?.display ?? 'CEO', sub: s.brand.name ? `${s.brand.name}${s.brand.tagline ? ` · ${s.brand.tagline}` : ''}` : 'Tell the CEO what to build, or say "surprise me"', html: chatHtml(s) };
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
