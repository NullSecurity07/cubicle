import './ui/tokens.css';
import './ui/app.css';
import Phaser from 'phaser';
import { OfficeScene } from './scenes/OfficeScene.js';
import { Net, resolveWs } from './net.js';
import { emptyState, applyEvent, applySnapshot, tick, withFrameSeq, type State, type CubicleEvent, type Snapshot } from './state.js';
import { Panel, SURPRISE_ME, type Origin } from './ui/panel.js';
import { TopBar } from './ui/bar.js';
import { applyTheme, currentTheme, themeFromQuery, THEMES } from './ui/tokens.js';
import type { Ctx } from './ui/content.js';
import { viewFor, SURFACES } from './ui/surfaces.js';
import { TimeControls } from './ui/time.js';
import { TILE } from './world/tileset.js';
import { withMotion, reducedMotion } from './world/motion.js';
import { ElevatorView, toViewState, emptyViewState } from './world/elevator-view.js';
import { announce, announcementFor, coachMark, toast } from './ui/notify.js';
import { FirstRun } from './ui/firstrun.js';
import { QuickOpen, quickItems } from './ui/quickopen.js';
import { bindKeys, keysView } from './ui/keys.js';
import { Rail, LOBBY_ROW } from './ui/rail.js';
import { MinimapChrome } from './ui/minimap.js';
import { floorPalette } from './world/palette.js';
import { DUR, EASE, dur } from './world/motion.js';

applyTheme(themeFromQuery(location.search));   // before the first paint: no white flash on load or theme switch
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
withMotion(reducedMotion() ? 0 : 1);
motionQuery.addEventListener('change', () => withMotion(motionQuery.matches ? 0 : 1));

let state: State = emptyState();
let liveState: State | null = null;   // saved while replaying
const frames: Record<string, string> = {};   // streamId → data URL (live) or /screens/ URL (replay)
const fps: Record<string, number> = {};
const bar = new TopBar();
const { url, token } = resolveWs();
const vaultName = new URLSearchParams(location.search).get('vault') ?? '';
const ctx: Ctx = { frames, tokenQuery: token ? `?token=${encodeURIComponent(token)}` : '', vaultName, fps };

const scene = new OfficeScene();
const game = new Phaser.Game({ type: Phaser.AUTO, parent: 'game', backgroundColor: THEMES[currentTheme()].colors.bg, pixelArt: true, roundPixels: true, scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' }, scene: [scene] });
// Click isolation (see scripts/test-overlay-clicks.ts): a press that starts on any HTML element — bar, rail, panel,
// scrim, time bar, minimap chrome, toast, first-run card, quick open — never reaches Phaser's window listeners.
// Releases still reach Phaser, so a drag let go over the HTML layer ends cleanly (the pointer's `isDown` clears).
for (const type of ['mousedown', 'touchstart'] as const) document.addEventListener(type, (e) => { if (!(e.target as Element).closest?.('#game')) e.stopPropagation(); });
// Where the last press on the office happened: a level-2 presentation grows from there ("Depth": deeper levels grow from the click).
let lastPress: Origin | null = null;
document.getElementById('game')!.addEventListener('pointerdown', (e) => { lastPress = { x: e.clientX - 80, y: e.clientY - 50, w: 160, h: 100 }; });

const time = new TimeControls({
  onLive() { if (liveState) { state = liveState; liveState = null; } state = { ...state, mode: 'live' }; net.snapshot(); },
  onReplayRequest(date) { replayBuffer = []; const start = new Date(`${date}T00:00:00`); const end = new Date(start.getTime() + 86400_000 - 1); net.replay(start.toISOString(), end.toISOString(), 0); bar.setConn(true, `loading ${date}`); }, // local day → ISO
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

let elevatorView: ElevatorView | null = null;
/** The one view-state object the rAF loop fills and hands to the elevator view (see `toViewState`). */
const elevatorViewState = emptyViewState();
function viewOf(kind: string): ReturnType<typeof viewFor> {
  if (kind === 'keys') return keysView();              // the shortcut sheet is the one kind with no data behind it
  try { ctx.floorLabels ??= Object.fromEntries(scene.floorSummary().map((f) => [f.floor, f.label])); } catch { /* the scene has not created its world yet */ }
  return viewFor(kind, state, ctx);
}
const panel = new Panel({ viewOf, onOpen: (kind) => open(kind), onLocate: (target) => scene.focusOn(target), onEmpty: () => scene.restoreZoom(), onChat: (text) => sendChat(text) });
// Built, not shown. The first-run card is the other first-contact message; the mark waits until the first snapshot
// says the card is not coming, or until the card has gone (ui/firstrun.ts `onDismissed`).
const coach = coachMark('Drag to pan, scroll to zoom, click anything in the office. Press ? for shortcuts.');

scene.hooks = {
  getState: () => state,
  frames: () => frames,
  hour: () => time.hour(new Date()),
  clock: () => (state.mode === 'replay' ? replayClockAt(time.index) : Date.now()),
  onSurfaceClick(kind) { open(kind, lastPress ?? undefined); },
  onAgentClick(role) { open(role === 'ceo' ? 'cabin' : `agent:${role}`, lastPress ?? undefined); },   // the CEO sprite is the owner's channel
  makeCar(sc, geo) { elevatorView = new ElevatorView(sc, geo.shaft, geo.floors); return elevatorView.car; },
  elevatorIgnorables: () => elevatorView?.ignorables() ?? [],
  // a scene restart (or the game shutting down) must not leave a destroyed car's frame loop still polling it
  onSceneShutdown() { elevatorView?.destroy(); elevatorView = null; },
};

// ---- floor rail and minimap chrome ----------------------------------------------------------------------------
// The rail reads the scene every refresh (cheap: it morphs). The chrome is HTML laid over the Phaser minimap camera,
// which only exists after `create`, so `layout()` also runs on a slow beat in the loop until the camera turns up.
/** The scene reports an agent's colour as a Phaser int; the rail's view type is `#rrggbb`, so convert on the way in. */
const agentHex = (n: number): string => `#${(n >>> 0).toString(16).padStart(6, '0')}`;
const rail = new Rail({
  summary: () => scene.floorSummary().map((f) => ({ ...f, agents: f.agents.map((a) => ({ ...a, color: agentHex(a.color) })) })),
  currentFloor: () => scene.currentFloor(),
  inLobby: () => scene.currentFloor() === 1 && (scene.cameras?.main?.midPoint.y ?? 0) / TILE >= LOBBY_ROW,
  divisions: () => { const d: Record<number, string[]> = {}; for (const t of state.teams) if (t.floor && !t.parent) (d[t.floor] ??= []).push(t.name); return d; },
  onFloor: (n) => scene.focusFloor(n),
  onLobby: () => scene.focusOn('noticeboard'),
});
const minimap = new MinimapChrome({
  // `scrollX/scrollY` here is the camera's top-left *in world space*, which on a zoomed camera is `worldView`, not
  // the raw scroll (Phaser keeps scroll unzoomed: worldView.x = scrollX + width/2 - width/zoom/2).
  camera: () => { const c = scene.cameras?.getCamera('minimap'); return c ? { x: c.x, y: c.y, width: c.width, height: c.height, scrollX: c.worldView.x, scrollY: c.worldView.y, zoom: c.zoom } : null; },
  colours: () => ({ 1: floorPalette(1).tab, 2: floorPalette(2).tab, 3: floorPalette(3).tab, 4: floorPalette(4).tab }),
  onPan: (wx, wy) => scene.cameras.main.pan(wx, wy, dur(DUR.minimapPan), EASE.sine),
  onToggle: (visible) => scene.cameras.getCamera('minimap')?.setVisible(visible),
});
scene.hooks.onFloorChange = () => rail.update();
window.addEventListener('resize', () => minimap.layout());
// ---------------------------------------------------------------------------------------------------------------

/**
 * The single entry for opening anything: a surface, a room, `agent:<role>`, `job:<id>`, `org`. Pushes onto the
 * stack and focuses the camera. Only a user's own click zooms (`zoom: false` for anything the app opens by itself).
 */
function open(kind: string, origin?: Origin, opts: { zoom?: boolean } = {}): void {
  if (kind === 'ceo_office') kind = 'cabin';           // the CEO office is the owner's channel
  const zoom = opts.zoom ?? true;
  panel.show(kind, viewOf(kind), origin ?? undefined);
  if (kind.startsWith('agent:')) scene.focusOn(kind, { zoom });
  else if (!kind.includes(':') && kind !== 'org' && kind !== 'keys') scene.focusOn(kind, { zoom });
}

function refresh(): void {
  if (panel.current) panel.update(panel.current, viewOf(panel.current));
  rail.update();
  bar.setPending(state.pendingProposals);
  bar.setBrand(state.brand.name, state.brand.tagline);
}

function sendChat(text: string): void {
  if (!net.chat(text)) return;
  state = { ...state, chat: [...state.chat, { ts: new Date().toISOString(), from: 'you', text }] };
  refresh();
  panel.note('Sent. The CEO answers on the next heartbeat, usually within a minute.');
}

// ---- first run, quick open, keyboard, time bar (overlay task 9) ----
// The first-run card asks the one question; Start and "Surprise me" both go down the composer's chat path, then the
// card collapses into the cabin sheet. The app opened the card, so the sheet it hands over to never zooms the camera.
const firstRun = new FirstRun({
  onStart: (text) => { sendChat(text); void firstRun.collapse().then(() => open('cabin', undefined, { zoom: false })); },
  onSurprise: () => { sendChat(SURPRISE_ME); void firstRun.collapse().then(() => open('cabin', undefined, { zoom: false })); },
  onDismissed: () => coach.show(),   // the office hint takes its turn only once the card has gone
});
const quick = new QuickOpen({ items: () => quickItems(state), onPick: (kind) => open(kind) });
/** `__cubicle.setHour` mirrored: the scene tints by it, and the time bar's sun/moon must read the same hour. */
let hourOverride: number | null = null;

/** `M` goes to the chrome above, which owns both the HTML frame and the Phaser minimap camera's visibility. */
const minimapHook: { toggle(): void } = { toggle: () => minimap.toggle() };

bindKeys({
  floor1: () => scene.focusFloor(1), floor2: () => scene.focusFloor(2), floor3: () => scene.focusFloor(3), floor4: () => scene.focusFloor(4),
  // `0` fits the whole tower. One implementation, in the scene: this used to be a second, instant one here,
  // and the scene's own `keys.ZERO` fired on the same keypress, so the two fights over the camera were visible.
  lobby: () => scene.focusOn('noticeboard'), fit: () => scene.fitTower(),
  talk: () => open('cabin'), queue: () => open('noticeboard'), brief: () => open('newsstand'), plan: () => open('whiteboard'), org: () => open('org'),
  pause: () => time.togglePlay(), prev: () => time.step(-1), next: () => time.step(1),
  minimap: () => minimapHook.toggle(), help: () => open('keys'), quickopen: () => quick.open(),
});

/**
 * A live frame arrived (from the daemon or `__cubicle.pushFrame`): remember it, count it, measure the rate, refresh
 * a viewer at most 5×/s. The count is the one the viewer's title bar prints; `seq` is the daemon's own counter when
 * the socket carried one, and a locally pushed frame just advances it (state.ts `withFrameSeq`).
 */
const frameTimes: Record<string, number[]> = {};
let liveRefresh = 0;
function onFrameData(streamId: string, dataUrl: string, seq?: number): void {
  frames[streamId] = dataUrl;
  state = withFrameSeq(state, streamId, seq);
  const t = (frameTimes[streamId] ??= []); t.push(performance.now()); if (t.length > 10) t.shift();
  fps[streamId] = t.length > 1 ? ((t.length - 1) * 1000) / (t[t.length - 1] - t[0]) : 0;
  if (panel.current === 'billboard' && !liveRefresh) liveRefresh = window.setTimeout(() => { liveRefresh = 0; refresh(); }, 200);
}

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
    // Spec §12 d/e: an empty company asks the first-run question once per session. The app opened the card, not the
    // owner, so nothing zooms the camera; Escape just hides it and the cabin keeps asking until the company has a name.
    if (state.firstRun && !firstRunOpened) { firstRunOpened = true; firstRun.show(); }
    else coach.show();   // no card coming: the office hint is the only first-contact message
  },
  onEvent(e) {
    if (state.mode === 'replay') { if (liveState) liveState = applyEvent(liveState, e); return; }
    state = applyEvent(state, e);
    const said = announcementFor(e);
    if (said) announce(said);
    if (e.type === 'proposal.created' && e.payload.kind !== 'message') toast(said!, { action: { label: 'Open', open: 'postoffice' } });
    if (e.type === 'deploy.done') toast(said!, { action: { label: 'See it', open: 'workshop' } });
    if (e.type === 'browser.frame' && !frames[String(e.payload.session)]) frames[String(e.payload.session)] = `/screens/${String(e.payload.path).replace('.cubicle/screens/', '')}${ctx.tokenQuery}`;
    if (state.staleSnapshot) { state = { ...state, staleSnapshot: false }; net.snapshot(); } // plan / brief / inbox changed on disk → refresh text
    refresh();
  },
  onFrame(f) { onFrameData(f.streamId, `data:image/jpeg;base64,${f.jpegBase64}`, f.seq); },
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
    bar.setConn(true, `replay · ${replayBuffer.length} events`);
  },
  onStatus(ok, detail) { state = { ...state, connected: ok }; bar.setConn(ok, ok ? 'live' : detail); },
});
net.connect();

/** What a registry surface is bound to right now: the stream its own entry picks, and the frame it would draw.
 *  Exposed so an end-to-end test can assert the billboard through the registry instead of guessing its stream. */
function debugSurfaces(): Record<string, { streamKind: string; streamId: string; lastFrame: string | null; image: string | null }> {
  return Object.fromEntries(Object.values(SURFACES).map((d) => {
    const id = d.streamId(state);
    return [d.kind, { streamKind: d.streamKind, streamId: id, lastFrame: state.surfaces[id]?.lastFrame ?? null, image: frames[id] ?? null }];
  }));
}

(window as unknown as { __cubicle: unknown }).__cubicle = {
  get state() { return state; },
  agents: () => scene.debugAgents(), anchors: () => scene.debugAnchors(), desks: () => scene.debugDesks(), stand: (name: string) => scene.debugStand(name), surfaces: () => debugSurfaces(), open,
  zoom: (z: number) => scene.cameras.main.setZoom(z), center: (tx: number, ty: number) => scene.cameras.main.centerOn(tx * TILE, ty * TILE),
  floor: (n: number) => scene.focusFloor(n), currentFloor: () => scene.currentFloor(), elevator: () => scene.elevator.state(), route: (role: string, target: string) => scene.debugRoute(role, target),
  theme: (mode: 'dark' | 'light' | 'system') => applyTheme(mode),
  stack: () => panel.stack.entries(),
  // Visual-check hooks (screenshot script, spec F35): freeze the clock and read the loop's frame rate.
  setHour: (h: number | null) => { hourOverride = h; scene.setHourOverride(h); },   // the time bar icon follows the office tint
  fps: () => Math.round(game.loop.actualFps),
  // A pushed frame can belong to a stream the daemon never announced (the screenshot script injects one), and a frame
  // with no surface behind it has nothing bound to draw it. Register the surface first, then let the frame land.
  pushFrame: (id: string, dataUrl: string) => { if (!state.surfaces[id]) { state = applyEvent(state, { ts: new Date().toISOString(), type: 'browser.session_started', agent: null, job: null, payload: { session: id } }); refresh(); } onFrameData(id, dataUrl); },
};

let last = performance.now();
let lastLayout = 0;
function loop(now: number): void {
  const dt = now - last; last = now;
  // The minimap camera moves with the window; the rail's lobby tab follows a drag inside F1, which fires no floor change.
  if (now - lastLayout > 500) { lastLayout = now; minimap.layout(); rail.update(); }
  time.tick(dt, new Date(), hourOverride);
  if (state.mode === 'live') state = tick(state, Date.now());
  // doors and digits follow the engine every frame; `toViewState` writes into one reused object so the loop
  // allocates nothing per frame (its riders array is already reference-cached inside elevator-view.ts)
  if (elevatorView && scene.scene.isActive()) elevatorView.setState(toViewState(scene.elevator.state(), TILE, elevatorViewState));
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
