/** Viewer state: a pure reducer over daemon events + snapshots. No persistence — the viewer is disposable (spec §10). */
export type AgentState = 'idle_at_desk' | 'working' | 'walking' | 'talking' | 'error' | 'blocked' | 'entering' | 'leaving' | 'offline';
export type ToolIcon = 'browser' | 'terminal' | 'envelope' | 'doc' | 'chart' | 'chat' | null;
export interface AgentView { role: string; display: string; sprite: string; desk: string; active: boolean; state: AgentState; tool: ToolIcon; job: string | null; bubble: { text: string; until: number } | null; target: string | null; badge: 'error' | 'blocked' | null }
export interface JobView { id: string; type: string; title: string; assigned: string; status: string; priority: number; checkpoint_step: number; updated: string }
export interface SurfaceView { streamKind: 'browser' | 'terminal' | 'markdown' | 'chart' | 'iframe'; streamId: string; lastFrame?: string; active: boolean; text?: string }
export interface QuotaView { provider: string; model: string; rpm_used: number; rpd_used: number; tpm_used: number; cooling_until: string | null; limits: { rpm: number; rpd: number; tpm: number } }
export interface CubicleEvent { id?: number; ts: string; type: string; agent: string | null; job: string | null; payload: Record<string, unknown> }
export interface Snapshot { op: 'snapshot'; at: string; roles: { role: string; display: string; sprite: string; desk: string; active: boolean }[]; jobs: JobView[]; surfaces: { streamKind: string; streamId: string; lastFrame?: string; active: boolean }[]; quota: QuotaView[]; latestRun: { path: string; body: string } | null; plan: string; pendingProposals: number }

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
  terminal: string[];              // last shell output lines
  mail: { ts: string; text: string }[];
  feed: { ts: string; text: string }[];   // decisions / proposals / briefs for the newsstand
  meetings: Record<string, { room: string; participants: string[]; open: boolean }>;
  frames: Record<string, { seq: number; jpegBase64?: string; path?: string }>;
  lastEventTs: string | null;
  deploys: { ts: string; url: string }[];
  /** Set when plan/brief text changed on disk; the client re-requests the snapshot. */
  staleSnapshot?: boolean;
}

export const emptyState = (): State => ({ connected: false, mode: 'live', now: Date.now(), agents: {}, jobs: {}, surfaces: {}, quota: [], latestRun: null, plan: '', pendingProposals: 0, terminal: [], mail: [], feed: [], meetings: {}, frames: {}, lastEventTs: null, deploys: [] });

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

export function applySnapshot(s: State, snap: Snapshot): State {
  const agents: Record<string, AgentView> = {};
  const runningBy = new Map(snap.jobs.filter((j) => j.status === 'running').map((j) => [j.assigned, j.id]));
  for (const r of snap.roles) {
    const prev = s.agents[r.role];
    const stillRunning = prev?.job && runningBy.get(r.role) === prev.job;
    // A snapshot is ground truth: keep in-flight pose only for a job that is still running.
    agents[r.role] = { role: r.role, display: r.display, sprite: r.sprite, desk: r.desk, active: r.active, state: !r.active ? 'offline' : stillRunning ? prev!.state : 'idle_at_desk', tool: stillRunning ? prev!.tool : null, job: stillRunning ? prev!.job : null, bubble: prev?.bubble ?? null, target: stillRunning ? prev!.target : null, badge: prev?.badge ?? null };
  }
  const jobs: Record<string, JobView> = {};
  for (const j of snap.jobs) jobs[j.id] = j;
  // running jobs at snapshot time → their role is working
  for (const j of snap.jobs) if (j.status === 'running' && agents[j.assigned]) { agents[j.assigned].state = 'working'; agents[j.assigned].job = j.id; }
  for (const j of snap.jobs) if (j.status === 'blocked' && agents[j.assigned] && agents[j.assigned].state !== 'working') agents[j.assigned].badge = 'blocked';
  // Surfaces: only the sessions the daemon still knows about (bounded), newest first.
  const surfaces: Record<string, SurfaceView> = {};
  for (const su of snap.surfaces) surfaces[su.streamId] = { streamKind: su.streamKind as SurfaceView['streamKind'], streamId: su.streamId, lastFrame: su.lastFrame, active: su.active };
  const frames: State['frames'] = {};
  for (const id of Object.keys(surfaces)) if (s.frames[id]) frames[id] = s.frames[id];
  return { ...s, agents, jobs, surfaces, frames, quota: snap.quota, latestRun: snap.latestRun, plan: snap.plan, pendingProposals: snap.pendingProposals, connected: true, staleSnapshot: false };
}

const BUBBLE_MS = 6000;

/** Event → state. Pure: the office is a renderer/replayer of the log (spec §1.6). */
export function applyEvent(s: State, e: CubicleEvent, nowMs = Date.now()): State {
  const st: State = { ...s, agents: { ...s.agents }, jobs: { ...s.jobs }, surfaces: { ...s.surfaces }, meetings: { ...s.meetings }, frames: { ...s.frames }, lastEventTs: e.ts };
  // Inactive (fired) agents no longer react to events; they only leave.
  const a = (role: string | null | undefined): AgentView | null => (role && st.agents[role] && st.agents[role].active ? (st.agents[role] = { ...st.agents[role] }) : null);
  const p = e.payload;
  switch (e.type) {
    case 'job.queued': st.jobs[String(e.job)] = { id: String(e.job), type: String(p.type ?? '?'), title: String(p.title ?? ''), assigned: String(p.assigned ?? e.agent ?? ''), status: 'queued', priority: Number(p.priority ?? 3), checkpoint_step: 0, updated: e.ts }; break;
    case 'job.started': { const j = st.jobs[String(e.job)]; if (j) st.jobs[j.id] = { ...j, status: 'running', updated: e.ts }; const ag = a(e.agent); if (ag) { ag.state = ag.target ? 'walking' : 'working'; ag.job = String(e.job); ag.badge = null; } break; }
    case 'agent.thinking': { const ag = a(e.agent); if (ag && (ag.state !== 'walking' || !ag.target)) ag.state = 'working'; break; }
    case 'agent.tool_call': { const ag = a(e.agent); if (ag) { const tool = String(p.tool ?? ''); ag.tool = toolIcon(tool); const t = targetFor(tool); if (t && ag.target !== t) { ag.target = t; ag.state = 'walking'; } else if (!t && ag.target && !ag.target.endsWith('room')) { ag.target = null; ag.state = 'walking'; } } if (String(p.tool) === 'shell.run') st.terminal = [...st.terminal.slice(-200), `$ ${String(p.summary ?? '')}`]; break; }
    case 'agent.tool_result': { const ag = a(e.agent); if (ag && (ag.state !== 'walking' || !ag.target)) ag.state = 'working'; break; }
    case 'shell.output': st.terminal = [...st.terminal.slice(-300), String(p.text ?? '')]; break;
    case 'agent.spoke': { const ag = a(e.agent); if (ag) { ag.bubble = { text: `→ ${String(p.to)}: ${String(p.text ?? '').slice(0, 120)}`, until: nowMs + BUBBLE_MS }; if (ag.state !== 'walking') ag.state = 'talking'; } if (p.to === 'owner') st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `CEO → you: ${String(p.text ?? '')}` }]; break; }
    case 'job.checkpoint': break;
    case 'job.blocked': { const j = st.jobs[String(e.job)]; if (j) st.jobs[j.id] = { ...j, status: 'blocked', updated: e.ts }; const ag = a(e.agent); if (ag) { ag.state = 'idle_at_desk'; ag.badge = 'blocked'; ag.bubble = { text: `? ${String(p.reason ?? 'blocked')}`, until: nowMs + BUBBLE_MS * 2 }; ag.target = null; ag.tool = null; } break; }
    case 'job.done': { const j = st.jobs[String(e.job)]; if (j) st.jobs[j.id] = { ...j, status: 'done', updated: e.ts }; const ag = a(e.agent); if (ag) { ag.state = 'walking'; ag.target = null; ag.tool = null; ag.job = null; ag.badge = null; } break; }
    case 'job.failed': { const j = st.jobs[String(e.job)]; if (j) st.jobs[j.id] = { ...j, status: p.requeued ? 'queued' : 'failed', updated: e.ts }; const ag = a(e.agent); if (ag) { ag.state = 'idle_at_desk'; ag.badge = 'error'; ag.target = null; ag.tool = null; ag.job = null; } const coo = a('coo'); if (coo && e.agent !== 'coo') { coo.target = `desk:${e.agent}`; coo.state = 'walking'; } break; }
    case 'job.cancelled': { const j = st.jobs[String(e.job)]; if (j) st.jobs[j.id] = { ...j, status: 'cancelled', updated: e.ts }; const ag = a(e.agent); if (ag) { ag.state = 'idle_at_desk'; ag.job = null; ag.tool = null; ag.target = null; } break; }
    case 'job.interrupted': { const ag = a(e.agent); if (ag) ag.badge = 'blocked'; break; }
    case 'meeting.opened': { const id = String(p.id); const parts = (p.participants as string[]) ?? []; const room = String(p.room ?? 'meeting'); st.meetings[id] = { room, participants: parts, open: true }; for (const r of parts) { const ag = a(r); if (ag) { ag.target = room === 'board' ? 'boardroom' : 'meetingroom'; ag.state = 'walking'; } } st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `${room} meeting opened: ${String(p.agenda ?? '')}` }]; break; }
    case 'meeting.turn': { const ag = a(e.agent); if (ag) { ag.bubble = { text: String(p.text ?? '').slice(0, 140), until: nowMs + BUBBLE_MS }; ag.state = 'talking'; } break; }
    case 'meeting.closed': { const id = String(p.id); if (st.meetings[id]) { st.meetings[id] = { ...st.meetings[id], open: false }; for (const r of st.meetings[id].participants) { const ag = a(r); if (ag) { ag.target = null; ag.state = 'walking'; } } } st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `meeting closed → ${String(p.decision ?? '')}` }]; break; }
    case 'browser.session_started': st.surfaces[String(p.session)] = { streamKind: 'browser', streamId: String(p.session), active: true }; break;
    case 'browser.frame': { const id = String(p.session); const cur = st.surfaces[id] ?? { streamKind: 'browser' as const, streamId: id, active: true }; st.surfaces[id] = { ...cur, lastFrame: String(p.path), active: true }; st.frames[id] = { ...(st.frames[id] ?? { seq: 0 }), seq: Number(p.seq), path: String(p.path) }; break; }
    case 'browser.session_ended': { const id = String(p.session); if (st.surfaces[id]) st.surfaces[id] = { ...st.surfaces[id], active: false }; break; }
    case 'email.sent': st.mail = [...st.mail.slice(-100), { ts: e.ts, text: `→ ${String(p.to)}: ${String(p.subject ?? '')}${p.mock ? ' (mock)' : ''}` }]; break;
    case 'email.received': st.mail = [...st.mail.slice(-100), { ts: e.ts, text: `← ${String(p.from)}: ${String(p.subject ?? '')}` }]; break;
    case 'proposal.created': st.pendingProposals = p.kind === 'message' ? st.pendingProposals : st.pendingProposals + 1; st.mail = [...st.mail.slice(-100), { ts: e.ts, text: `approval needed: ${String(p.title ?? p.kind)}` }]; st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `proposal: ${String(p.title ?? p.kind)}` }]; break;
    case 'proposal.resolved': st.pendingProposals = Math.max(0, st.pendingProposals - (p.kind === 'message' ? 0 : 1)); st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `${String(p.kind)} ${p.approved === false ? 'rejected' : 'approved'}: ${String(p.outcome ?? '')}` }]; break;
    case 'deploy.done': st.deploys = [...st.deploys.slice(-20), { ts: e.ts, url: String(p.url ?? '') }]; st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `deployed ${String(p.url ?? '')}` }]; break;
    case 'heartbeat.started': { const ceo = a('ceo'); if (ceo) { ceo.state = 'working'; ceo.job = String(e.job); } break; }
    case 'heartbeat.completed': st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `brief written: ${String(p.run ?? '')}` }]; st.staleSnapshot = true; break;
    case 'role.hired': { const role = String(p.role); st.agents[role] = { role, display: String(p.display ?? role), sprite: String(p.sprite ?? role), desk: String(p.desk ?? ''), active: true, state: 'entering', tool: null, job: null, bubble: { text: 'Hi, I just joined!', until: nowMs + BUBBLE_MS }, target: null, badge: null }; st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `hired ${role}` }]; break; }
    case 'role.fired': { const role = String(p.role); const prev = st.agents[role]; if (prev) st.agents[role] = { ...prev, state: 'leaving', active: false, tool: null, job: null, target: null, badge: null, bubble: { text: 'Goodbye.', until: nowMs + BUBBLE_MS } }; st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `${role} left the company` }]; break; }
    case 'quota.updated': { if (p.provider && p.model && 'rpm_used' in p) { const q = p as unknown as QuotaView; const i = st.quota.findIndex((x) => x.provider === q.provider && x.model === q.model); st.quota = i >= 0 ? st.quota.map((x, k) => (k === i ? q : x)) : [...st.quota, q]; } break; }
    case 'guardrail.blocked': { const ag = a(e.agent); if (ag) ag.bubble = { text: `⛔ ${String(p.reason ?? 'blocked')}`.slice(0, 120), until: nowMs + BUBBLE_MS }; st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `guardrail: ${String(p.reason ?? '')}` }]; break; }
    case 'owner.edited': st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `you edited ${String(p.path)}` }]; break;
    case 'vault.wrote': { const pth = String(p.path ?? ''); if (pth.startsWith('Decisions/') && !p.deleted) st.feed = [...st.feed.slice(-100), { ts: e.ts, text: `decision recorded: ${pth.replace(/^Decisions\//, '').replace(/\.md$/, '')} (${String(e.agent ?? '')})` }]; if (pth === 'Plans/plan.md' || pth.startsWith('Runs/')) st.staleSnapshot = true; break; }
    default: break;
  }
  return st;
}

/** Expire bubbles and settle transient states; called every frame. */
export function tick(s: State, nowMs: number): State {
  let changed = false;
  const agents = { ...s.agents };
  for (const [k, ag] of Object.entries(agents)) {
    if (ag.bubble && ag.bubble.until < nowMs) { agents[k] = { ...ag, bubble: null, state: ag.state === 'talking' ? (ag.job ? 'working' : 'idle_at_desk') : ag.state }; changed = true; }
  }
  return changed ? { ...s, agents, now: nowMs } : { ...s, now: nowMs };
}
