/**
 * One entry per place on the map that shows a stream (spec §10 "Surface"). Adding an integration is a registry
 * entry plus a map anchor of the same name: `headlineFor` and `viewFor` are lookups, and the scene places a
 * Surface for every entry it finds an anchor for. Nothing else needs a new branch.
 *
 * This lives in `ui/` because an entry is mostly presentation: it owns the panel HTML and the on-map preview
 * text. The dependency therefore runs one way, `world/` → `ui/`, and nothing under `ui/` imports `world/`.
 * The registry used to sit in `world/` and import the view builders back out of `ui/content.ts`, which was a
 * real import cycle held together only by every read happening inside a closure.
 */
import type { State } from '../state.js';
import type { Headline } from './headlines.js';
import { cut, planBits, briefBits } from './headlines.js';
import type { Ctx, View } from './content.js';
import { briefTitle, byUpdated, callsToday, chatHtml, chip, empty, esc, feedHtml, fmtTime, fmtWhen, isOpen, jobView, kindLabel, obsidianUrl, orgView, row, rows, section, teamJobs, who } from './content.js';
import { md } from './markdown.js';

/**
 * The map rectangle a surface hangs on, in tiles. Structurally `world/map.ts`'s `Anchor`, declared here so the
 * presentation layer never has to reach into the world layer — the scene merges the result back onto the anchor.
 */
export interface SurfaceBox { tx: number; ty: number; tw: number; th: number }

/** One bar of a chart surface. `limit` is the ceiling the bar drains towards; a limit of 0 is not drawn. */
export interface Bar { label: string; used: number; limit: number }

export interface SurfaceDef {
  /** anchor object name in the map */
  kind: string;
  streamKind: 'browser' | 'terminal' | 'markdown' | 'chart' | 'iframe' | 'list';
  /** which stream this surface is bound to */
  streamId: (s: State) => string;
  /** small on-map preview */
  headline: (s: State) => Headline;
  /** full panel */
  view: (s: State, ctx: Ctx) => View;
  /** what a `chart` surface draws: its own rows, so the drawing code never reaches into a state field of its own choosing */
  bars?: (s: State) => Bar[];
}

export const SURFACES: Record<string, SurfaceDef> = {};
export function registerSurface(def: SurfaceDef): void { SURFACES[def.kind] = def; }

export function headlineFor(kind: string, s: State): Headline {
  return SURFACES[kind]?.headline(s) ?? { head: kind, lines: [] };
}

/** The bars a chart surface draws: the entry's own rows, minus the ones with no ceiling, cropped to what fits. */
export function chartBars(def: SurfaceDef, s: State, max: number): Bar[] {
  return (def.bars?.(s) ?? []).filter((b) => b.limit > 0).slice(0, Math.max(0, max));
}

/** Which panel a click opens: a registry entry, one job note, or the org chart (the only kinds with no anchor). */
export function viewFor(kind: string, s: State, ctx: Ctx): View {
  if (kind.startsWith('job:')) return jobView(kind.slice(4), s, ctx);
  const def = SURFACES[kind];
  if (def) return def.view(s, ctx);
  if (kind === 'org') return orgView(s);
  return { mode: 'drawer', title: kind, html: empty('Nothing here yet.') };
}

/** The browser session a billboard-style surface is showing: the live one, else the most recent. */
const browserStream = (s: State): string => Object.values(s.surfaces).filter((x) => x.streamKind === 'browser').sort((a, b) => Number(b.active) - Number(a.active))[0]?.streamId ?? '';

for (const def of [
  {
    kind: 'whiteboard', streamKind: 'markdown', streamId: () => 'Plans/plan.md',
    headline: (s) => { const p = planBits(s.plan); return p.objective || p.items.length ? { head: cut(p.objective || 'This cycle', 44), lines: p.items.slice(0, 3).map((i) => '• ' + cut(i, 40)) } : { head: 'No plan yet', lines: ['The CTO writes it on heartbeat #1'] }; },
    view: (s, ctx) => ({ mode: 'doc', title: 'Plan', sub: 'Plans/plan.md', html: s.plan ? md(s.plan) : `<p class="muted">No plan yet. The CTO writes the first one during heartbeat #1.</p>`, copy: s.plan, link: obsidianUrl(ctx.vaultName, 'Plans/plan.md') }),
  },
  {
    kind: 'newsstand', streamKind: 'markdown', streamId: (s) => s.latestRun?.path ?? 'Runs/',
    headline: (s) => {
      if (!s.latestRun) { const recent = s.feed.slice(-2).reverse(); return { head: 'No brief yet', lines: recent.length ? recent.map((f) => '• ' + cut(f.text, 40)) : ['Written after each heartbeat'] }; }
      const b = briefBits(s.latestRun.body);
      const needs = b.needs.filter((n) => !/^none\b/i.test(n));
      return { head: briefTitle(s.latestRun.path).replace('Brief · ', 'Brief '), lines: [...b.happened.slice(0, 2).map((h) => '• ' + cut(h, 40)), ...(needs.length ? ['Needs you: ' + cut(needs[0], 30)] : [])], badge: needs.length ? String(needs.length) : undefined };
    },
    view: (s, ctx) => s.latestRun
      ? { mode: 'doc', title: briefTitle(s.latestRun.path), sub: s.latestRun.path, html: md(s.latestRun.body) + feedHtml(s), copy: s.latestRun.body, link: obsidianUrl(ctx.vaultName, s.latestRun.path) }
      : { mode: 'doc', title: 'Latest brief', html: `<p class="muted">No brief yet. One is written after every heartbeat.</p>` + feedHtml(s) },
  },
  {
    kind: 'noticeboard', streamKind: 'list', streamId: () => 'jobs:open',
    headline: (s) => { const open = Object.values(s.jobs).filter((j) => isOpen(j.status)).sort((a, b) => a.priority - b.priority); return { head: open.length ? `${open.length} open` : 'Queue empty', short: String(open.length), lines: open.slice(0, 3).map((j) => cut(`${j.status} · ${who(s, j.assigned)}: ${cut(j.title, 26)}`, 48)) }; },   // the tower's display names are long: clip the whole line, not only the title
    view: (s) => {
      const open = Object.values(s.jobs).filter((j) => isOpen(j.status)).sort((a, b) => a.priority - b.priority || byUpdated(a, b));
      return { mode: 'drawer', title: 'Queue', sub: `${open.length} open`, html: open.length ? teamJobs(open, s) : empty('Nothing queued. The next heartbeat plans new work.') };
    },
  },
  {
    kind: 'postoffice', streamKind: 'list', streamId: () => 'inbox',
    headline: (s) => { const n = s.inbox.length || s.pendingProposals; return { head: n ? `${n} to approve` : 'Nothing to approve', short: String(n), lines: s.inbox.slice(0, 3).map((p) => `${kindLabel(p.kind)}: ${cut(p.title, 34)}`), badge: n ? String(n) : undefined }; },
    view: (s, ctx) => {
      const list = s.inbox.length ? rows(s.inbox.map((n) => row({ left: chip('kind', kindLabel(n.kind)), title: n.title, small: n.path.replace(/^00 Inbox\//, ''), right: ctx.vaultName ? `<a href="${esc(obsidianUrl(ctx.vaultName, n.path))}">Open</a>` : esc(fmtWhen(n.created)) }))) : empty('Nothing waiting for you.');
      const mail = s.mail.length ? rows(s.mail.slice(-20).reverse().map((m) => row({ title: m.text, right: esc(fmtTime(m.ts)) }))) : empty('No mail yet.');
      return { mode: 'drawer', title: 'Post office', sub: `${s.inbox.length} to approve`, html: section('Waiting for you', list + `<p class="hintline">Approve or reject each one in 00 Inbox/ by setting approved: true or false.</p>`, s.inbox.length) + section('Mail log', mail) };
    },
  },
  {
    kind: 'bank', streamKind: 'chart', streamId: () => 'quota',
    bars: (s) => s.quota.map((q) => ({ label: q.model, used: q.rpd_used, limit: q.limits.rpd })),
    headline: (s) => { const list = s.quota.filter((q) => q.limits.rpd > 0).slice(0, 7); const total = callsToday(s); return { head: list.length ? `${total} calls today` : 'No limits set', short: String(total), lines: list.length ? list.map((q) => cut(q.model, 16)) : ['Set rpm/rpd in providers.yaml'] }; },
    view: (s) => {
      const table = s.quota.length ? `<table class="data"><tr><th>Model</th><th>Today</th><th>Runway</th><th></th></tr>${s.quota.map((q) => { const pct = q.limits.rpd ? q.rpd_used / q.limits.rpd : 0; const cls = pct > 0.9 ? 'hot' : pct > 0.6 ? 'warn' : ''; return `<tr><td>${esc(q.model)}<br><small class="muted">${esc(q.provider)}</small></td><td>${q.rpd_used}${q.limits.rpd ? ` / ${q.limits.rpd}` : ''}</td><td><div class="meter ${cls}"><i style="width:${Math.round((1 - Math.min(1, pct)) * 100)}%"></i></div></td><td>${q.cooling_until ? chip('blocked', 'cooling') : chip('done', 'ok')}</td></tr>`; }).join('')}</table>` : empty('No providers reported yet.');
      return { mode: 'drawer', title: 'Bank', sub: 'free-tier runway per model', html: section(`${callsToday(s)} calls today`, table) + `<p class="hintline">Free calls are the runway. Limits live in config/providers.yaml.</p>` };
    },
  },
  {
    kind: 'vault', streamKind: 'list', streamId: () => 'jobs',
    headline: (s) => { const all = Object.values(s.jobs); const c = (st: string): number => all.filter((j) => j.status === st).length; return { head: `${all.length} jobs`, short: String(all.length), lines: [`${c('done')} done · ${c('running')} running · ${c('blocked')} blocked`, 'Open in Obsidian'] }; },
    view: (s, ctx) => {
      const all = Object.values(s.jobs).sort(byUpdated);
      const active = all.filter((j) => isOpen(j.status));
      const done = all.filter((j) => !isOpen(j.status)).slice(0, 30);
      const link = ctx.vaultName ? `<p class="hintline"><a href="obsidian://open?vault=${encodeURIComponent(ctx.vaultName)}">Open the vault in Obsidian</a></p>` : `<p class="hintline">Add <code>?vault=&lt;name&gt;</code> to this URL to enable Obsidian links.</p>`;
      return { mode: 'drawer', title: 'Vault', sub: `${all.length} jobs`, html: section('In progress', active.length ? teamJobs(active, s) : empty('Nothing running right now.'), active.length) + section('Finished', done.length ? teamJobs(done, s) : empty('No finished jobs yet.'), done.length) + link };
    },
  },
  {
    kind: 'terminal', streamKind: 'terminal', streamId: () => 'shell',
    headline: (s) => { const last = s.terminal.slice(-3); return { head: last.length ? 'Shell' : 'Shell idle', lines: last.map((l) => cut(l, 44)) }; },
    view: (s) => ({ mode: 'drawer', title: 'Terminal shed', sub: 'shell output', html: `<pre class="term">${esc(s.terminal.slice(-160).join('\n')) || 'No commands run yet.'}</pre>` }),
  },
  {
    kind: 'billboard', streamKind: 'browser', streamId: browserStream,
    headline: (s) => { const cur = s.surfaces[browserStream(s)]; return { head: cur ? (cur.active ? 'Browser live' : 'Last screenshot') : 'No browser session', lines: cur ? [] : ['Growth and the Engineer browse here'], badge: cur?.active ? 'LIVE' : undefined }; },
    view: (s, ctx) => {
      const cur = s.surfaces[browserStream(s)];
      const src = cur ? ctx.frames[cur.streamId] ?? (cur.lastFrame ? `/screens/${cur.lastFrame.replace('.cubicle/screens/', '')}${ctx.tokenQuery}` : '') : '';
      return { mode: 'drawer', title: 'Billboard', sub: cur?.active ? 'browser session live' : cur ? 'last screenshot' : 'browser', html: src ? `<img class="frame" src="${esc(src)}" alt="browser" />` : empty('No browser session yet. Growth and the Engineer stand here while browsing.') };
    },
  },
  {
    kind: 'workshop', streamKind: 'iframe', streamId: () => '/site/',
    headline: (s) => { const url = s.deploys.at(-1)?.url; return url ? { head: 'Deployed', lines: [cut(url.replace(/^https?:\/\//, ''), 40)] } : { head: 'Not deployed yet', lines: ['Preview of Site/dist'] }; },
    view: (s, ctx) => {
      const url = s.deploys.at(-1)?.url ?? '';
      return { mode: 'drawer', title: 'Workshop', sub: url ? `deployed at ${url}` : 'site preview', html: `${url ? `<p class="hintline">Last deploy: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></p>` : ''}<iframe class="site" src="/site/${ctx.tokenQuery}" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" title="site preview"></iframe><p class="hintline">Site/dist, isolated from the office. Not deployed until you approve it.</p>` };
    },
  },
  {
    kind: 'cabin', streamKind: 'markdown', streamId: () => 'chat:ceo',
    // The brief is pinned on the cabin wall (spec §10); before there is one, the wall asks the first-run question (§12 e).
    headline: (s) => (s.latestRun ? SURFACES.newsstand.headline(s) : { head: 'What company will you start today?', lines: ['Click to tell the CEO, or say “surprise me”'] }),
    view: (s) => ({ mode: 'chat', title: s.agents.ceo?.display ?? 'CEO', sub: s.brand.name ? `${s.brand.name}${s.brand.tagline ? ` · ${s.brand.tagline}` : ''}` : 'Tell the CEO what to build, or say "surprise me"', html: chatHtml(s) }),
  },
] satisfies SurfaceDef[]) registerSurface(def);
