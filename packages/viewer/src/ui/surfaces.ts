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
import { boardHeadline } from './board.js';
import type { Ctx, View } from './content.js';
import { agentView, bankView, browserStream, browserViewerView, briefTitle, byUpdated, callsToday, chatHtml, emptyHtml, esc, feedHtml, isOpen, isRoom, jobView, kindLabel, obsidianUrl, orgView, postOfficeView, queueView, roomView, section, teamJobs, terminalViewerView, who } from './content.js';
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
  if (kind.startsWith('agent:')) return agentView(kind.slice(6), s, ctx);
  if (kind === 'ceo_office') kind = 'cabin';            // the CEO office is the cabin chat (visual notes §6)
  const def = SURFACES[kind];
  if (def) return def.view(s, ctx);
  if (kind === 'org') return orgView(s, ctx);
  if (isRoom(kind, s)) return roomView(kind, s);
  return { mode: 'drawer', title: kind, html: emptyHtml('doc', 'Nothing here yet') };
}

for (const def of [
  {
    kind: 'whiteboard', streamKind: 'markdown', streamId: () => 'Plans/plan.md',
    headline: (s) => {
      const b = boardHeadline(s.board, s.now);
      if (b) return b;
      const p = planBits(s.plan);
      return p.objective || p.items.length
        ? { head: cut(p.objective || 'This cycle', 44), lines: p.items.slice(0, 3).map((i) => '• ' + cut(i, 26)) }
        : { head: 'No plan yet', lines: ['The CEO writes the first', 'one on heartbeat #1'] };
    },
    view: (s, ctx) => {
      const b = boardHeadline(s.board, s.now);
      const board = b ? section('The board', `<p>${esc(b.head)}</p>${b.lines.length ? `<ul>${b.lines.map((l) => `<li>${esc(l.replace(/^• /, ''))}</li>`).join('')}</ul>` : ''}`) : '';
      return { mode: 'doc', title: 'Plan', sub: 'Plans/plan.md', html: board + (s.plan ? md(s.plan) : `<p class="muted">No plan yet. The CEO writes the first one during heartbeat #1.</p>`), copy: s.plan, link: obsidianUrl(ctx.vaultName, 'Plans/plan.md') };
    },
  },
  {
    kind: 'newsstand', streamKind: 'markdown', streamId: (s) => s.latestRun?.path ?? 'Runs/',
    headline: (s) => {
      // The newsstand's own words, always. It used to show the last two feed lines cut to 40 characters, which on
      // a six-tile screen became "· proposal:…" / "· CEO · yo u: ].." — a log fragment with a bracket left
      // hanging, on the wall of a public floor in two delivered scenes (visual QA R2-I1). The designed line was
      // already here but only reachable when the feed was *also* empty, which it never is by the time anyone
      // looks. Written well inside the screen's own line width, like `noticeboard` and `postoffice`: the budget
      // is 17 columns but it is a character *estimate*, and a 17-column line of wide glyphs is cropped by the glass.
      if (!s.latestRun) return { head: 'No brief yet', short: 'No brief', lines: ['Written after', 'each heartbeat', 'kept in Runs/'] };
      const b = briefBits(s.latestRun.body);
      const needs = b.needs.filter((n) => !/^none\b/i.test(n));
      return { head: briefTitle(s.latestRun.path).replace('Brief · ', 'Brief '), short: 'Brief', lines: [...b.happened.slice(0, 2).map((h) => '• ' + cut(h, 40)), ...(needs.length ? ['Needs you: ' + cut(needs[0], 30)] : [])], badge: needs.length ? String(needs.length) : undefined };
    },
    view: (s, ctx) => s.latestRun
      ? { mode: 'doc', title: briefTitle(s.latestRun.path), sub: s.latestRun.path, html: md(s.latestRun.body) + feedHtml(s), copy: s.latestRun.body, link: obsidianUrl(ctx.vaultName, s.latestRun.path) }
      : { mode: 'doc', title: 'Latest brief', html: `<p class="muted">No brief yet. One is written after every heartbeat.</p>` + feedHtml(s) },
  },
  {
    kind: 'noticeboard', streamKind: 'list', streamId: () => 'jobs:open',
    // Written to the width the wall actually has (visual QA I3): "Queue empty" used to be cut to "Queue…" on a
    // four-tile screen. The screen is seven tiles now and the empty state fits whole. A line is the job's title
    // and nothing else — the tower's display names are long enough that a name and a title on one line left two
    // ellipses on every row, and who has it is a click away in the queue itself.
    headline: (s) => { const open = Object.values(s.jobs).filter((j) => isOpen(j.status)).sort((a, b) => a.priority - b.priority); return { head: open.length ? `${open.length} open` : 'Queue empty', short: open.length ? String(open.length) : 'Queue', lines: open.slice(0, 3).map((j) => cut(j.title, 20)) }; },
    view: (s) => queueView(s),
  },
  {
    kind: 'postoffice', streamKind: 'list', streamId: () => 'inbox',
    headline: (s) => { const n = s.inbox.length || s.pendingProposals; return { head: n ? `${n} to approve` : 'Nothing to approve', short: n ? String(n) : 'Clear', lines: n ? s.inbox.slice(0, 3).map((p) => cut(`${kindLabel(p.kind)}: ${p.title}`, 28)) : ['Proposals land here', 'for your yes or no'], badge: n ? String(n) : undefined }; },
    view: (s, ctx) => postOfficeView(s, ctx),
  },
  {
    kind: 'bank', streamKind: 'chart', streamId: () => 'money',
    // What the free tier actually rations is a division's calls, so that is what the wall draws. Before the
    // daemon has sent any money — an old daemon, a book it could not read — it falls back to the per-model day
    // limits, which is what this chart always used to be.
    bars: (s) => (s.money?.budgets.length
      ? s.money.budgets.map((b) => ({ label: b.division, used: b.used, limit: b.quota }))
      : s.quota.map((q) => ({ label: q.model, used: q.rpd_used, limit: q.limits.rpd }))),
    headline: (s) => {
      const m = s.money;
      if (!m) { const list = s.quota.filter((q) => q.limits.rpd > 0).slice(0, 7); const total = callsToday(s); return { head: `${total} calls today`, short: String(total), lines: list.length ? list.map((q) => cut(q.model, 16)) : ['Set rpm and rpd in', 'providers.yaml'] }; }
      // Clipped like every other surface's: the wall is an in-world chart, not a text field. `USD 1234567.89` is
      // 14 characters before a long currency code, and the fallback branch above has always truncated.
      return {
        head: cut(m.cash, 16),
        short: cut(m.cash, 16),
        lines: [`Burn ${m.burn} a day`, `Runway ${m.runway}`, ...(m.dormant ? ['Dormant: add capital'] : [])].slice(0, 3).map((l) => cut(l, 24)),
        badge: m.dormant ? 'STOPPED' : undefined,
      };
    },
    view: (s) => bankView(s),
  },
  {
    kind: 'vault', streamKind: 'list', streamId: () => 'jobs',
    // "1 jobs" was a plural bug, and a bare count on a vault reads as money: the head says what is being counted.
    headline: (s) => { const all = Object.values(s.jobs); const c = (st: string): number => all.filter((j) => j.status === st).length; return { head: `${all.length} job ${all.length === 1 ? 'note' : 'notes'}`, short: String(all.length), lines: [`${c('done')} done · ${c('running')} running`, `${c('blocked')} blocked`, 'Open in Obsidian'] }; },
    view: (s, ctx) => {
      const all = Object.values(s.jobs).sort(byUpdated);
      const active = all.filter((j) => isOpen(j.status));
      const done = all.filter((j) => !isOpen(j.status)).slice(0, 30);
      const link = ctx.vaultName ? `<p class="hintline"><a href="obsidian://open?vault=${encodeURIComponent(ctx.vaultName)}">Open the vault in Obsidian</a></p>` : `<p class="hintline">Add <code>?vault=&lt;name&gt;</code> to this URL to enable Obsidian links.</p>`;
      return { mode: 'drawer', title: 'Vault', sub: `${all.length} jobs`, html: section('In progress', active.length ? teamJobs(active, s) : emptyHtml('clipboard', 'Nothing running right now'), active.length) + section('Finished', done.length ? teamJobs(done, s) : emptyHtml('clipboard', 'No finished jobs yet'), done.length) + link };
    },
  },
  {
    kind: 'terminal', streamKind: 'terminal', streamId: () => 'shell',
    headline: (s) => { const last = s.terminal.slice(-3); return { head: last.length ? 'Shell' : 'Shell idle', short: 'Shell', lines: last.length ? last.map((l) => cut(l, 28)) : ['Nobody is running', 'a command'] }; },
    view: (s) => terminalViewerView(s),
  },
  {
    kind: 'billboard', streamKind: 'browser', streamId: browserStream,
    headline: (s) => { const cur = s.surfaces[browserStream(s)]; return { head: cur ? (cur.active ? 'Browser live' : 'Last shot') : 'No session', short: cur ? 'Live' : 'Idle', lines: cur ? [] : ['Growth and the', 'Engineer browse here'], badge: cur?.active ? 'LIVE' : undefined }; },
    view: (s, ctx) => browserViewerView(s, ctx),
  },
  {
    kind: 'workshop', streamKind: 'iframe', streamId: () => '/site/',
    headline: (s) => { const url = s.deploys.at(-1)?.url; return url ? { head: 'Deployed', short: 'Live', lines: [cut(url.replace(/^https?:\/\//, ''), 30)] } : { head: 'Not deployed yet', short: 'Draft', lines: ['A preview of Site/dist', 'until you approve it'] }; },
    view: (s, ctx) => {
      const url = s.deploys.at(-1)?.url ?? '';
      return { mode: 'drawer', title: 'Workshop', sub: url ? `deployed at ${url}` : 'site preview', html: `${url ? `<p class="hintline">Last deploy: <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></p>` : ''}<iframe class="site" src="/site/${ctx.tokenQuery}" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" title="site preview"></iframe><p class="hintline">Site/dist, isolated from the office. Not deployed until you approve it.</p>` };
    },
  },
  {
    kind: 'cabin', streamKind: 'markdown', streamId: () => 'chat:ceo',
    // The brief is pinned on the cabin wall (spec §10); before there is one, the wall asks the first-run question (§12 e).
    headline: (s) => (s.latestRun ? SURFACES.newsstand.headline(s) : { head: 'Your idea?', short: 'Idea?', lines: ['Click to tell the CEO', 'what to build — or say', '“surprise me”'] }),
    view: (s) => ({ mode: 'chat', title: s.agents.ceo?.display ?? 'CEO', sub: s.brand.name ? `${s.brand.name}${s.brand.tagline ? ` · ${s.brand.tagline}` : ''}` : 'Tell the CEO what to build, or say "surprise me"', html: chatHtml(s) }),
  },
] satisfies SurfaceDef[]) registerSurface(def);
