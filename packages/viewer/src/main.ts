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
  onReplayRequest(date) { replayBuffer = []; net.replay(`${date}T00:00:00.000Z`, `${date}T23:59:59.999Z`, 0); conn.textContent = `loading ${date}…`; },
  onScrub(index) { rebuildReplayTo(index); },
});
let replayBuffer: CubicleEvent[] = [];
let replayBase: State | null = null;

function rebuildReplayTo(index: number): void {
  let s = replayBase ?? emptyState();
  const evs = time.events.slice(0, index);
  for (const e of evs) s = applyEvent(s, e, Date.parse(e.ts) + 5000);
  // surfaces from stored frames (spec §10 replay reconstructs Surfaces)
  for (const [id, f] of Object.entries(s.frames)) if (f.path) frames[id] = `/screens/${f.path.replace('.cubicle/screens/', '')}`;
  state = { ...s, mode: 'replay', connected: state.connected };
  refreshPanel();
}

scene.hooks = {
  getState: () => state,
  frames: () => frames,
  hour: () => time.hour(new Date()),
  onSurfaceClick(kind) { openSurface(kind); },
  onAgentClick(role) { const ag = state.agents[role]; const job = ag?.job ? state.jobs[ag.job] : null; panel.open(`agent:${role}`, `${ag?.display ?? role}`, md(`**State:** ${ag?.state}${ag?.tool ? ` (${ag.tool})` : ''}\n\n**Job:** ${job ? `${job.title} — ${job.status}, step ${job.checkpoint_step}` : 'none'}\n\n**Desk:** ${ag?.desk}\n\nOpen \`Roles/${role}.md\` in Obsidian to edit the charter.`)); scene.focusOn(`desk:${role}`); },
};

function surfaceHtml(kind: SurfaceKind): { title: string; html: string; chat?: boolean } {
  const s = state;
  switch (kind) {
    case 'billboard': { const cur = Object.values(s.surfaces).filter((x) => x.streamKind === 'browser').sort((a, b) => Number(b.active) - Number(a.active))[0]; const src = cur ? frames[cur.streamId] ?? (cur.lastFrame ? `/screens/${cur.lastFrame.replace('.cubicle/screens/', '')}` : '') : ''; return { title: 'Billboard — browser', html: src ? `<img src="${src}" alt="browser" />` : '<p class="muted">No browser session yet. Growth and the Engineer stand here while browsing.</p>' }; }
    case 'terminal': return { title: 'Terminal shed — shell output', html: `<pre>${escapeHtml(s.terminal.slice(-120).join('\n')) || 'nothing yet'}</pre>` };
    case 'postoffice': return { title: `Post office — ${s.pendingProposals} awaiting approval`, html: md(`Approvals live in \`00 Inbox/\` — set \`approved: true\` there.\n\n${s.mail.slice(-30).map((m) => `- ${m.ts.slice(11, 16)} ${m.text}`).join('\n') || '_no mail yet_'}`) };
    case 'newsstand': return { title: 'Newsstand — latest brief', html: md((s.latestRun?.body ?? '_No brief yet — it appears after the first heartbeat._') + '\n\n## Feed\n\n' + s.feed.slice(-40).reverse().map((f) => `- ${f.ts.slice(5, 16).replace('T', ' ')} ${f.text}`).join('\n')) };
    case 'bank': return { title: 'Bank — quota runway', html: `<table><tr><th>provider</th><th>model</th><th>calls/min</th><th>calls/day</th><th>status</th></tr>${s.quota.map((q) => `<tr><td>${q.provider}</td><td>${q.model}</td><td>${q.rpm_used}/${q.limits.rpm || '∞'}</td><td>${q.rpd_used}/${q.limits.rpd || '∞'}</td><td>${q.cooling_until ? 'cooling' : 'ok'}</td></tr>`).join('')}</table><p class="muted">Free calls are the runway. Edit limits in config/providers.yaml.</p>` };
    case 'vault': { const link = vaultName ? `obsidian://open?vault=${encodeURIComponent(vaultName)}` : null; return { title: 'Vault', html: md(`${link ? `[Open the vault in Obsidian](${link})` : 'Add `?vault=<name>` to this URL to enable the Obsidian link.'}\n\n## Jobs\n\n${Object.values(s.jobs).slice(-40).reverse().map((j) => `- **${j.status}** ${j.assigned} · ${j.title} (${j.type}, step ${j.checkpoint_step})`).join('\n')}`) }; }
    case 'workshop': return { title: 'Workshop — site preview', html: `${s.deploys.length ? `<p>Last deploy: <a href="${s.deploys.at(-1)!.url}" target="_blank" rel="noopener">${s.deploys.at(-1)!.url}</a></p>` : '<p class="muted">Not deployed yet.</p>'}<iframe src="/site/" style="width:100%;height:60vh;border:1px solid #2a2e37;background:#fff" title="site preview"></iframe><p class="muted">Preview of Site/dist (build it with shell.run: npm run build).</p>` };
    case 'whiteboard': return { title: 'Whiteboard — Plans/plan.md', html: md(s.plan || '_No plan yet._') };
    case 'noticeboard': return { title: 'Notice board — job queue', html: md(Object.values(s.jobs).filter((j) => j.status !== 'done' && j.status !== 'cancelled').map((j) => `- **${j.status}** p${j.priority} ${j.assigned}: ${j.title}`).join('\n') || '_queue empty_') };
    case 'cabin': return { title: 'CEO cabin', html: md(`${s.latestRun ? '## Pinned brief\n\n' + s.latestRun.body : 'What company will you start today? Type an idea below, or "surprise me".'}\n\n## Conversation\n\n${s.feed.filter((f) => f.text.startsWith('CEO → you')).slice(-10).map((f) => `- ${f.text}`).join('\n')}`), chat: true };
  }
}

function openSurface(kind: SurfaceKind): void { const v = surfaceHtml(kind); panel.open(`surface:${kind}`, v.title, v.html, { chat: v.chat }); scene.focusOn(kind === 'cabin' ? 'cabin' : kind); }
function refreshPanel(): void { if (panel.current?.startsWith('surface:')) { const k = panel.current.slice(8) as SurfaceKind; panel.update(panel.current, surfaceHtml(k).html); } pendingEl.textContent = `${state.pendingProposals} to approve`; pendingEl.className = `pill${state.pendingProposals ? ' bad' : ''}`; }
function escapeHtml(s: string): string { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)); }

panel.onChat = (text) => { if (net.chat(text)) panel.update('surface:cabin', surfaceHtml('cabin').html + `<p class="muted">sent — the CEO answers on the next heartbeat (≤ 30 s to start)</p>`); };

const net = new Net(url, token, {
  onSnapshot(snap: Snapshot) { if (state.mode === 'replay') { liveState = applySnapshot(liveState ?? emptyState(), snap); return; } state = applySnapshot(state, snap); refreshPanel(); },
  onEvent(e) { if (state.mode === 'replay') { if (liveState) liveState = applyEvent(liveState, e); return; } state = applyEvent(state, e); if (e.type === 'browser.frame' && !frames[String(e.payload.session)]) frames[String(e.payload.session)] = `/screens/${String(e.payload.path).replace('.cubicle/screens/', '')}`; refreshPanel(); },
  onFrame(f) { frames[f.streamId] = `data:image/jpeg;base64,${f.jpegBase64}`; },
  onReplay(r) {
    replayBuffer = replayBuffer.concat(r.events);
    if (!r.done) { net.replay(r.from, r.to, r.cursor); return; }
    if (state.mode === 'live') liveState = state;
    replayBase = emptyState();
    // seed roles from the live snapshot so sprites exist even before their first event of the day
    if (liveState) replayBase = { ...replayBase, agents: Object.fromEntries(Object.entries(liveState.agents).map(([k, v]) => [k, { ...v, state: 'idle_at_desk' as const, job: null, tool: null, bubble: null, target: null, badge: null }])), plan: liveState.plan, latestRun: liveState.latestRun, quota: liveState.quota };
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
