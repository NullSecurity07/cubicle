/** Viewer state: a pure reducer over daemon events + snapshots. No persistence — the viewer is disposable (spec §10). */
export type AgentState = 'idle_at_desk' | 'working' | 'walking' | 'talking' | 'error' | 'blocked' | 'entering' | 'leaving' | 'offline';
export type ToolIcon = 'browser' | 'terminal' | 'envelope' | 'doc' | 'chart' | 'chat' | null;
export type Mood = 'neutral' | 'happy' | 'worried' | 'puzzled' | 'asleep' | 'thinking';
export type Emote = '!' | '?' | 'idea' | 'zzz' | 'sweat' | 'heart' | 'cheer' | 'clipboard' | 'coffee' | 'wave';
export type BubbleKind = 'speech' | 'thought' | 'action';
export interface Bubble { text: string; until: number; kind: BubbleKind }
export interface AgentView { role: string; display: string; sprite: string; desk: string; active: boolean; state: AgentState; tool: ToolIcon; job: string | null; bubble: Bubble | null; target: string | null; badge: 'error' | 'blocked' | null; /** face drawn on the sprite; `moodUntil` null = until the next change */ mood: Mood; moodUntil: number | null; /** pixel icon above the head */ emote: { kind: Emote; until: number } | null; /** when the agent last did anything (drives the asleep mood) */ idleSince: number | null; /** persona job title from the role charter, e.g. "Chief Technology Officer" */ title?: string }
export interface JobView { id: string; type: string; title: string; assigned: string; status: string; priority: number; checkpoint_step: number; updated: string; team?: string }
export interface TeamView { id: string; name: string; lead: string; members: string[]; mission: string; room?: string; floor?: number; parent?: string }
export interface SurfaceView { streamKind: 'browser' | 'terminal' | 'markdown' | 'chart' | 'iframe'; streamId: string; lastFrame?: string; active: boolean; text?: string }
export interface QuotaView { provider: string; model: string; rpm_used: number; rpd_used: number; tpm_used: number; cooling_until: string | null; limits: { rpm: number; rpd: number; tpm: number } }
export interface CubicleEvent { id?: number; ts: string; type: string; agent: string | null; job: string | null; payload: Record<string, unknown> }
export interface ChatMsg { ts: string; from: 'ceo' | 'you'; text: string }
export interface BrandView { name: string; tagline: string; url: string }
export interface InboxRow { id: string; kind: string; title: string; path: string; created: string }
export interface Snapshot { op: 'snapshot'; at: string; roles: { role: string; display: string; sprite: string; desk: string; active: boolean; title?: string }[]; jobs: JobView[]; surfaces: { streamKind: string; streamId: string; lastFrame?: string; active: boolean }[]; quota: QuotaView[]; latestRun: { path: string; body: string } | null; plan: string; pendingProposals: number; brand?: BrandView; inbox?: InboxRow[]; chat?: ChatMsg[]; teams?: TeamView[] }

export interface State {
  connected: boolean;
  mode: 'live' | 'replay';
  now: number;
  agents: Record<string, AgentView>;
  jobs: Record<string, JobView>;
  surfaces: Record<string, SurfaceView>;
  quota: QuotaView[];
  latestRun: { path: string; body: string } | null;
  plan: string;
  pendingProposals: number;
  brand: BrandView;
  teams: TeamView[];               // Teams/*.md — the org chart
  inbox: InboxRow[];              // proposals awaiting the owner (from the snapshot)
  chat: ChatMsg[];                // the CEO cabin thread (snapshot history + live events)
  terminal: string[];              // last shell output lines
  mail: { ts: string; text: string }[];
  feed: { ts: string; text: string }[];   // decisions / proposals / briefs for the newsstand
  meetings: Record<string, { room: string; participants: string[]; open: boolean }>;
  frames: Record<string, { seq: number; jpegBase64?: string; path?: string }>;
  lastEventTs: string | null;
  deploys: { ts: string; url: string }[];
  /** No company name, no jobs and nothing said yet: the office is empty and the owner has not started (spec §12). */
  firstRun: boolean;
  /** Set when plan/brief text changed on disk; the client re-requests the snapshot. */
  staleSnapshot?: boolean;
}

export const emptyState = (): State => ({ connected: false, mode: 'live', now: Date.now(), agents: {}, jobs: {}, surfaces: {}, quota: [], latestRun: null, plan: '', pendingProposals: 0, brand: { name: '', tagline: '', url: '' }, teams: [], inbox: [], chat: [], terminal: [], mail: [], feed: [], meetings: {}, frames: {}, lastEventTs: null, deploys: [], firstRun: false });

export function toolIcon(tool: string): ToolIcon {
  if (tool.startsWith('browser.') || tool === 'social.post' || tool === 'http.fetch') return 'browser';
  if (tool === 'shell.run' || tool.startsWith('git.') || tool === 'deploy.site') return 'terminal';
  if (tool.startsWith('email.')) return 'envelope';
  if (tool === 'analytics.pull' || tool === 'stripe.payment_link') return 'chart';
  if (tool === 'colleague.message' || tool === 'meeting.open' || tool === 'proposal.create') return 'chat';
  if (tool.startsWith('vault.') || tool.startsWith('skills.')) return 'doc';
  return null;
}

/** Where a sprite should walk for a tool (spec §10): browser → billboard, shell → terminal shed, mail → post office. */
export function targetFor(tool: string): string | null {
  if (tool.startsWith('browser.') || tool === 'social.post') return 'billboard';
  if (tool === 'shell.run') return 'terminal';
  if (tool === 'email.send' || tool === 'email.inbox') return 'postoffice';
  if (tool === 'deploy.site') return 'workshop';
  if (tool === 'analytics.pull') return 'bank';
  return null;
}

/** The snapshot's conversation is the truth; keep only local lines it does not have yet (a message just sent, a reply that arrived before the note was rewritten). */
function mergeChat(fromSnapshot: ChatMsg[], local: ChatMsg[]): ChatMsg[] {
  const seen = new Set(fromSnapshot.map((m) => `${m.from}:${m.text}`));
  const extra = local.filter((m) => !seen.has(`${m.from}:${m.text}`) && !fromSnapshot.some((x) => x.from === m.from && (x.text.startsWith(m.text) || m.text.startsWith(x.text))));
  return [...fromSnapshot, ...extra].sort((a, b) => a.ts.localeCompare(b.ts));
}

export function applySnapshot(s: State, snap: Snapshot): State {
  const agents: Record<string, AgentView> = {};
  const roles = Array.isArray(snap.roles) ? snap.roles : [];
  const jobList = Array.isArray(snap.jobs) ? snap.jobs : [];
  const runningBy = new Map(jobList.filter((j) => j.status === 'running').map((j) => [j.assigned, j.id]));
  // Spec §12 d): on an empty company the office is empty and the CEO walks in through the door to the cabin.
  // The CEO's own heartbeat does not count as work the company is doing — a heartbeat job note can be in the
  // vault before the owner has said anything, and counting it hid the entrance entirely (C1).
  const firstRun = !(snap.brand?.name ?? '').trim() && jobList.every((j) => j.type === 'ceo.heartbeat') && (snap.chat ?? []).length === 0;
  // The entrance is a one-shot: it starts on the first snapshot of a viewer session and lasts until the CEO is
  // doing something else. Setting it on every snapshot sent the CEO back through the door for as long as the
  // vault stayed empty, overriding wherever an event had asked it to walk.
  const entering = firstRun && (Object.keys(s.agents).length === 0 || s.agents.ceo?.state === 'entering');
  for (const r of roles) {
    const prev = s.agents[r.role];
    const stillRunning = prev?.job && runningBy.get(r.role) === prev.job;
    // A snapshot is ground truth: keep in-flight pose only for a job that is still running.
    agents[r.role] = { role: r.role, display: r.display, sprite: r.sprite, desk: r.desk, active: r.active, title: r.title, state: !r.active ? 'offline' : stillRunning ? prev!.state : entering && r.role === 'ceo' ? 'entering' : 'idle_at_desk', tool: stillRunning ? prev!.tool : null, job: stillRunning ? prev!.job : null, bubble: prev?.bubble ?? null, target: stillRunning ? prev!.target : null, badge: prev?.badge ?? null, mood: !r.active ? 'asleep' : stillRunning ? prev!.mood : prev?.mood ?? 'neutral', moodUntil: prev?.moodUntil ?? null, emote: prev?.emote ?? null, idleSince: prev?.idleSince ?? Date.now() };
  }
  const jobs: Record<string, JobView> = {};
  for (const j of jobList) jobs[j.id] = j;
  // running jobs at snapshot time → their role is working
  for (const j of jobList) if (j.status === 'running' && agents[j.assigned]) { agents[j.assigned].state = 'working'; agents[j.assigned].job = j.id; }
  for (const j of jobList) if (j.status === 'blocked' && agents[j.assigned] && agents[j.assigned].state !== 'working') agents[j.assigned].badge = 'blocked';
  // Surfaces: only the sessions the daemon still knows about (bounded), newest first.
  const surfaces: Record<string, SurfaceView> = {};
  for (const su of Array.isArray(snap.surfaces) ? snap.surfaces : []) surfaces[su.streamId] = { streamKind: su.streamKind as SurfaceView['streamKind'], streamId: su.streamId, lastFrame: su.lastFrame, active: su.active };
  const frames: State['frames'] = {};
  for (const id of Object.keys(surfaces)) if (s.frames[id]) frames[id] = s.frames[id];
  return { ...s, agents, jobs, surfaces, frames, quota: snap.quota, latestRun: snap.latestRun, plan: snap.plan, pendingProposals: snap.pendingProposals, brand: snap.brand ?? { name: '', tagline: '', url: '' }, teams: snap.teams ?? [], inbox: snap.inbox ?? [], chat: snap.chat ? mergeChat(snap.chat, s.chat) : s.chat, connected: true, firstRun, staleSnapshot: false };
}

const BUBBLE_MS = 6000;
const THOUGHT_MS = 4000;
const MOOD_MS = 5000;
export const SLEEP_AFTER_MS = 3 * 60_000;

/** Short present-tense line for an action bubble, from the tool name and its summary (often JSON). */
export function actionVerb(tool: string, summary: unknown): string {
  let args: Record<string, unknown> = {};
  if (typeof summary === 'string') { try { const j = JSON.parse(summary); if (j && typeof j === 'object') args = j as Record<string, unknown>; } catch { args = { raw: summary }; } }
  else if (summary && typeof summary === 'object') args = summary as Record<string, unknown>;
  const str = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '');
  const cut = (t: string, n: number): string => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const host = (u: string): string => { try { return new URL(u).host; } catch { return u; } };
  const [fam, op] = tool.split('.');
  switch (fam) {
    case 'browser': return op === 'goto' && str('url') ? `opening ${cut(host(str('url')), 28)}` : op === 'screenshot' ? 'taking a screenshot' : op === 'click' || op === 'type' ? 'using the site' : 'browsing';
    case 'shell': return `running ${cut(str('cmd') || str('command') || str('raw') || 'a command', 26)}`;
    case 'vault': return op === 'read' ? `reading ${cut(str('path') || 'a note', 24)}` : op === 'write' ? `writing ${cut(str('path') || 'a note', 24)}` : op === 'list' ? 'looking through the vault' : 'in the vault';
    case 'email': return op === 'send' ? 'sending an email' : op === 'draft' ? 'drafting an email' : 'checking mail';
    case 'deploy': return 'deploying the site';
    case 'proposal': return 'asking you';
    case 'colleague': return `messaging ${str('to') || 'a colleague'}`;
    case 'scheduler': return 'queuing a job';
    case 'memory': return 'remembering';
    case 'meeting': return 'calling a meeting';
    case 'stripe': return 'creating a payment link';
    case 'analytics': return 'reading the numbers';
    case 'social': return 'drafting a post';
    case 'finish': return 'wrapping up';
    default: return cut(tool.replace(/[._]/g, ' '), 26);
  }
}

/** Event → state. Pure: the office is a renderer/replayer of the log (spec §1.6). */
export function applyEvent(s: State, e: CubicleEvent, nowMs = Date.now()): State {
  const st: State = { ...s, agents: { ...s.agents }, jobs: { ...s.jobs }, surfaces: { ...s.surfaces }, meetings: { ...s.meetings }, frames: { ...s.frames }, lastEventTs: e.ts };
  // Inactive (fired) agents no longer react to events; they only leave.
  const a = (role: string | null | undefined): AgentView | null => {
    if (!role || !st.agents[role] || !st.agents[role].active) return null;
    const ag = (st.agents[role] = { ...st.agents[role], idleSince: nowMs });
    if (ag.mood === 'asleep') { ag.mood = 'neutral'; ag.moodUntil = null; if (ag.emote?.kind === 'zzz') ag.emote = null; } // anything wakes a sleeper
    return ag;
  };
  const feel = (ag: AgentView, mood: Mood, ms: number | null = MOOD_MS): void => { ag.mood = mood; ag.moodUntil = ms === null ? null : nowMs + ms; };
  const emote = (ag: AgentView, kind: Emote, ms: number): void => { ag.emote = { kind, until: nowMs + ms }; };
  const everyone = (): AgentView[] => Object.keys(st.agents).map((r) => a(r)).filter((x): x is AgentView => !!x);
  const p = e.payload;
  switch (e.type) {
    case 'job.queued': st.jobs[String(e.job)] = { id: String(e.job), type: String(p.type ?? '?'), title: String(p.title ?? ''), assigned: String(p.assigned ?? e.agent ?? ''), status: 'queued', priority: Number(p.priority ?? 3), checkpoint_step: 0, updated: e.ts }; break;
    case 'job.started': { const j = st.jobs[String(e.job)]; if (j) st.jobs[j.id] = { ...j, status: 'running', updated: e.ts }; const ag = a(e.agent); if (ag) { ag.state = ag.target ? 'walking' : 'working'; ag.job = String(e.job); ag.badge = null; feel(ag, 'thinking', null); } break; }
    case 'agent.thinking': { const ag = a(e.agent); if (ag) { if (ag.state !== 'walking' || !ag.target) ag.state = 'working'; feel(ag, 'thinking', null); if (!ag.bubble || ag.bubble.kind === 'thought') ag.bubble = { kind: 'thought', text: '', until: nowMs + THOUGHT_MS }; } break; }
    case 'agent.tool_call': { const ag = a(e.agent); if (ag) { const tool = String(p.tool ?? ''); ag.tool = toolIcon(tool); const t = targetFor(tool); if (t && ag.target !== t) { ag.target = t; ag.state = 'walking'; } else if (!t && ag.target && !ag.target.endsWith('room')) { ag.target = null; ag.state = 'walking'; } ag.bubble = { kind: 'action', text: actionVerb(tool, p.summary), until: nowMs + THOUGHT_MS }; if (tool === 'proposal.create' || tool === 'scheduler.request') emote(ag, 'idea', 3000); } if (String(p.tool) === 'shell.run') st.terminal = [...st.terminal.slice(-200), `$ ${String(p.summary ?? '')}`]; break; }
    case 'agent.tool_result': { const ag = a(e.agent); if (ag) { if (ag.state !== 'walking' || !ag.target) ag.state = 'working'; if (p.ok === false) { feel(ag, 'worried', 3000); emote(ag, 'sweat', 3000); } if (ag.bubble?.kind === 'action') ag.bubble = null; } break; }
    case 'shell.output': st.terminal = [...st.terminal.slice(-300), String(p.text ?? '')]; break;
    case 'agent.spoke': { const ag = a(e.agent); if (ag) { ag.bubble = { kind: 'speech', text: `→ ${String(p.to)}: ${String(p.text ?? '').slice(0, 120)}`, until: nowMs + BUBBLE_MS }; if (ag.state !== 'walking') ag.state = 'talking'; if (ag.mood === 'thinking') feel(ag, 'neutral', null); } if (p.to === 'owner') { st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `CEO → you: ${String(p.text ?? '')}` }]; if (e.agent === 'ceo') st.chat = [...st.chat.slice(-200), { ts: e.ts, from: 'ceo', text: String(p.text ?? '') }]; } break; }
    case 'job.checkpoint': { if (p.in_review) { const j = st.jobs[String(e.job)]; if (j) st.jobs[j.id] = { ...j, status: 'in_review', updated: e.ts }; const ag = a(e.agent); if (ag) { ag.state = 'idle_at_desk'; ag.job = null; ag.tool = null; ag.target = null; feel(ag, 'neutral', null); } } break; }
    case 'review.returned': { const j = st.jobs[String(e.job)]; if (j) st.jobs[j.id] = { ...j, status: 'queued', updated: e.ts }; const author = a(j?.assigned); if (author) { feel(author, 'worried', 8000); emote(author, 'sweat', 4000); } const rev = a(e.agent); if (rev) { rev.bubble = { kind: 'speech', text: `→ ${j?.assigned ?? 'author'}: ${String((p.findings as string[] | undefined)?.[0] ?? 'please fix')}`.slice(0, 140), until: nowMs + BUBBLE_MS }; if (rev.state !== 'walking') rev.state = 'talking'; } st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `${String(p.gate)} returned ${String(e.job)}` }]; break; }
    case 'review.passed': { const rev = a(e.agent); if (rev) feel(rev, 'happy', 3000); break; }
    case 'plan.vetoed': { const c = a(e.agent); if (c) { emote(c, '!', 6000); feel(c, 'puzzled', 6000); } st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `the board returned the plan: ${String((p.findings as string[] | undefined)?.[0] ?? '')}` }]; break; }
    case 'research.delivered': { const r = a(e.agent); if (r) { emote(r, 'idea', 5000); feel(r, 'happy'); } break; }
    case 'team.planned': { const l = a(e.agent); if (l) feel(l, 'happy', 3000); st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `${String(p.team)} planned ${(p.jobs as string[] | undefined)?.length ?? 0} job(s)` }]; break; }
    case 'org.changed': st.staleSnapshot = true; st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `org changed (${String(p.reason)})` }]; break;
    case 'job.blocked': { const j = st.jobs[String(e.job)]; if (j) st.jobs[j.id] = { ...j, status: 'blocked', updated: e.ts }; const ag = a(e.agent); if (ag) { ag.state = 'idle_at_desk'; ag.badge = 'blocked'; ag.bubble = { kind: 'thought', text: String(p.reason ?? 'blocked'), until: nowMs + BUBBLE_MS * 2 }; ag.target = null; ag.tool = null; feel(ag, 'puzzled', null); emote(ag, '?', BUBBLE_MS * 2); } break; }
    case 'job.done': { const j = st.jobs[String(e.job)]; if (j) st.jobs[j.id] = { ...j, status: 'done', updated: e.ts }; const ag = a(e.agent); if (ag) { ag.state = 'walking'; ag.target = null; ag.tool = null; ag.job = null; ag.badge = null; ag.bubble = null; feel(ag, 'happy'); emote(ag, 'cheer', 3000); } break; }
    case 'job.failed': { const j = st.jobs[String(e.job)]; if (j) st.jobs[j.id] = { ...j, status: p.requeued ? 'queued' : 'failed', updated: e.ts }; const ag = a(e.agent); if (ag) { ag.state = 'idle_at_desk'; ag.badge = 'error'; ag.target = null; ag.tool = null; ag.job = null; ag.bubble = null; feel(ag, 'worried', 10000); emote(ag, 'sweat', 6000); } const coo = a('coo'); if (coo && e.agent !== 'coo') { coo.target = `desk:${e.agent}`; coo.state = 'walking'; emote(coo, 'clipboard', 20000); } break; }
    case 'job.cancelled': { const j = st.jobs[String(e.job)]; if (j) st.jobs[j.id] = { ...j, status: 'cancelled', updated: e.ts }; const ag = a(e.agent); if (ag) { ag.state = 'idle_at_desk'; ag.job = null; ag.tool = null; ag.target = null; ag.bubble = null; feel(ag, 'neutral', null); } break; }
    case 'job.interrupted': { const ag = a(e.agent); if (ag) ag.badge = 'blocked'; break; }
    case 'meeting.opened': { const id = String(p.id); const parts = (p.participants as string[]) ?? []; const room = String(p.room ?? 'meeting'); st.meetings[id] = { room, participants: parts, open: true }; for (const r of parts) { const ag = a(r); if (ag) { ag.target = room === 'board' ? 'boardroom' : 'meetingroom'; ag.state = 'walking'; } } st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `${room} meeting opened: ${String(p.agenda ?? '')}` }]; break; }
    case 'meeting.turn': { const ag = a(e.agent); if (ag) { ag.bubble = { kind: 'speech', text: String(p.text ?? '').slice(0, 140), until: nowMs + BUBBLE_MS }; ag.state = 'talking'; } break; }
    case 'meeting.closed': { const id = String(p.id); if (st.meetings[id]) { st.meetings[id] = { ...st.meetings[id], open: false }; for (const r of st.meetings[id].participants) { const ag = a(r); if (ag) { ag.target = null; ag.state = 'walking'; } } } st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `meeting closed → ${String(p.decision ?? '')}` }]; break; }
    case 'browser.session_started': st.surfaces[String(p.session)] = { streamKind: 'browser', streamId: String(p.session), active: true }; break;
    case 'browser.frame': { const id = String(p.session); const cur = st.surfaces[id] ?? { streamKind: 'browser' as const, streamId: id, active: true }; st.surfaces[id] = { ...cur, lastFrame: String(p.path), active: true }; st.frames[id] = { ...(st.frames[id] ?? { seq: 0 }), seq: Number(p.seq), path: String(p.path) }; break; }
    case 'browser.session_ended': { const id = String(p.session); if (st.surfaces[id]) st.surfaces[id] = { ...st.surfaces[id], active: false }; break; }
    case 'email.sent': st.mail = [...st.mail.slice(-100), { ts: e.ts, text: `→ ${String(p.to)}: ${String(p.subject ?? '')}${p.mock ? ' (mock)' : ''}` }]; break;
    case 'email.received': st.mail = [...st.mail.slice(-100), { ts: e.ts, text: `← ${String(p.from)}: ${String(p.subject ?? '')}` }]; break;
    case 'proposal.created': st.staleSnapshot = true; if (p.kind === 'message' && p.to === 'ceo') { const t = String(p.title ?? ''); if (!st.chat.some((c) => c.from === 'you' && c.text.startsWith(t))) st.chat = [...st.chat.slice(-200), { ts: e.ts, from: 'you', text: t }]; const ceo = a('ceo'); if (ceo) { emote(ceo, 'wave', 3000); feel(ceo, 'happy', 3000); } break; } st.pendingProposals = p.kind === 'message' ? st.pendingProposals : st.pendingProposals + 1; st.mail = [...st.mail.slice(-100), { ts: e.ts, text: `approval needed: ${String(p.title ?? p.kind)}` }]; st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `proposal: ${String(p.title ?? p.kind)}` }]; break;
    case 'proposal.resolved': st.staleSnapshot = true; st.pendingProposals = Math.max(0, st.pendingProposals - (p.kind === 'message' ? 0 : 1)); st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `${String(p.kind)} ${p.approved === false ? 'rejected' : 'approved'}: ${String(p.outcome ?? '')}` }]; break;
    case 'deploy.done': for (const ag of everyone()) { feel(ag, 'happy'); emote(ag, 'cheer', 4000); } st.deploys = [...st.deploys.slice(-20), { ts: e.ts, url: String(p.url ?? '') }]; st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `deployed ${String(p.url ?? '')}` }]; break;
    case 'heartbeat.started': { const ceo = a('ceo'); if (ceo) { ceo.state = 'working'; ceo.job = String(e.job); feel(ceo, 'thinking', null); } break; }
    case 'heartbeat.completed': st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `brief written: ${String(p.run ?? '')}` }]; st.staleSnapshot = true; break;
    case 'role.hired': { const role = String(p.role); st.agents[role] = { role, display: String(p.display ?? role), sprite: String(p.sprite ?? role), desk: String(p.desk ?? ''), active: true, state: 'entering', tool: null, job: null, bubble: { kind: 'speech', text: 'Hi, I just joined!', until: nowMs + BUBBLE_MS }, target: null, badge: null, mood: 'happy', moodUntil: nowMs + BUBBLE_MS, emote: { kind: 'heart', until: nowMs + BUBBLE_MS }, idleSince: nowMs }; st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `hired ${role}` }]; break; }
    case 'role.fired': { const role = String(p.role); const prev = st.agents[role]; if (prev) st.agents[role] = { ...prev, state: 'leaving', active: false, tool: null, job: null, target: null, badge: null, bubble: { kind: 'speech', text: 'Goodbye.', until: nowMs + BUBBLE_MS }, mood: 'worried', moodUntil: null, emote: null }; st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `${role} left the company` }]; break; }
    case 'quota.updated': { if (p.provider && p.model && 'rpm_used' in p) { const q = p as unknown as QuotaView; const i = st.quota.findIndex((x) => x.provider === q.provider && x.model === q.model); st.quota = i >= 0 ? st.quota.map((x, k) => (k === i ? q : x)) : [...st.quota, q]; } break; }
    case 'guardrail.blocked': { const ag = a(e.agent); if (ag) { ag.bubble = { kind: 'thought', text: `not allowed: ${String(p.reason ?? 'blocked')}`.slice(0, 120), until: nowMs + BUBBLE_MS }; feel(ag, 'worried'); emote(ag, '!', 4000); } st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `guardrail: ${String(p.reason ?? '')}` }]; break; }
    case 'owner.edited': st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `you edited ${String(p.path)}` }]; break;
    case 'vault.wrote': { const pth = String(p.path ?? ''); if (pth.startsWith('Decisions/') && !p.deleted) st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `decision recorded: ${pth.replace(/^Decisions\//, '').replace(/\.md$/, '')} (${String(e.agent ?? '')})` }]; if ((pth === 'Plans/plan.md' || pth.startsWith('Runs/')) && p.generated !== true) st.staleSnapshot = true; break; }
    default: break;
  }
  return st;
}

/** Expire bubbles and settle transient states; called every frame. */
export function tick(s: State, nowMs: number): State {
  let changed = false;
  const agents = { ...s.agents };
  for (const [k, ag] of Object.entries(agents)) {
    let next = ag;
    if (ag.bubble && ag.bubble.until < nowMs) next = { ...next, bubble: null, state: ag.state === 'talking' ? (ag.job ? 'working' : 'idle_at_desk') : ag.state };
    if (ag.emote && ag.emote.until < nowMs) next = { ...next, emote: null };
    if (ag.moodUntil !== null && ag.moodUntil < nowMs) next = { ...next, mood: next.job && next.state === 'working' ? 'thinking' : 'neutral', moodUntil: null };
    // A long quiet spell at the desk: doze off (any event on the agent wakes it).
    if (next.state === 'idle_at_desk' && !next.job && next.mood !== 'asleep' && next.idleSince !== null && nowMs - next.idleSince > SLEEP_AFTER_MS) next = { ...next, mood: 'asleep', moodUntil: null, emote: { kind: 'zzz', until: Number.MAX_SAFE_INTEGER } };
    if (next !== ag) { agents[k] = next; changed = true; }
  }
  return changed ? { ...s, agents, now: nowMs } : { ...s, now: nowMs };
}
