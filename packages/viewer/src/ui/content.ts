/**
 * What each office surface shows when opened: pure builders from State → { title, html, mode }.
 * `drawer` = right-side cards and rows; `doc` = the centered document modal; `chat` = the CEO thread;
 * `viewer` = the realtime browser/terminal panel that is morphed in place rather than re-opened.
 * No DOM here, so every builder is unit-testable.
 *
 * The builders live below the registry that calls them (`ui/surfaces.ts` imports this file, never the other
 * way round), so this module has no cycle to be careful about and can be read top to bottom.
 */
import { statusText, type State, type JobView, type TeamView, type AgentView } from '../state.js';
import { md, inline } from './markdown.js';
import { pixelIcon, type GlyphName } from './icons.js';
import { pantryStale, PANTRY_TURN_CHARS, type PantryState } from './pantry.js';

export type ViewMode = 'drawer' | 'doc' | 'chat' | 'viewer';
export interface View {
  title: string; sub?: string; html: string; mode: ViewMode;
  /** raw text for the Copy button (docs) */ copy?: string;
  /** obsidian:// link for the header */ link?: string;
  /** re-rendered on every event and morphed in place; the panel offers "Jump to latest" when scrolled up */ live?: boolean;
  /** pixel icon shown in the trail header */ icon?: GlyphName;
  /** which realtime viewer this is (`mode: 'viewer'` only). The stylesheet sizes the two differently: the browser
   *  box is capped to the frame's own aspect so nothing is dead black beside it, the terminal grows with its output. */
  viewer?: 'browser' | 'terminal';
}
export interface Ctx {
  frames: Record<string, string>; tokenQuery: string; vaultName: string;
  /** measured frame rate per browser stream (main.ts) */ fps?: Record<string, number>;
  /** floor number → division label from `scene.floorSummary()` */ floorLabels?: Record<number, string>;
}

export const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** obsidian://open link for a vault file when the vault name is known (`?vault=`), else ''. */
export function obsidianUrl(vaultName: string, file: string): string {
  return vaultName ? `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file.replace(/\.md$/, ''))}` : '';
}

const KIND_LABEL: Record<string, string> = { spend: 'Spend', outbound_batch: 'Send batch', brand_change: 'Brand', charter_change: 'Charter', file_change: 'File change', hire: 'Hire', fire: 'Fire', message: 'Question' };
export const kindLabel = (k: string): string => KIND_LABEL[k] ?? k.replace(/_/g, ' ');

const DISPLAY: Record<string, string> = { ceo: 'CEO', cto: 'CTO', coo: 'COO', cfo: 'CFO / CRO', cmo: 'CMO', cgo: 'CGO', cso: 'CSO', chro: 'CHRO', clo: 'CLO / CCO', ciso: 'CISO', advisor_skeptic: 'The Skeptic', advisor_investor: 'The Investor', advisor_customer: 'The Customer', dev_manager: 'Dev Manager', qa_lead: 'QA Lead', research_manager: 'Head of Research', engineer: 'Engineer', growth: 'Growth', head_of_growth: 'Head of Growth', tech_lead: 'Tech Lead', qa: 'QA', critic: 'Critic', research_analyst: 'Research Analyst' };
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
export const rows = (items: string[]): string => `<div class="rows">${items.join('')}</div>`;

/** Empty state with a pixel icon: what is missing and what will fill it. */
export const emptyHtml = (icon: GlyphName, title: string, hint?: string): string => `<div class="empty">${pixelIcon(icon, { size: 16 })}<b>${esc(title)}</b>${hint ? `<span>${esc(hint)}</span>` : ''}</div>`;
export const empty = (text: string): string => emptyHtml('doc', text);

/** A list row: [left chip] [title + small line] [right meta] as one hit target, plus trailing actions outside it. */
export function row(o: { left?: string; title: string; small?: string; right?: string; open?: string; actions?: string }): string {
  const inner = `${o.left ?? '<span></span>'}<span class="t">${esc(o.title)}${o.small ? `<small>${esc(o.small)}</small>` : ''}</span><span class="when">${o.right ?? ''}</span>`;
  const hit = o.open ? `<button class="hit" data-open="${esc(o.open)}">${inner}</button>` : `<div class="hit">${inner}</div>`;
  return `<div class="row">${hit}${o.actions ? `<span class="acts">${o.actions}</span>` : ''}</div>`;
}
export const locate = (role: string): string => `<button class="mini" data-locate="agent:${esc(role)}">Locate</button>`;

/** The ids that tie a segmented control's tabs to its panes; only one such control is ever in the panel body. */
export const segTabId = (id: string): string => `seg-${id}`;
export const segPaneId = (id: string): string => `pane-${id}`;

/**
 * Segmented control: first segment selected; the panel keeps the choice across re-renders.
 *
 * The tabs carry `role="tab"`, so the panes have to carry `role="tabpanel"` and the two have to name each other —
 * without `aria-controls`/`aria-labelledby` the tablist announced itself as controlling nothing at all.
 */
export function segmented(segs: { id: string; label: string; count?: number; html: string }[]): string {
  const tabs = segs.map((g, i) => `<button role="tab" class="seg" id="${esc(segTabId(g.id))}" aria-controls="${esc(segPaneId(g.id))}" data-seg="${esc(g.id)}" aria-selected="${i === 0}">${esc(g.label)}${g.count ? `<span class="n">${g.count}</span>` : ''}</button>`).join('');
  const panes = segs.map((g, i) => `<div class="pane" role="tabpanel" id="${esc(segPaneId(g.id))}" aria-labelledby="${esc(segTabId(g.id))}" tabindex="0" data-key="pane-${esc(g.id)}" data-pane="${esc(g.id)}"${i === 0 ? '' : ' hidden'}>${g.html}</div>`).join('');
  return `<div class="segmented" role="tablist" data-key="segs">${tabs}</div>${panes}`;
}

export const stat = (label: string, value: string, sub?: string): string => `<div class="stat"><span class="v">${esc(value)}</span><span class="l">${esc(label)}</span>${sub ? `<span class="s">${esc(sub)}</span>` : ''}</div>`;
export const stats = (tiles: string[]): string => `<div class="stats">${tiles.join('')}</div>`;
/** Runway meter: `pct` is the share used; hot above 90 %, warm above 60 %. */
export const meterHtml = (pct: number): string => `<div class="meter${pct > 0.9 ? ' hot' : pct > 0.6 ? ' warn' : ''}"><i style="width:${Math.round((1 - Math.min(1, Math.max(0, pct))) * 100)}%"></i></div>`;

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

/** Colour of a feed row's dot from what the reducer wrote. */
export function feedKind(text: string): 'ok' | 'warn' | 'bad' | 'info' {
  if (/^guardrail:|rejected:|failed|left the company/.test(text)) return 'bad';
  if (/^proposal:|^you edited/.test(text)) return 'warn';
  if (/^deployed |^hired |approved:/.test(text)) return 'ok';
  return 'info';
}

/** "Today", "Yesterday", or "3 Sep". */
export function dayLabel(ts: string, now = new Date()): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.toDateString();
  if (day === now.toDateString()) return 'Today';
  if (day === new Date(now.getTime() - 86_400_000).toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Rows grouped by day with a `<div class="day">` heading between groups; items must already be in display order. */
export function byDay<T extends { ts: string }>(items: T[], render: (t: T) => string): string {
  let last = '';
  const out: string[] = [];
  for (const it of items) { const d = dayLabel(it.ts); if (d !== last) { last = d; out.push(`<div class="day">${esc(d)}</div>`); } out.push(render(it)); }
  return out.join('');
}

/** The decision feed: newest first, grouped by day, a coloured dot per kind. */
export function feedHtml(s: State): string {
  const items = s.feed.slice(-30).reverse();
  const body = items.length
    ? byDay(items, (f) => row({ left: `<i class="dot ${feedKind(f.text)}"></i>`, title: f.text, right: esc(fmtTime(f.ts)) }))
    : emptyHtml('doc', 'Nothing decided yet', 'Decisions, proposals and guardrail hits appear here.');
  return section('Decision feed', body, items.length || undefined);
}

/** Title of a Runs/ brief from its path (Runs/2026-09-03-1016.md → "Brief · 3 Sep 10:16"). */
export function briefTitle(path: string): string {
  const m = path.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/);
  return m ? `Brief · ${fmtWhen(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`)}` : 'Latest brief';
}

export const isTeamOpen = (s: State, teamId: string): number => Object.values(s.jobs).filter((j) => j.team === teamId && isOpen(j.status)).length;

/** Org by division (= floor, F4 down to F1), then team (parents before children), a Locate per role. */
export function orgView(s: State, ctx: Ctx): View {
  if (!s.teams.length) return { mode: 'drawer', title: 'Org', html: emptyHtml('chat', 'No teams yet', 'Start the daemon once to create the default org.') };
  const floorOf = (t: TeamView): number => t.floor ?? s.teams.find((p) => p.id === t.parent)?.floor ?? 0;
  const floors = [...new Set(s.teams.map(floorOf))].sort((a, b) => b - a);
  const teamHtml = (t: TeamView): string => {
    const lead = row({ left: chip('kind', 'Lead'), title: who(s, t.lead), small: t.mission, open: `agent:${t.lead}`, actions: locate(t.lead) });
    const members = t.members.map((m) => row({ title: who(s, m), small: roleTitle(s, m), open: `agent:${m}`, actions: locate(m) }));
    return section(t.name, rows([lead, ...members]), `${isTeamOpen(s, t.id)} open`);
  };
  const html = floors.map((f) => {
    const here = s.teams.filter((t) => floorOf(t) === f);
    const ordered = [...here.filter((t) => !t.parent || !here.some((p) => p.id === t.parent)), ...here.filter((t) => t.parent && here.some((p) => p.id === t.parent))];
    const label = f ? ctx.floorLabels?.[f] ?? `Floor ${f}` : 'Elsewhere';
    return `<div class="division" style="--division:var(--floor-${f || 1})"><h2 class="division-title">${esc(label)}</h2>${ordered.map(teamHtml).join('')}</div>`;
  }).join('');
  return { mode: 'drawer', title: 'Org', sub: `${s.teams.length} teams`, html };
}

/** Queue: Open / In review / Done segments, each grouped by team. */
export function queueView(s: State): View {
  const all = Object.values(s.jobs).sort((a, b) => a.priority - b.priority || byUpdated(a, b));
  const open = all.filter((j) => ['queued', 'running', 'blocked'].includes(j.status));
  const review = all.filter((j) => j.status === 'in_review');
  const done = all.filter((j) => !isOpen(j.status)).sort(byUpdated).slice(0, 40);
  const html = segmented([
    { id: 'open', label: 'Open', count: open.length, html: open.length ? teamJobs(open, s) : emptyHtml('clipboard', 'Nothing queued', 'The next heartbeat plans new work.') },
    { id: 'review', label: 'In review', count: review.length, html: review.length ? teamJobs(review, s) : emptyHtml('clipboard', 'Nothing in review') },
    { id: 'done', label: 'Done', count: done.length, html: done.length ? teamJobs(done, s) : emptyHtml('clipboard', 'No finished jobs yet') },
  ]);
  return { mode: 'drawer', title: 'Queue', sub: `${open.length} open · ${review.length} in review`, html, icon: 'clipboard' };
}

/** Post office: what needs the owner, then the mail log. */
export function postOfficeView(s: State, ctx: Ctx): View {
  const needs = s.inbox.length
    ? rows(s.inbox.map((n) => row({ left: chip('kind', kindLabel(n.kind)), title: n.title, small: n.path.replace(/^00 Inbox\//, ''), right: ctx.vaultName ? `<a href="${esc(obsidianUrl(ctx.vaultName, n.path))}">Open</a>` : esc(fmtWhen(n.created)) })))
      + `<p class="hintline">Approve or reject each one in 00 Inbox/ by setting approved: true or false.</p>`
    : emptyHtml('envelope', 'Nothing waiting for you', 'Proposals that need your approval appear here.');
  const mail = s.mail.length ? byDay(s.mail.slice(-40).reverse(), (m) => row({ title: m.text, right: esc(fmtTime(m.ts)) })) : emptyHtml('envelope', 'No mail yet');
  return { mode: 'drawer', title: 'Post office', sub: s.inbox.length ? `${s.inbox.length} to approve` : 'nothing to approve', html: segmented([{ id: 'needs', label: 'Needs you', count: s.inbox.length, html: needs }, { id: 'mail', label: 'Mail', html: mail }]), icon: 'envelope' };
}

/**
 * The bank: the company's money first, the free tier underneath.
 *
 * Before SP4 this screen showed free-tier call counts and called them runway, which was the only "money" the
 * company had. Now cash, burn and runway are real figures out of `Ledger/ledger.md`, the per-division model
 * quota is the thing the free tier actually rations, and the last few ledger rows are there so a number on this
 * page can always be traced to a row somebody wrote. Every string here is formatted by the daemon.
 */
export function bankView(s: State): View {
  const m = s.money;
  const cooling = s.quota.filter((q) => q.cooling_until).length;
  const head = m
    ? stats([stat('cash', m.cash), stat('burn a day', m.burn), stat('runway', m.runway)])
    : stats([stat('calls today', `${callsToday(s)}`), stat('providers', `${new Set(s.quota.map((q) => q.provider)).size}`), stat('cooling', `${cooling}`)]);
  const notes = [
    m?.dormant ? `<p class="hintline">${chip('blocked', 'dormant')} The company has spent the capital it was given. Only the heartbeat is running — add a <code>capital</code> row to <code>Ledger/ledger.md</code> to start it again.</p>` : '',
    m && m.problems > 0 ? `<p class="hintline">${chip('blocked', String(m.problems))} row(s) in <code>Ledger/ledger.md</code> cannot be read. Open the file and fix them; nothing was thrown away.</p>` : '',
    m && m.mock_revenue_cents > 0 ? `<p class="hintline">${esc(m.mock_revenue)} of simulated revenue, which is not cash — nobody paid it, and it is not counted above.</p>` : '',
  ].join('');
  const budgets = m && m.budgets.length
    ? `<div class="tiles">${m.budgets.map((b) => {
        const past = b.quota > 0 && b.used >= b.quota;
        return `<div class="tile" data-key="budget-${esc(b.division)}"><div class="tile-head"><b>${esc(b.division)}</b><span class="muted">model quota</span></div><div class="tile-num">${b.used}${b.quota ? ` / ${b.quota}` : ''}<small>calls today</small></div>${meterHtml(b.quota ? b.used / b.quota : 0)}<div class="tile-foot">${past ? `${chip('blocked', 'cheapest tier')} past its quota, still working` : chip('done', 'ok')}</div></div>`;
      }).join('')}</div>`
    : emptyHtml('chart', 'Nothing allocated yet', 'The CFO splits the day\'s free calls between the divisions each cycle.');
  const models = s.quota.length ? `<div class="tiles">${s.quota.map((q) => {
    const pct = q.limits.rpd ? q.rpd_used / q.limits.rpd : 0;
    return `<div class="tile" data-key="model-${esc(q.provider)}-${esc(q.model)}"><div class="tile-head"><b>${esc(q.model)}</b><span class="muted">${esc(q.provider)}</span></div><div class="tile-num">${q.rpd_used}${q.limits.rpd ? ` / ${q.limits.rpd}` : ''}<small>today</small></div>${meterHtml(pct)}<div class="tile-foot">${q.cooling_until ? `${chip('blocked', 'cooling')} cooling until ${esc(fmtTime(q.cooling_until))}` : chip('done', 'ok')}</div></div>`;
  }).join('')}</div>` : emptyHtml('chart', 'No providers reported yet', 'Limits live in config/providers.yaml.');
  const ledger = m && m.entries.length
    ? rows(m.entries.map((e) => row({ left: chip(e.mode === 'mock' ? 'blocked' : 'done', e.mode), title: `${e.kind} ${e.amount}`, small: `${e.who}: ${e.why}`, right: esc(fmtTime(e.at)) })))
    : emptyHtml('doc', 'Nothing in the ledger yet', 'Add a capital row to Ledger/ledger.md to fund the company.');
  const hint = m
    ? `<p class="hintline">Cash, burn and runway are arithmetic over Ledger/ledger.md. Free-tier limits live in config/providers.yaml.</p>`
    : `<p class="hintline">Money has not been recorded yet. Free-tier limits live in config/providers.yaml.</p>`;
  return {
    mode: 'drawer', title: 'Bank', sub: m ? `${m.cash} cash` : 'free-tier runway per model', icon: 'chart',
    html: head + notes
      + (m ? section('Model quota per division', budgets, m.budgets.length) : '')
      + section(`Free tier — ${callsToday(s)} calls today`, models)
      + (m ? section('Ledger', ledger, m.entries.length) : '')
      + hint,
  };
}

const hostOf = (url?: string): string => { try { return url ? new URL(url).host : ''; } catch { return ''; } };
/** The browser session a billboard-style surface shows: the live one, else the most recent. */
export const browserStream = (s: State): string => Object.values(s.surfaces).filter((x) => x.streamKind === 'browser').sort((a, b) => Number(b.active) - Number(a.active))[0]?.streamId ?? '';

/** Browser realtime viewer: title bar (LIVE/ended, agent, host, seq, fps), the frame updated in place, ended footer. */
export function browserViewerView(s: State, ctx: Ctx): View {
  const cur = s.surfaces[browserStream(s)];
  if (!cur) return { mode: 'viewer', viewer: 'browser', title: 'Billboard', html: emptyHtml('doc', 'No browser session yet', 'Whoever browses the web shows up here, live.'), live: true };
  const src = ctx.frames[cur.streamId] ?? (cur.lastFrame ? `/screens/${cur.lastFrame.replace('.cubicle/screens/', '')}${ctx.tokenQuery}` : '');
  const seq = s.frames[cur.streamId]?.seq ?? 0;
  const fps = ctx.fps?.[cur.streamId];
  const meta = [cur.agent ? who(s, cur.agent) : '', hostOf(cur.url)].filter(Boolean).join(' · ');
  const bar = `<div class="vbar" data-key="vbar">${cur.active ? '<span class="badge live">LIVE</span>' : '<span class="badge ended">Ended</span>'}<span class="vmeta">${esc(meta)}</span><span class="vstats">seq ${seq}${cur.active && fps !== undefined ? ` · ${fps.toFixed(1)} fps` : ''}</span></div>`;
  const frame = src ? `<div class="vframe" data-key="vframe"><img data-key="frame" class="frame" src="${esc(src)}" alt="Browser session" /></div>` : emptyHtml('doc', 'Waiting for the first frame');
  const foot = cur.active ? '' : `<div class="vfoot" data-key="vfoot">Session ended${cur.endedAt ? ` ${esc(fmtTime(cur.endedAt))}` : ''} · showing the last frame</div>`;
  // One metadata row, the spec's wireframe: the .vbar carries LIVE, the agent, the host, the seq and the rate.
  // It used to be handed to the panel header as `sub` as well, so the viewer wore two header bars.
  return { mode: 'viewer', viewer: 'browser', title: 'Billboard', html: bar + frame + foot, live: true };
}

/** A shell job is running when an agent on a job is using the terminal tool (it may still be walking to the Dev room). */
export const shellRunning = (s: State): boolean => Object.values(s.agents).some((a) => a.tool === 'terminal' && !!a.job);

/** Terminal viewer: prompt lines in the accent, a caret while a job runs; the panel offers "Jump to latest". */
export function terminalViewerView(s: State): View {
  const lines = s.terminal.slice(-400).flatMap((l) => l.split('\n'));
  if (!lines.length) return { mode: 'viewer', viewer: 'terminal', title: 'Terminal', html: emptyHtml('chevron', 'No commands run yet', 'Shell output from the Dev room streams here.'), live: true };
  const body = lines.map((l) => `<span class="line${/^[$>#]\s/.test(l) ? ' prompt' : ''}">${esc(l)}</span>`).join('\n');
  return { mode: 'viewer', viewer: 'terminal', title: 'Terminal', sub: `${lines.length} lines`, html: `<pre class="term" data-key="term">${body}${shellRunning(s) ? '<span class="caret" data-key="caret"></span>' : ''}</pre>`, live: true };
}

export const ROOM_LABELS: Record<string, string> = { pantry: 'Pantry', meetingroom: 'Meeting room', boardroom: 'Board room', ceo_office: 'CEO office' };
/** A room id the map knows: a team room, or one of the shared rooms. */
export const isRoom = (kind: string, s: State): boolean => kind in ROOM_LABELS || s.teams.some((t) => t.room === kind);

/** Who is in a room: the team seated there, plus anyone whose current target is the room. */
export function roomView(roomId: string, s: State): View {
  const team = s.teams.find((t) => t.room === roomId);
  const seated = team ? [team.lead, ...team.members] : [];
  const visiting = Object.values(s.agents).filter((a) => a.target === roomId && !seated.includes(a.role)).map((a) => a.role);
  const people = [...seated, ...visiting].filter((r) => s.agents[r]);
  const title = team?.name ?? ROOM_LABELS[roomId] ?? roomId;
  const list = people.length
    ? rows(people.map((r) => row({ left: chip(s.agents[r].state, s.agents[r].state.replace(/_/g, ' ')), title: who(s, r), small: roleTitle(s, r), open: `agent:${r}`, actions: locate(r) })))
    : emptyHtml('chat', 'Nobody here right now');
  return { mode: 'drawer', title, sub: team ? team.mission : undefined, html: section(team ? 'Team' : 'Here now', list, people.length || undefined) + (roomId === 'pantry' ? pantrySection(s.pantry, s.now, (r) => who(s, r)) : '') };
}

/** One line of transcript, cut to the in-world budget with an ellipsis rather than a hard stop. */
const cutTurn = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…');

/**
 * The pantry's own section of the room panel: who is talking, the turns so far, the idea if one came out, and
 * the note's path. Nothing here comes from the snapshot, so a viewer that reconnects after the chat ended is
 * never told a conversation is in progress; the state ages out on its own (`pantryStale`).
 */
export function pantrySection(p: PantryState | null, now: number, nameOf: (role: string) => string): string {
  if (!p || pantryStale(p, now)) return '';
  const who = p.participants.map(nameOf).join(' and ') || 'nobody';
  const head = p.open ? `${who} are having a coffee` : `${who} had a coffee`;
  const body = p.turns.length
    ? rows(p.turns.map((t) => row({ left: esc(nameOf(t.role)), title: cutTurn(t.text, PANTRY_TURN_CHARS), open: `agent:${t.role}` })))
    : emptyHtml('chat', 'Nobody has said anything yet');
  // Three outcomes, and the panel says which: a card was filed, the rule refused the idea and why (ruling Q12),
  // or the chat simply produced nothing — which is the usual answer and must not read as a failure.
  const idea = p.idea
    ? `<div class="card"><b>Idea</b><div class="hintline">${esc(cutTurn(p.idea, 160))}</div></div>`
    : p.notFiled
      ? `<div class="card"><b>Idea</b><div class="hintline">Not filed: ${esc(cutTurn(p.notFiled, 160))}</div></div>`
      : p.open ? '' : '<div class="card"><div class="hintline">Nothing new came of it.</div></div>';
  const note = p.note ? `<div class="hintline">Written up in <code>${esc(p.note)}</code>.</div>` : '';
  return section(head, body + idea + note, p.turns.length || undefined);
}

/** One job note, opened from a queue row. */
export function jobView(id: string, s: State, ctx: Ctx): View {
  const j = s.jobs[id];
  if (!j) return { mode: 'drawer', title: 'Job', html: emptyHtml('clipboard', 'This job is not in the current snapshot.') };
  const body = `<p>${chip(j.status)} &nbsp;<span class="muted">${esc(who(s, j.assigned))} · ${esc(j.type)} · priority ${j.priority} · step ${j.checkpoint_step}</span></p><p class="muted">Updated ${esc(fmtWhen(j.updated))}. The full note, checkpoint log and result live in the vault.</p>`;
  return { mode: 'doc', title: j.title, sub: `Jobs/${j.id}.md`, html: body, link: obsidianUrl(ctx.vaultName, `Jobs/${j.id}.md`) };
}

/** One person: state line, current job, charter link, Locate. Pure, so main.ts has nothing to build. */
export function agentView(role: string, s: State, ctx: Ctx): View {
  const ag: AgentView | undefined = s.agents[role];
  if (!ag) return { mode: 'drawer', title: role, html: emptyHtml('chat', 'Not in the current snapshot') };
  const job = ag.job ? s.jobs[ag.job] : null;
  const team = s.teams.find((t) => t.lead === role || t.members.includes(role)) ?? null;
  const leadRole = ag.reportsTo ?? (team ? (team.lead === role ? (role === 'ceo' ? null : 'ceo') : team.lead) : null);
  // While the constitution's classifier is reading an outbound call, that is what the person is doing — the
  // state line would say "working", which is true and useless. See `statusText`.
  const subParts = [statusText(ag) ?? `${ag.state.replace(/_/g, ' ')}${ag.tool ? ` · using ${ag.tool}` : ''}`, ag.title ?? ag.display];
  if (team) subParts.push(team.name);
  if (leadRole) subParts.push(`reports to ${who(s, leadRole)}`);
  const jobHtml = job ? rows([row({ left: chip(job.status), title: job.title, small: `${job.type} · step ${job.checkpoint_step}`, right: 'open', open: `job:${job.id}` })]) : emptyHtml('clipboard', 'Not on a job right now');
  const charter = obsidianUrl(ctx.vaultName, `Roles/${role}.md`);
  const html = section('Current job', jobHtml)
    + section('Charter', `<div class="card">${charter ? `<a href="${esc(charter)}">Edit Roles/${esc(role)}.md in Obsidian</a>` : `Edit <code>Roles/${esc(role)}.md</code> in Obsidian.`}<div class="hintline">Desk: ${esc(ag.desk || 'none')}. Charters can only tighten what a role may do.</div></div>`)
    + `<div class="actions">${locate(role)}</div>`;
  return { mode: 'drawer', title: ag.display, sub: esc(subParts.join(' · ')), html };
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
