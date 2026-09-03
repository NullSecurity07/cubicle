import Phaser from 'phaser';
import { OfficeScene } from './scenes/OfficeScene.js';
import { Net, resolveWs } from './net.js';
import { emptyState, applyEvent, applySnapshot, tick, type State, type CubicleEvent, type Snapshot } from './state.js';
import { Ui } from './ui/panel.js';
import { viewFor, esc, obsidianUrl, chip, type Ctx } from './ui/content.js';
import { TimeControls } from './ui/time.js';

let state: State = emptyState();
let liveState: State | null = null;   // saved while replaying
const frames: Record<string, string> = {};   // streamId → data URL (live) or /screens/ URL (replay)
const ui = new Ui();
const { url, token } = resolveWs();
const vaultName = new URLSearchParams(location.search).get('vault') ?? '';
const ctx: Ctx = { frames, tokenQuery: token ? `?token=${encodeURIComponent(token)}` : '', vaultName };

const scene = new OfficeScene();
const game = new Phaser.Game({ type: Phaser.AUTO, parent: 'game', backgroundColor: '#0e1014', pixelArt: true, roundPixels: true, scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' }, scene: [scene] });
void game;

const time = new TimeControls({
  onLive() { if (liveState) { state = liveState; liveState = null; } state = { ...state, mode: 'live' }; net.snapshot(); },
  onReplayRequest(date) { replayBuffer = []; const start = new Date(`${date}T00:00:00`); const end = new Date(start.getTime() + 86400_000 - 1); net.replay(start.toISOString(), end.toISOString(), 0); ui.setConn(true, `loading ${date}…`); }, // local day → ISO
  onScrub(index) { rebuildReplayTo(index); },
});
let firstRunOpened = false;
let replayBuffer: CubicleEvent[] = [];
let replayBase: State | null = null;
// Incremental replay: apply only the new slice when scrubbing forward; rebuild from the nearest checkpoint when going back.
const CHECKPOINT_EVERY = 500;
let replayCheckpoints: State[] = [];
let replayCursor = 0;
let replayState: State | null = null;

function replayClockAt(index: number): number { const e = time.events[Math.max(0, Math.min(time.events.length, index) - 1)]; return e ? Date.parse(e.ts) : Date.now(); }

function rebuildReplayTo(index: number): void {
  const evs = time.events;
  if (!replayState || index < replayCursor) {
    const cp = Math.floor(index / CHECKPOINT_EVERY);
    replayState = replayCheckpoints[cp] ?? replayBase ?? emptyState();
    replayCursor = cp * CHECKPOINT_EVERY;
    replayCheckpoints.length = cp + 1;
  }
  for (let i = replayCursor; i < index; i++) {
    const e = evs[i];
    replayState = applyEvent(replayState, e, Date.parse(e.ts) + 5000);
    if ((i + 1) % CHECKPOINT_EVERY === 0) replayCheckpoints[(i + 1) / CHECKPOINT_EVERY] = replayState;
  }
  replayCursor = index;
  // surfaces from stored frames (spec §10 replay reconstructs Surfaces)
  for (const [id, f] of Object.entries(replayState.frames)) if (f.path) frames[id] = `/screens/${f.path.replace('.cubicle/screens/', '')}${ctx.tokenQuery}`;
  state = { ...replayState, mode: 'replay', connected: state.connected };
  refresh();
}

scene.hooks = {
  getState: () => state,
  frames: () => frames,
  hour: () => time.hour(new Date()),
  clock: () => (state.mode === 'replay' ? replayClockAt(time.index) : Date.now()),
  onSurfaceClick(kind) { open(kind); },
  onAgentClick(role) { open(`agent:${role}`); scene.focusOn(`desk:${role}`); },
};

function agentView(role: string): { title: string; sub?: string; html: string; mode: 'drawer' } {
  const ag = state.agents[role];
  const job = ag?.job ? state.jobs[ag.job] : null;
  const charter = obsidianUrl(vaultName, `Roles/${role}.md`);
  const jobHtml = job
    ? `<div class="rows"><button class="row click" data-open="job:${esc(job.id)}">${chip(job.status)}<span class="t">${esc(job.title)}<small>${esc(job.type)} · step ${job.checkpoint_step}</small></span><span class="when">open</span></button></div>`
    : `<div class="empty">Not on a job right now.</div>`;
  const stateLine = `${esc(ag?.state.replace(/_/g, ' ') ?? 'offline')}${ag?.tool ? ` · using ${esc(ag.tool)}` : ''}`;
  const team = state.teams.find((t) => t.lead === role || t.members.includes(role)) ?? null;
  const leadRole = team ? (team.lead === role ? (role === 'ceo' ? null : 'ceo') : team.lead) : null;
  const leadDisplay = leadRole ? state.agents[leadRole]?.display ?? leadRole.toUpperCase() : null;
  const subParts = [stateLine, esc(ag?.title ?? ag?.display ?? role)];
  if (team) subParts.push(esc(team.name));
  if (leadDisplay) subParts.push(`reports to ${esc(leadDisplay)}`);
  const sub = subParts.filter(Boolean).join(' · ');
  return { mode: 'drawer', title: ag?.display ?? role, sub, html: `<div class="section"><h3>Current job</h3>${jobHtml}</div><div class="section"><h3>Charter</h3><div class="card">${charter ? `<a href="${esc(charter)}">Edit Roles/${esc(role)}.md in Obsidian</a>` : `Edit <code>Roles/${esc(role)}.md</code> in Obsidian.`}<div class="hintline">Desk: ${esc(ag?.desk ?? '—')}. Charters can only tighten what a role may do.</div></div></div>` };
}

function viewOf(kind: string) { return kind.startsWith('agent:') ? agentView(kind.slice(6)) : viewFor(kind, state, ctx); }

/** Open anything by kind: a surface, `agent:<role>`, or `job:<id>`. */
function open(kind: string): void {
  ui.show(kind, viewOf(kind));
  if (!kind.includes(':')) scene.focusOn(kind === 'cabin' ? 'cabin' : kind);
}

function refresh(): void {
  if (ui.current) ui.update(ui.current, viewOf(ui.current));
  if (ui.currentDoc) ui.update(ui.currentDoc, viewOf(ui.currentDoc));
  ui.setPending(state.pendingProposals);
  ui.setBrand(state.brand.name, state.brand.tagline);
}

ui.onOpen = (kind) => open(kind);
ui.onChat = (text) => {
  if (!net.chat(text)) return;
  state = { ...state, chat: [...state.chat, { ts: new Date().toISOString(), from: 'you', text }] };
  refresh();
  ui.note('Sent. The CEO answers on the next heartbeat, usually within a minute.');
};

function seedFrames(snap: Snapshot): void {
  // "otherwise last screenshot": every snapshot surface without a live frame shows its stored frame from the daemon.
  for (const su of snap.surfaces) if (su.lastFrame && !frames[su.streamId]?.startsWith('data:')) frames[su.streamId] = `/screens/${su.lastFrame.replace('.cubicle/screens/', '')}${ctx.tokenQuery}`;
  for (const id of Object.keys(frames)) if (!snap.surfaces.some((su) => su.streamId === id)) delete frames[id];
}
const net = new Net(url, token, {
  onSnapshot(snap: Snapshot) {
    if (state.mode === 'replay') { liveState = applySnapshot(liveState ?? emptyState(), snap); return; }
    state = applySnapshot(state, snap);
    seedFrames(snap);
    refresh();
    // Spec §12 d/e: an empty company opens on the cabin with the first-run question, once per session.
    if (state.firstRun && !firstRunOpened) { firstRunOpened = true; open('cabin'); }
  },
  onEvent(e) {
    if (state.mode === 'replay') { if (liveState) liveState = applyEvent(liveState, e); return; }
    state = applyEvent(state, e);
    if (e.type === 'browser.frame' && !frames[String(e.payload.session)]) frames[String(e.payload.session)] = `/screens/${String(e.payload.path).replace('.cubicle/screens/', '')}${ctx.tokenQuery}`;
    if (state.staleSnapshot) { state = { ...state, staleSnapshot: false }; net.snapshot(); } // plan / brief / inbox changed on disk → refresh text
    refresh();
  },
  onFrame(f) { frames[f.streamId] = `data:image/jpeg;base64,${f.jpegBase64}`; },
  onReplay(r) {
    replayBuffer = replayBuffer.concat(r.events);
    if (!r.done) { net.replay(r.from, r.to, r.cursor); return; }
    if (state.mode === 'live') liveState = state;
    replayBase = emptyState();
    // seed roles from the live snapshot so sprites exist even before their first event of the day
    if (liveState) replayBase = { ...replayBase, agents: Object.fromEntries(Object.entries(liveState.agents).map(([k, v]) => [k, { ...v, state: 'idle_at_desk' as const, job: null, tool: null, bubble: null, target: null, badge: null }])), plan: liveState.plan, latestRun: liveState.latestRun, quota: liveState.quota, brand: liveState.brand };
    replayCheckpoints = []; replayState = null; replayCursor = 0;
    time.setReplay(replayBuffer);
    rebuildReplayTo(0);
    ui.setConn(true, `replay · ${replayBuffer.length} events`);
  },
  onStatus(ok, detail) { state = { ...state, connected: ok }; ui.setConn(ok, ok ? 'live' : detail); },
});
net.connect();

(window as unknown as { __cubicle: unknown }).__cubicle = { get state() { return state; }, agents: () => scene.debugAgents(), anchors: () => scene.debugAnchors(), open, zoom: (z: number) => scene.cameras.main.setZoom(z), center: (tx: number, ty: number) => scene.cameras.main.centerOn(tx * 16, ty * 16) };

let last = performance.now();
function loop(now: number): void {
  const dt = now - last; last = now;
  time.tick(dt, new Date());
  if (state.mode === 'live') state = tick(state, Date.now());
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
