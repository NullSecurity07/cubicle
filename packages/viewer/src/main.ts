import Phaser from 'phaser';
import { OfficeScene } from './scenes/OfficeScene.js';
import { Net, resolveWs } from './net.js';
import { emptyState, applyEvent, applySnapshot, tick, type State, type CubicleEvent, type Snapshot } from './state.js';
import { Panel, md } from './ui/panel.js';
import { TimeControls } from './ui/time.js';
import type { SurfaceKind } from './world/surfaces.js';

let state: State = emptyState();
let liveState: State | null = null;   // saved while replaying
const frames: Record<string, string> = {};   // streamId → data URL (live) or /screens/ URL (replay)
const panel = new Panel();
const conn = document.getElementById('conn')!;
const pendingEl = document.getElementById('pending')!;
const { url, token } = resolveWs();
const vaultName = new URLSearchParams(location.search).get('vault') ?? '';

const scene = new OfficeScene();
const game = new Phaser.Game({ type: Phaser.AUTO, parent: 'game', backgroundColor: '#0f1115', pixelArt: true, roundPixels: true, scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' }, scene: [scene] });
void game;

const time = new TimeControls({
  onLive() { if (liveState) { state = liveState; liveState = null; } state = { ...state, mode: 'live' }; net.snapshot(); },
  onReplayRequest(date) { replayBuffer = []; const start = new Date(`${date}T00:00:00`); const end = new Date(start.getTime() + 86400_000 - 1); net.replay(start.toISOString(), end.toISOString(), 0); conn.textContent = `loading ${date}…`; }, // local day → ISO
  onScrub(index) { rebuildReplayTo(index); },
});
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
  for (const [id, f] of Object.entries(replayState.frames)) if (f.path) frames[id] = `/screens/${f.path.replace('.cubicle/screens/', '')}${tokenQuery()}`;
  state = { ...replayState, mode: 'replay', connected: state.connected };
  refreshPanel();
}
function tokenQuery(): string { return token ? `?token=${encodeURIComponent(token)}` : ''; }

scene.hooks = {
  getState: () => state,
  frames: () => frames,
  hour: () => time.hour(new Date()),
  clock: () => (state.mode === 'replay' ? replayClockAt(time.index) : Date.now()),
  onSurfaceClick(kind) { openSurface(kind); },
  onAgentClick(role) { const ag = state.agents[role]; const job = ag?.job ? state.jobs[ag.job] : null; panel.open(`agent:${role}`, `${ag?.display ?? role}`, md(`**State:** ${ag?.state}${ag?.tool ? ` (${ag.tool})` : ''}\n\n**Job:** ${job ? `${job.title} — ${job.status}, step ${job.checkpoint_step}${obs(`Jobs/${job.id}.md`, ' · open job')}` : 'none'}\n\n**Desk:** ${ag?.desk}\n\n${obs(`Roles/${role}.md`, 'Edit the charter in Obsidian') || `Open \`Roles/${role}.md\` in Obsidian to edit the charter.`}`)); scene.focusOn(`desk:${role}`); },
};

/** obsidian://open link for a vault file when the vault name is known (`?vault=`), else ''. */
function obs(file: string, label: string): string { return vaultName ? `[${label}](obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file.replace(/\.md$/, ''))})` : ''; }

function surfaceHtml(kind: SurfaceKind): { title: string; html: string; chat?: boolean } {
  const s = state;
  switch (kind) {
    case 'billboard': { const cur = Object.values(s.surfaces).filter((x) => x.streamKind === 'browser').sort((a, b) => Number(b.active) - Number(a.active))[0]; const src = cur ? frames[cur.streamId] ?? (cur.lastFrame ? `/screens/${cur.lastFrame.replace('.cubicle/screens/', '')}${tokenQuery()}` : '') : ''; return { title: 'Billboard — browser', html: src ? `<img src="${escapeHtml(src)}" alt="browser" />` : '<p class="muted">No browser session yet. Growth and the Engineer stand here while browsing.</p>' }; }
    case 'terminal': return { title: 'Terminal shed — shell output', html: `<pre>${escapeHtml(s.terminal.slice(-120).join('\n')) || 'nothing yet'}</pre>` };
    case 'postoffice': return { title: `Post office — ${s.pendingProposals} awaiting approval`, html: md(`Approvals live in \`00 Inbox/\` — set \`approved: true\` there.\n\n${s.mail.slice(-30).map((m) => `- ${m.ts.slice(11, 16)} ${m.text}`).join('\n') || '_no mail yet_'}`) };
    case 'newsstand': return { title: 'Newsstand — latest brief', html: md((s.latestRun ? s.latestRun.body + '\n\n' + obs(s.latestRun.path, 'Open this brief in Obsidian') : '_No brief yet — it appears after the first heartbeat._') + '\n\n## Feed\n\n' + s.feed.slice(-40).reverse().map((f) => `- ${f.ts.slice(5, 16).replace('T', ' ')} ${f.text}`).join('\n')) };
    case 'bank': return { title: 'Bank — quota runway', html: `<table><tr><th>provider</th><th>model</th><th>calls/min</th><th>calls/day</th><th>status</th></tr>${s.quota.map((q) => `<tr><td>${escapeHtml(q.provider)}</td><td>${escapeHtml(q.model)}</td><td>${q.rpm_used}/${q.limits.rpm || '∞'}</td><td>${q.rpd_used}/${q.limits.rpd || '∞'}</td><td>${q.cooling_until ? 'cooling' : 'ok'}</td></tr>`).join('')}</table><p class="muted">Free calls are the runway. Edit limits in config/providers.yaml.</p>` };
    case 'vault': { const link = vaultName ? `obsidian://open?vault=${encodeURIComponent(vaultName)}` : null; return { title: 'Vault', html: md(`${link ? `[Open the vault in Obsidian](${link})` : 'Add `?vault=<name>` to this URL to enable the Obsidian links.'}\n\n## Jobs\n\n${Object.values(s.jobs).slice(-40).reverse().map((j) => `- **${j.status}** ${j.assigned} · ${j.title} (${j.type}, step ${j.checkpoint_step})${obs(`Jobs/${j.id}.md`, ' → open')}`).join('\n')}`) }; }
    case 'workshop': { const url = s.deploys.at(-1)?.url ?? ''; return { title: 'Workshop — site preview', html: `${url ? `<p>Last deploy: <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></p>` : '<p class="muted">Not deployed yet.</p>'}<iframe src="/site/${tokenQuery()}" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" style="width:100%;height:60vh;border:1px solid #2a2e37;background:#fff" title="site preview"></iframe><p class="muted">Preview of Site/dist, isolated from the office (sandboxed iframe). Build it with shell.run: npm run build.</p>` }; }
    case 'whiteboard': return { title: 'Whiteboard — Plans/plan.md', html: md(s.plan || '_No plan yet._') };
    case 'noticeboard': return { title: 'Notice board — job queue', html: md(Object.values(s.jobs).filter((j) => j.status !== 'done' && j.status !== 'cancelled').map((j) => `- **${j.status}** p${j.priority} ${j.assigned}: ${j.title}`).join('\n') || '_queue empty_') };
    case 'cabin': return { title: 'CEO cabin', html: md(`${s.latestRun ? '## Pinned brief\n\n' + s.latestRun.body : 'What company will you start today? Type an idea below, or "surprise me".'}\n\n## Conversation\n\n${s.feed.filter((f) => f.text.startsWith('CEO → you')).slice(-10).map((f) => `- ${f.text}`).join('\n')}`), chat: true };
  }
}

function openSurface(kind: SurfaceKind): void { const v = surfaceHtml(kind); panel.open(`surface:${kind}`, v.title, v.html, { chat: v.chat }); scene.focusOn(kind === 'cabin' ? 'cabin' : kind); }
function refreshPanel(): void { if (panel.current?.startsWith('surface:')) { const k = panel.current.slice(8) as SurfaceKind; panel.update(panel.current, surfaceHtml(k).html); } pendingEl.textContent = `${state.pendingProposals} to approve`; pendingEl.className = `pill${state.pendingProposals ? ' bad' : ''}`; }
function escapeHtml(s: string): string { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)); }

panel.onChat = (text) => { if (net.chat(text)) panel.update('surface:cabin', surfaceHtml('cabin').html + `<p class="muted">sent — the CEO answers on the next heartbeat (≤ 30 s to start)</p>`); };

function seedFrames(snap: Snapshot): void {
  // "otherwise last screenshot": every snapshot surface without a live frame shows its stored frame from the daemon.
  for (const su of snap.surfaces) if (su.lastFrame && !frames[su.streamId]?.startsWith('data:')) frames[su.streamId] = `/screens/${su.lastFrame.replace('.cubicle/screens/', '')}${tokenQuery()}`;
  for (const id of Object.keys(frames)) if (!snap.surfaces.some((su) => su.streamId === id)) delete frames[id];
}
const net = new Net(url, token, {
  onSnapshot(snap: Snapshot) { if (state.mode === 'replay') { liveState = applySnapshot(liveState ?? emptyState(), snap); return; } state = applySnapshot(state, snap); seedFrames(snap); refreshPanel(); },
  onEvent(e) {
    if (state.mode === 'replay') { if (liveState) liveState = applyEvent(liveState, e); return; }
    state = applyEvent(state, e);
    if (e.type === 'browser.frame' && !frames[String(e.payload.session)]) frames[String(e.payload.session)] = `/screens/${String(e.payload.path).replace('.cubicle/screens/', '')}${tokenQuery()}`;
    if (state.staleSnapshot) { state = { ...state, staleSnapshot: false }; net.snapshot(); } // plan / brief changed on disk → refresh text
    refreshPanel();
  },
  onFrame(f) { frames[f.streamId] = `data:image/jpeg;base64,${f.jpegBase64}`; },
  onReplay(r) {
    replayBuffer = replayBuffer.concat(r.events);
    if (!r.done) { net.replay(r.from, r.to, r.cursor); return; }
    if (state.mode === 'live') liveState = state;
    replayBase = emptyState();
    // seed roles from the live snapshot so sprites exist even before their first event of the day
    if (liveState) replayBase = { ...replayBase, agents: Object.fromEntries(Object.entries(liveState.agents).map(([k, v]) => [k, { ...v, state: 'idle_at_desk' as const, job: null, tool: null, bubble: null, target: null, badge: null }])), plan: liveState.plan, latestRun: liveState.latestRun, quota: liveState.quota };
    replayCheckpoints = []; replayState = null; replayCursor = 0;
    time.setReplay(replayBuffer);
    rebuildReplayTo(0);
    conn.textContent = `replay · ${replayBuffer.length} events`;
  },
  onStatus(ok, detail) { state = { ...state, connected: ok }; conn.textContent = ok ? 'live' : detail; conn.className = `pill${ok ? '' : ' bad'}`; },
});
net.connect();

(window as unknown as { __cubicle: unknown }).__cubicle = { get state() { return state; }, agents: () => scene.debugAgents(), anchors: () => scene.debugAnchors() };

let last = performance.now();
function loop(now: number): void {
  const dt = now - last; last = now;
  time.tick(dt, new Date());
  if (state.mode === 'live') state = tick(state, Date.now());
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
