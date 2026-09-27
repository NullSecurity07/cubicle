import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { isHeaded, type Stage } from '../shared/model.ts';
import { createApprovals } from './approvals.ts';
import { boardAttention, createAttention, damageAttention, doneAttention, keyAttention } from './attention.ts';
import { createBoards } from './boards.ts';
import { createBrowser, dnsResolve, fakeHand, fakeRunner, jinaReader, realRunner } from './browser.ts';
import { createChat } from './chat.ts';
import { createCurator } from './curator.ts';
import { createDecisions, decisionAttention } from './decisions.ts';
import { createEvents } from './events.ts';
import { createFounder } from './founder.ts';
import { gatherPieces } from './gather.ts';
import { guard } from './guard.ts';
import { createGuards } from './guards.ts';
import { body, json, type Route } from './http.ts';
import { installSlices, lateRuns, loadSlices } from './install.ts';
import { tidyLapsed } from './lapsed.ts';
import { createMail, fakeMailHttp } from './mail.ts';
import { createMemory } from './memory.ts';
import { createPlaybook } from './playbook.ts';
import { complete, fakeClient, findLocal, promptSize, realClients } from './providers.ts';
import { archiveCopy, redditFeed, stackExchange } from './readers.ts';
import { createRecall, localEmbedder, wordEmbedder } from './recall.ts';
import { createLearner, type Turn } from './reflect.ts';
import { createRoomFeed } from './rooms-feed.ts';
import { route } from './router.ts';
import { boardRoutes } from './routes/boards.ts';
import { browserRoutes } from './routes/browsers.ts';
import { fileRoutes } from './routes/files.ts';
import { roomRoutes } from './routes/rooms.ts';
import { stageRoutes } from './routes/stage.ts';
import { studioRoutes } from './routes/studios.ts';
import { workRoutes } from './routes/work.ts';
import { createRuns, desktopNotify } from './runs.ts';
import { createSeams } from './seams.ts';
import { createSkills } from './skills.ts';
import { createSources, sourceAttention } from './sources.ts';
import { guardProcess } from './restart.ts';
import { readStatic } from './static.ts';
import { backupDirOf } from './openends/backup.ts';
import { createStore, type Damage } from './store.ts';
import { decisionTools } from './tools/decisions.ts';
import { docTools } from './tools/docs.ts';
import { fileTools } from './tools/files.ts';
import { founderTools } from './tools/founder.ts';
import { mediaTools } from './tools/media.ts';
import { outwardTools } from './tools/outward.ts';
import { recallTools } from './tools/recall.ts';
import { memoryTools } from './tools/remember.ts';
import { skillTools } from './tools/skills.ts';
import { sourceTools } from './tools/sources.ts';
import { taskTools } from './tools/tasks.ts';
import { teamTools } from './tools/team.ts';
import { webTools } from './tools/web.ts';
import { createTrace } from './trace.ts';
import { createPromptFor } from './turn-prompt.ts';
import { createUsage } from './usage.ts';
import { wireStudios } from './wiring/studios.ts';

// First of all: a promise nobody caught is written down and the app goes on; a throw nobody caught ends it with a
// failure, which dev.mjs starts again.
guardProcess();
const root = resolve(import.meta.dirname, '../..');
try { process.loadEnvFile(resolve(root, '.env')); } catch { /* no .env: only the fake model will work */ }

const port = Number(process.env.STAGE_API_PORT ?? 7421);
const fake = process.env.STAGE_FAKE_MODEL === '1';
// Who may use the api: the app's own page (here, or on Vite's port in development) and scripts that hold this launch's token.
const own = { ports: [port, Number(process.env.STAGE_PORT ?? 7420)], token: process.env.STAGE_API_TOKEN || randomBytes(24).toString('base64url') };
// The people answer from the hosted free models in the configured order, and from a model on this machine, if one
// known to work is here, when those have no room left.
const clients = fake ? [fakeClient] : realClients(process.env, await findLocal());
const busy = new Set<string>();
const workspace = process.env.STAGE_WORKSPACE ?? resolve(root, 'workspace');
// Every open window hears what every other writer did, through the store: a message written anywhere at all reaches
// the canvas, whether the founder typed it here, sent it from their phone or a colleague put it there.
const roomFeed = createRoomFeed();
// The events feed is made further down, once everything it listens to is; until then a saved stage has nobody to tell.
let restage: (stage: Stage) => void = () => {};
// A file that could not be read is put back from the newest backup that holds it; the founder hears of it in Needs
// you, which is made further down too, so what is found before then waits for it.
const damaged: Damage[] = [];
let tellDamage = (damage: Damage) => { damaged.push(damage); };
const store = createStore(workspace, (roomId) => roomFeed.tell({ roomId, chat: 'changed' }), (stage) => restage(stage), {
  backups: () => backupDirOf({ fake, workspace, root }),
  onDamaged: (damage) => tellDamage(damage),
});
const usage = createUsage(resolve(workspace, 'usage.json'));
await usage.load();
const browser = fake ? createBrowser(fakeRunner, undefined, undefined, fakeHand) : createBrowser(realRunner(), { direct: [redditFeed(), stackExchange()], fallback: process.env.STAGE_NO_READER === '1' ? [] : [jinaReader, archiveCopy()] }, dnsResolve);
const approvals = createApprovals();
// Summaries go to a model with room to spare: the last configured providers are the large free ones.
const memory = createMemory(store, async (messages) => {
  const { order } = route([...clients].reverse(), usage, { promptChars: promptSize(messages), tools: false, kind: 'side' });
  const reply = await complete(messages, { onToken: () => {} }, order);
  usage.record(reply.client.name, reply.usage, reply.quota, 'side');
  return reply.text;
});
const boards = createBoards(workspace);
// One list of everything that waits for the founder; boards report into it, approvals are held in it while they wait.
const attention = createAttention(workspace);
// A key the provider refuses is said once in Needs you, and goes from there when that key answers again.
keyAttention(usage, attention);
tellDamage = (damage) => { console.log(`${damage.file} could not be read; the damaged copy is ${damage.aside}`); void attention.raise(damageAttention(damage)).catch(() => {}); };
for (const damage of damaged.splice(0)) tellDamage(damage);
attention.source(boardAttention(store, boards));
boards.onChange(() => { void attention.refresh(); });
// The studio cards: one job per card, the files in the shared files folder, the rest beside the stage.
const { media, filmPictures, local } = wireStudios({ root, workspace, fake, store, browser, clients, usage });
const decisions = createDecisions(workspace);
attention.source(decisionAttention(decisions));
decisions.onChange(() => { void attention.refresh(); });
// A proposal already answered elsewhere (its tasks on a board, the bet taken, the decision on record) leaves the list.
attention.settle(doneAttention({ workspace, store, boards, decisions }));
// Websites people proposed as sources, each waiting for the founder in Needs you.
const sources = createSources(workspace);
attention.source(sourceAttention(sources, () => store.loadStage()));
sources.onChange(() => { void attention.refresh(); });
// The one playbook everybody shares, and the one page everybody has read about the founder.
const skills = createSkills(workspace);
const founder = createFounder(workspace);
// The one live connection a window holds: every feed below still answers on its own address for scripts and checks,
// but the page hears all of them through this.
const events = createEvents({ attention, skills, rooms: roomFeed, media, boards, stage: () => store.loadStage() });
restage = (stage) => events.restage(stage);
// Search by meaning over everything the workspace holds. The model runs inside this process; its file is fetched once.
const recall = createRecall({ dir: workspace, embed: fake ? wordEmbedder : localEmbedder(resolve(root, 'app/.cache/recall')), gather: gatherPieces(store, decisions, (roomId) => memory.read(roomId), skills) });
// Bring the saved vectors up to date shortly after start, so the first search does not wait for it.
setTimeout(() => { void recall.warm().catch(() => {}); }, 4000).unref();
// A review date falls due without anything else changing: look once an hour.
setInterval(() => { void attention.refresh(); }, 3_600_000).unref();

// What one person's turn is built from: their readable docs, their own history, and the recent talk of wired colleagues.
const promptFor = createPromptFor({ store, browser, media, decisions, memory, founder });

// Where everything that watches or shapes a turn plugs in: the trace, which writes down what a turn cost once it is
// over, the guard that will not let a person run the same call twice, the playbook block on the way in and the
// learner on the way out. A handler that breaks is written down here and skipped; nothing in it can cost a turn.
const seams = createSeams((name, error) => console.error(`seam ${name}: ${error.message}`));
const trace = createTrace(workspace);
seams.on('turn:after', trace.handler);
// An approval left over from a turn the app closed on goes by itself once this room has moved past it.
seams.on('turn:after', tidyLapsed(attention));
const guards = createGuards();
seams.on('turn:before', guards.reset);
seams.on('tool:before', guards.before);
seams.on('tool:after', guards.after);
seams.on('turn:before', createPlaybook({ skills, recall, tools: () => tools.map((tool) => tool.name) }).before);
// The founder talking to one person, and one person asking another. A turn's tools are asked for only when it starts.
const { chat, consult } = createChat({ store, roomFeed, busy, clients, usage, seams, attention, approvals, memory, promptFor, toolsFor: (stage, roomId) => toolsFor(stage, roomId) });
const tools = [...docTools, ...fileTools, ...webTools(browser, (id, card) => ({ profile: store.browserProfile(id), headed: isHeaded(card), ...(!fake && card?.kind === 'browser' && card.app ? { pace: [1500, 3000] as [number, number] } : {}) })), ...outwardTools(fake ? createMail({ AGENTMAIL_API_KEY: 'fake' }, fakeMailHttp) : createMail(), store.filesDir), ...teamTools(consult), ...taskTools(boards), ...decisionTools(decisions), ...sourceTools(browser, sources), ...memoryTools(memory), ...recallTools(recall), ...mediaTools(media, () => !local.ready()), ...skillTools(skills), ...founderTools(founder)];
// Anything dropped into `server/slices` is installed here, so a new feature is new files rather than one more edit to
// this one. They are handed a `runs` that is not built yet: the runner is made from the final tool list, and that
// list is only final once every slice has added its own, so `late.runs` stands in and is filled the moment it exists.
const late = lateRuns();
const extras = await installSlices(await loadSlices(resolve(import.meta.dirname, 'slices')), {
  workspace, root, fake, store, seams, clients, usage, approvals, attention, boards, recall, skills, founder, memory, decisions, busy,
  notify: fake ? () => {} : desktopNotify, promptFor, json, body, own, runs: late.runs,
  toolsFor: (stage, roomId) => toolsFor(stage, roomId),
});
tools.push(...extras.tools);
// The one place a turn's tools come from: everything installed, narrowed by whichever slices want a say.
const toolsFor = (stage: Stage, roomId: string) => extras.offer(tools, stage, roomId);
const runs = createRuns({ boards, store, tools, toolsFor, clients, usage, approvals, attention, promptFor, busy, seams, notify: fake ? () => {} : desktopNotify });
late.fill(runs);
// A birth or a patch says so once, where the founder was already looking: in the run's log, or on the playbook's feed.
const learner = createLearner({
  skills, recall, store, clients, usage,
  roomName: async (roomId) => (await store.loadStage()).rooms.find((one) => one.id === roomId)?.name ?? 'Someone',
  // Everything here that the founder gave a name to. A lesson that uses one of them is about this company only, so
  // the learner is told to write it again without.
  names: async () => {
    const stage = await store.loadStage();
    return [...stage.rooms.map((one) => one.name), ...stage.docs.map((one) => one.title), ...(stage.cards ?? []).flatMap((card) => (card.kind === 'link' && card.title ? [card.title] : []))];
  },
  onLearned: (learned) => {
    skills.tell({ learned: { roomId: learned.roomId, name: learned.name, action: learned.action } });
    if (learned.source === 'run') void runs.note(learned.roomId, `${learned.action === 'create' ? 'learned' : 'improved'}: "${learned.name}"`).catch(() => {});
  },
});
seams.on('turn:after', learner.after);
const curator = createCurator(skills);
setInterval(() => { void runs.tick().catch(() => {}); void curator.tick().catch(() => {}); void extras.tick(); }, 30_000).unref();

// Started by the desktop shell: leave when the shell does, even if it was killed.
if (process.env.STAGE_EXIT_WITH_PARENT === '1') {
  process.stdin.resume();
  process.stdin.on('end', () => { void extras.close().finally(() => process.exit(0)); });
}

// "Learn this": the founder asking for the reflection a turn can also set off by itself, on work already finished.
const learn = async (turn: Turn) => {
  const learned = await learner.learn(turn, 'taught');
  return { learned: learned ? { name: learned.name, action: learned.action } : null };
};

// Every path the app answers itself, in the order they are tried. Studios come after the boards and before the
// browsers as they always have; inside each, the fixed paths come before the ones that take a name.
const routes: Route[] = [
  stageRoutes({ store, events, browser, attention, approvals }),
  workRoutes({ store, workspace, busy, learn, roomFeed, boards, decisions, recall, trace, skills, founder, attention, sources }),
  boardRoutes({ store, boards, runs, learn }),
  studioRoutes({ store, media, filmPictures }),
  browserRoutes({ store, browser }),
  roomRoutes({ store, busy, usage, clients, memory, chat }),
  fileRoutes({ store }),
];

createServer(async (req, res) => {
  try {
    // Parsed once, here: every route is handed the path and the whole address.
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    // First of all: nobody without the right to use the api reaches any of it.
    const refused = guard({ path, method: req.method ?? 'GET', headers: req.headers }, own);
    if (refused) return json(res, 403, { error: refused });
    for (const answered of routes) if (await answered(req, res, path, url)) return;
    // Last before the 404: the built-in paths above are the app's own, and a slice answers what is left of them.
    if (await extras.route(req, res, path)) return;
    if (path.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    const file = req.method === 'GET' ? await readStatic(resolve(import.meta.dirname, '../dist'), path) : null;
    if (!file) return json(res, 404, { error: 'not found — run `pnpm build` so the server has a client to serve' });
    res.writeHead(200, { 'content-type': file.type });
    res.end(file.body);
  } catch (error) {
    if (!res.headersSent) json(res, 500, { error: (error as Error).message });
    else res.end();
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`stage api on http://127.0.0.1:${port} — models: ${clients.map((client) => client.name).join(', ') || 'NONE (no keys found)'}`);
});
