import './ui/tokens.css';
import './ui/app.css';
import { CampusView } from './world/view.js';
import { Net, resolveWs } from './net.js';
import { applyConversation, decideAcked, decideFailed, decideSent, emptyState, applyEvent, applySnapshot, tick, withFrameSeq, type State, type CubicleEvent, type Snapshot, type ThreadTurn } from './state.js';
import { Panel, SURPRISE_ME, type Origin } from './ui/panel.js';
import { TopBar } from './ui/bar.js';
import { applyTheme, currentTheme, themeFromQuery, THEMES } from './ui/tokens.js';
import { emptyUi, vaultPathOf, type Ctx } from './ui/content.js';
import { COMMENT_REQUIRED, commentRequired, decidableOf, decideStateFor, decisionKey } from './ui/decisions.js';
import { MESSAGES, roomThread } from './ui/messages.js';
import { viewFor, SURFACES } from './ui/surfaces.js';
import { TimeControls } from './ui/time.js';
import { withMotion, reducedMotion } from './world/motion.js';
import { announce, announcementFor, coachMark, toast } from './ui/notify.js';
import { FirstRun } from './ui/firstrun.js';
import { QuickOpen, quickItems } from './ui/quickopen.js';
import { bindKeys, keysView } from './ui/keys.js';
import { Rail } from './ui/rail.js';
import { MinimapChrome, minimapWanted } from './ui/minimap.js';
import { fitZoom } from './world/camera.js';
import { minimapToGrid } from './world/minimap-draw.js';
import { slabOf } from './world/paint.js';

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
const ui = emptyUi();
const ctx: Ctx = { frames, tokenQuery: token ? `?token=${encodeURIComponent(token)}` : '', vaultName, fps, ui };

// The office owns one canvas inside #game, and every pointer listener is on that canvas rather than on the window.
// Click isolation is then structural (see scripts/test-overlay-clicks.ts): a press on the bar, the rail, a sheet,
// the scrim, the time bar, the minimap, a toast or a card is a press on an HTML element, and the canvas under it
// never hears about it at all.
const scene = new CampusView(document.getElementById('game')!);
void THEMES; void currentTheme;
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

function viewOf(kind: string): ReturnType<typeof viewFor> {
  if (kind === 'keys') return keysView();              // the shortcut sheet is the one kind with no data behind it
  return viewFor(kind, state, ctx);
}
const panel = new Panel({ viewOf, onOpen: (kind) => open(kind), onLocate: (target) => scene.focusOn(target), onEmpty: () => scene.restoreZoom(), onChat: (text) => sendChat(text), onAction: (act, o) => onAction(act, o), onVaultLink: (url) => openVaultLink(url) });
// Built, not shown. The first-run card is the other first-contact message; the mark waits until the first snapshot
// says the card is not coming, or until the card has gone (ui/firstrun.ts `onDismissed`).
const coach = coachMark('Drag to pan, scroll to zoom, click anything in the office. Press ? for shortcuts.');

scene.hooks = {
  getState: () => state,
  frames: () => frames,
  hour: () => time.hour(new Date()),
  clock: () => (state.mode === 'replay' ? replayClockAt(time.index) : Date.now()),
  onSurfaceClick(kind) { open(kind, lastPress ?? undefined); },
  onAgentClick(role) { open(role === 'ceo' ? 'cabin' : `agent:${role}`, lastPress ?? undefined); },   // the CEO is the owner's channel
};
void scene.start().then(() => { rail.update(); minimap.layout(); }).catch((err) => { console.error('[office] the map did not load', err); toast('The office map did not load.'); });

// ---- zone rail and minimap chrome ------------------------------------------------------------------------------
// The rail reads the renderer every refresh (cheap: it morphs). The minimap is an HTML frame around a canvas the
// renderer draws the campus thumbnail into.
const rail = new Rail({
  summary: () => scene.zoneSummary(),
  currentZone: () => scene.currentZone(),
  divisions: () => {
    const d: Record<string, string[]> = {};
    for (const t of state.teams) if (t.room && !t.parent) (d[zoneOfRoom(t.room)] ??= []).push(t.name);
    return d;
  },
  onZone: (id) => scene.focusZone(id),
});
/** Which rail zone a team's room belongs to, so the Org's divisions land on the tab that holds them. */
function zoneOfRoom(room: string): string {
  const z = scene.map?.rooms[room]?.zone;
  return z === 'ceo_office' || z === 'meetingroom' ? 'boardroom' : z ?? room;
}
const minimap = new MinimapChrome({
  attach: (canvas) => scene.attachMinimap(canvas),
  onPan: (px, py, w, h) => { const c = minimapToGrid(px, py, scene.map, w, h); scene.camera.panTo(c); },
  onToggle: () => undefined,
});
scene.hooks.onZoneChange = () => rail.update();
window.addEventListener('resize', () => minimap.layout());
// ---------------------------------------------------------------------------------------------------------------

/**
 * The single entry for opening anything: a surface, a room, `agent:<role>`, `job:<id>`, `org`. Pushes onto the
 * stack and focuses the camera. Only a user's own click zooms (`zoom: false` for anything the app opens by itself).
 */
function open(kind: string, origin?: Origin, opts: { zoom?: boolean } = {}): void {
  if (kind === 'ceo_office') kind = 'cabin';           // the CEO office is the owner's channel
  const zoom = opts.zoom ?? true;
  // Messages opens on a thread: the room's own transcript when a room was clicked, else the newest conversation.
  // The fetch is the op — the index carries only the last line — and `viewFor` stays pure.
  if (kind === MESSAGES || roomThread(state, kind)) {
    const want = (kind === MESSAGES ? null : roomThread(state, kind)?.id ?? null) ?? ui.thread ?? state.conversations[0]?.id ?? null;
    if (want && want !== ui.thread) ui.thread = want;
    if (ui.thread) net.conversation(ui.thread);
  }
  panel.show(kind, viewOf(kind), origin ?? undefined);
  if (kind.startsWith('agent:')) scene.focusOn(kind, { zoom });
  else if (!kind.includes(':') && kind !== 'org' && kind !== 'keys' && kind !== MESSAGES) scene.focusOn(kind, { zoom });
}

/** The comment the owner has typed under a decision, if the reader is open. */
const commentNow = (): string => document.querySelector<HTMLInputElement>('#panel-body input[data-key="comment"]')?.value.trim() ?? '';

/**
 * The owner's yes or no (SP8 §1). The op is sent, the reader says "Decided · applying…" until `decide.ack` and then
 * until the dispatcher's `proposal.resolved`, and a refusal — an error reply, a socket that is down, a send back
 * with nothing said — is shown in the bar rather than swallowed.
 */
function decide(id: string, approved: boolean, comment: string): void {
  const note = state.inbox.find((n) => n.id === id);
  if (!note) return;
  const status = decideStateFor(note, state.decisions[id])?.status;
  if (status === 'sending' || status === 'applying') return;
  const d = decidableOf(note);
  const chosen = d === 'choose' ? ui.choice[id] : undefined;
  if (d === 'choose' && approved && !chosen) return;
  if (commentRequired(d, approved) && !comment) { state = decideFailed(state, id, COMMENT_REQUIRED); refresh(); return; }
  state = decideSent(state, id, { approved, chosen });
  refresh();
  // `confirm` only on the yes, and only on a row the daemon marked (SP9 ruling W3-3): the button the owner pressed
  // said "Adopt anyway", so the flag is what that button means. Sending it back never needs it — agreeing with the
  // board is not overruling it — and the daemon decides whether the note needed one, not this.
  const confirm = approved && !!note.needs_confirm;
  if (!net.decide(id, { approved, chosen, comment, confirm })) { state = decideFailed(state, id, 'The daemon is not connected, so nothing was decided.'); refresh(); }
}

/** A control inside the open view was used (ui/panel.ts routes every `data-act` here). */
function onAction(act: string, o: { comment: string; text: string }): void {
  const cur = panel.current ?? '';
  if (act.startsWith('search:')) { ui.search = act.slice(7); refresh(); return; }
  if (act.startsWith('thread:')) { const id = act.slice(7); ui.thread = id; net.conversation(id); refresh(); return; }
  if (act === 'send') { if (o.text) { sendChat(o.text); panel.clearComposer(); } return; }
  if (!cur.startsWith('decision:')) return;
  const id = cur.slice('decision:'.length);
  if (act.startsWith('choose:')) { ui.choice[id] = Number(act.slice(7)); refresh(); return; }
  if (act === 'decide:yes' || act === 'decide:no') decide(id, act === 'decide:yes', o.comment);
}

/**
 * An `obsidian:` link, which the office window must never navigate to (SP8 ruling P8-4): the Tauri shell opens it
 * where there is one, and otherwise the note's path goes to the clipboard so the owner can find it themselves.
 */
function openVaultLink(url: string): void {
  const shell = (window as unknown as { __cubicle?: { openExternal?: (u: string) => void } }).__cubicle;
  if (typeof shell?.openExternal === 'function') { shell.openExternal(url); return; }
  const path = vaultPathOf(url) || url;
  void navigator.clipboard?.writeText(path)
    .then(() => toast(`Copied the note's path — open it in Obsidian`))
    .catch(() => toast(`The note is at ${path}`));
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

/** `M` goes to the chrome above, which owns the frame and the canvas the thumbnail is drawn into. */
const minimapHook: { toggle(): void } = { toggle: () => minimap.toggle() };
/** `1`-`7` are the rail's own order, read from the rail so the two can never disagree. */
const zoneKey = (n: number) => (): void => { const id = rail.order()[n - 1]; if (id) scene.focusZone(id); };

bindKeys({
  zone1: zoneKey(1), zone2: zoneKey(2), zone3: zoneKey(3), zone4: zoneKey(4), zone5: zoneKey(5), zone6: zoneKey(6), zone7: zoneKey(7),
  // `0` frames the whole campus, which is what the rail's Campus tab does — one implementation, in the renderer.
  lobby: () => scene.focusZone('lobby'), fit: () => scene.focusZone('campus'),
  talk: () => open('cabin'), messages: () => open(MESSAGES), queue: () => open('noticeboard'), brief: () => open('newsstand'), plan: () => open('whiteboard'), org: () => open('org'),
  pause: () => time.togglePlay(), prev: () => time.step(-1), next: () => time.step(1),
  minimap: () => minimapHook.toggle(), help: () => open('keys'), quickopen: () => quick.open(),
// The two aria-modal cards own the keyboard while they are up: one Tab out of their text field used to leave `T`
// opening the cabin sheet underneath and `1`-`7` flying the camera behind them.
// A decision reader owns the keyboard too: `1`-`7` would otherwise fly the camera while the owner is picking
// between numbered options, and `A`/`R` are the two buttons in front of them.
}, () => firstRun.visible || quick.visible || (panel.current?.startsWith('decision:') ?? false));

// `A` approve/adopt, `R` reject/send back, `1`-`9` pick an option — only while a decision is open, never while the
// owner is typing a comment (ui/decisions.ts owns the table; this is the binding).
window.addEventListener('keydown', (e) => {
  const cur = panel.current ?? '';
  if (!cur.startsWith('decision:') || firstRun.visible || quick.visible) return;
  const id = cur.slice('decision:'.length);
  const note = state.inbox.find((n) => n.id === id);
  if (!note) return;
  const el = e.target as HTMLElement | null;
  const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  const hit = decisionKey(e, { decidable: decidableOf(note), options: note.options?.length ?? 0 }, typing);
  if (!hit) return;
  e.preventDefault();
  if (hit.act === 'choose') { ui.choice[id] = hit.n; refresh(); return; }
  decide(id, hit.act === 'yes', commentNow());
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
    // Snapshots keep arriving while the card is up, and `firstRun` stays true until the company has a name: the
    // hint may only take its turn once the card is off the screen (or was never coming).
    else if (!firstRun.visible) coach.show();
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
    if (liveState) replayBase = { ...replayBase, agents: Object.fromEntries(Object.entries(liveState.agents).map(([k, v]) => [k, { ...v, state: 'idle_at_desk' as const, job: null, tool: null, bubble: null, target: null, badge: null, checking: null }])), plan: liveState.plan, latestRun: liveState.latestRun, quota: liveState.quota, brand: liveState.brand };
    replayCheckpoints = []; replayState = null; replayCursor = 0;
    time.setReplay(replayBuffer);
    rebuildReplayTo(0);
    bar.setConn(true, `replay · ${replayBuffer.length} events`);
  },
  onDecideAck(id) { state = decideAcked(state, id); refresh(); },
  onConversation(id, turns) { state = applyConversation(state, id, turns as ThreadTurn[]); refresh(); },
  // An error the daemon ties to a decision belongs in that reader's own state line; anything else is a toast.
  onError(message, id) {
    const pending = id ?? Object.keys(state.decisions).find((k) => state.decisions[k].status === 'sending' || state.decisions[k].status === 'applying') ?? null;
    if (pending && state.decisions[pending]) { state = decideFailed(state, pending, message); refresh(); return; }
    toast(message);
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

// Whatever the shell put here first is kept: Tauri injects `openExternal` on this same object before the module
// runs, and a bare assignment would throw away the one hook that keeps `obsidian:` links out of the office window.
// Spread, not `Object.assign` onto it: `state` is a getter, and assigning would copy today's value and freeze it.
const shellHooks = (window as unknown as { __cubicle?: Record<string, unknown> }).__cubicle ?? {};
(window as unknown as { __cubicle: unknown }).__cubicle = {
  ...shellHooks,
  get state() { return state; },
  agents: () => scene.debugAgents(), anchors: () => scene.debugAnchors(), desks: () => scene.debugDesks(), stand: (name: string) => scene.debugStand(name), surfaces: () => debugSurfaces(), open,
  // The camera, as the console and the harnesses drive it. Both set it outright rather than easing, and both hand
  // back where it ended up, so a test can assert the frame it is about to photograph instead of guessing at it.
  zoom: (z: number) => scene.setZoom(z),
  center: (x: number, y: number) => scene.centerOn(x, y),
  zone: (id?: string) => (id ? (scene.focusZone(id), scene.currentZone()) : scene.currentZone()),
  zones: () => scene.zoneSummary().map((z) => z.id),
  project: (x: number, y: number, z?: number) => scene.project(x, y, z),
  screenBox: (kind: string) => scene.screenBox(kind),
  // The overlay gate's three: what the office would hit at a point, whether a drag is live, and whether the camera
  // has stopped. None of them changes anything — they are how a harness reads the office without clicking it.
  hitAt: (x: number, y: number) => scene.hitAt(x, y),
  toGrid: (x: number, y: number) => scene.toGrid(x, y),
  dragging: () => scene.isDragging(),
  coffee: (on: boolean) => scene.setCoffee(on),
  settled: () => scene.isSettled(),
  route: (role: string, target: string) => scene.debugRoute(role, target),
  theme: (mode: 'dark' | 'light' | 'system') => applyTheme(mode),
  stack: () => panel.stack.entries(),
  // Visual-check hooks (screenshot script, spec F35): freeze the clock and read the loop's frame rate.
  setHour: (h: number | null) => { hourOverride = h; scene.setHourOverride(h); },   // the time bar icon follows the office tint
  fps: () => Math.round(scene.fps()),
  profile: () => scene.profile(),
  // A pushed frame can belong to a stream the daemon never announced (the screenshot script injects one), and a frame
  // with no surface behind it has nothing bound to draw it. Register the surface first, then let the frame land.
  pushFrame: (id: string, dataUrl: string) => { if (!state.surfaces[id]) { state = applyEvent(state, { ts: new Date().toISOString(), type: 'browser.session_started', agent: null, job: null, payload: { session: id } }); refresh(); } onFrameData(id, dataUrl); },
  /** What the sheet has picked (the open thread, the search, a chosen option) — read and driven by the click test. */
  ui: () => ui,
};

let last = performance.now();
let lastLayout = 0;
function loop(now: number): void {
  const dt = now - last; last = now;
  // The rail's dots follow a drag inside one zone, which fires no zone change.
  if (now - lastLayout > 500) {
    lastLayout = now;
    // The strip belongs close in and nowhere else: at the campus overview the main view *is* the minimap, with a
    // viewport rectangle drawn over all of it, which says nothing.
    if (scene.map) minimap.setVisible(minimapWanted(scene.camera.zoom, fitZoom(slabOf(scene.map), window.innerWidth, window.innerHeight, 3.4)), true);
    minimap.layout();
    rail.update();
  }
  time.tick(dt, new Date(), hourOverride);
  if (state.mode === 'live') state = tick(state, Date.now());
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
