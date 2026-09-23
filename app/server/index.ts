import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { signedIn } from '../shared/apps.ts';
import { MEDIA_KINDS, isHeaded, newMessageId, newTurnId, studioBehind, type Attachment, type ChatEvent, type ChatVia, type MediaKind, type Stage } from '../shared/model.ts';
import { createApprovals } from './approvals.ts';
import { boardAttention, createAttention } from './attention.ts';
import { createBoards } from './boards.ts';
import { createCurator } from './curator.ts';
import { createDecisions, decidedLines, decisionAttention } from './decisions.ts';
import { createEvents } from './events.ts';
import { createFounder } from './founder.ts';
import { fakeCoder, opencodeCoder } from './coder.ts';
import { guard } from './guard.ts';
import { createGuards } from './guards.ts';
import { installSlices, lateRuns, loadSlices } from './install.ts';
import { tidyLapsed } from './lapsed.ts';
import { createBrowser, dnsResolve, fakeRunner, jinaReader, realRunner } from './browser.ts';
import { archiveCopy, redditFeed, stackExchange } from './readers.ts';
import { runTurn } from './loop.ts';
import { createMail, fakeMailHttp } from './mail.ts';
import { firstClips, orderedClips } from './media/clips.ts';
import { fakeLocalClips, localClips, MINUTES_EACH } from './media/local-clips.ts';
import { createClips, fakeClips } from './media/spaces.ts';
import { probe } from './media/ff.ts';
import { thumbOf } from './media/footage.ts';
import { fakeImages, firstOf, imageMakers, spentFile } from './media/image.ts';
import { lettered } from './media/lettering.ts';
import { createMedia } from './media/jobs.ts';
import { createMusic, fakeMusic } from './media/music.ts';
import { fakeVideos, hyperframesVideos } from './media/video.ts';
import { createSight, sightDir } from './media/sight.ts';
import { pexels } from './media/stock.ts';
import { byGrade, fakeVoices, voiceMakers, VOICES } from './media/voice.ts';
import { createMemory } from './memory.ts';
import { missionsOf } from './missions.ts';
import { createPlaybook } from './playbook.ts';
import { createLearner, type Turn } from './reflect.ts';
import { createSkills } from './skills.ts';
import { TEXT_FILE, gatherPieces } from './gather.ts';
import { createRecall, localEmbedder, wordEmbedder } from './recall.ts';
import { recallTools } from './tools/recall.ts';
import { recent } from './memory.ts';
import { buildMessages, colleagueIds, readableDocIds, wired, type Attached } from './prompt.ts';
import { complete, fakeClient, promptSize, realClients } from './providers.ts';
import { route } from './router.ts';
import { createRoomFeed } from './rooms-feed.ts';
import { createRuns, desktopNotify } from './runs.ts';
import { createSeams } from './seams.ts';
import { rangeOf, readStatic } from './static.ts';
import { createStore } from './store.ts';
import { threadsOf } from './threads.ts';
import { createTrace } from './trace.ts';
import { decisionTools } from './tools/decisions.ts';
import { docTools } from './tools/docs.ts';
import { fileTools } from './tools/files.ts';
import { mediaTools } from './tools/media.ts';
import { outwardTools } from './tools/outward.ts';
import { projectTools } from './tools/project.ts';
import { founderTools } from './tools/founder.ts';
import { memoryTools } from './tools/remember.ts';
import { skillTools } from './tools/skills.ts';
import { taskTools } from './tools/tasks.ts';
import { teamTools, type Consult } from './tools/team.ts';
import { browserSession, webTools } from './tools/web.ts';
import { createUsage } from './usage.ts';

const root = resolve(import.meta.dirname, '../..');
try { process.loadEnvFile(resolve(root, '.env')); } catch { /* no .env: only the fake model will work */ }

const port = Number(process.env.STAGE_API_PORT ?? 7421);
const fake = process.env.STAGE_FAKE_MODEL === '1';
// Who may use the api: the app's own page (here, or on Vite's port in development) and scripts that hold this launch's token.
const own = { ports: [port, Number(process.env.STAGE_PORT ?? 7420)], token: process.env.STAGE_API_TOKEN || randomBytes(24).toString('base64url') };
const clients = fake ? [fakeClient] : realClients();
const busy = new Set<string>();
const workspace = process.env.STAGE_WORKSPACE ?? resolve(root, 'workspace');
// Every open window hears what every other writer did, through the store: a message written anywhere at all reaches
// the canvas, whether the founder typed it here, sent it from their phone or a colleague put it there.
const roomFeed = createRoomFeed();
const store = createStore(workspace, (roomId) => roomFeed.tell({ roomId, chat: 'changed' }));
const usage = createUsage(resolve(workspace, 'usage.json'));
await usage.load();
const browser = fake ? createBrowser(fakeRunner) : createBrowser(realRunner(), { direct: [redditFeed(), stackExchange()], fallback: process.env.STAGE_NO_READER === '1' ? [] : [jinaReader, archiveCopy()] }, dnsResolve);
const approvals = createApprovals();
// Summaries go to a model with room to spare: the last configured providers are the large free ones.
const memory = createMemory(store, async (messages) => {
  const { order } = route([...clients].reverse(), usage, { promptChars: promptSize(messages), tools: false });
  const reply = await complete(messages, { onToken: () => {} }, order);
  usage.record(reply.client.name, reply.usage, reply.quota);
  return reply.text;
});
const boards = createBoards(workspace);
// One list of everything that waits for the founder; boards report into it, approvals are held in it while they wait.
const attention = createAttention(workspace);
attention.source(boardAttention(store, boards));
boards.onChange(() => { void attention.refresh(); });
// The studio cards: one job per card, the files in the shared files folder, the rest beside the stage.
// A video is made out of the other two: it draws its stills with the picture makers and records its lines with the voice ones.
// Every way of drawing, wrapped so that none of them is ever asked for writing: a picture model cannot spell, so the
// picture comes out wordless and the real words are set over it afterwards in real type. This sits round the makers
// rather than round any one studio, so the stills a film draws are as free of gibberish lettering as the ones a
// person draws by hand. The video studio's own cache sits outside this, on the ask as it was written, and what it
// holds is therefore the wordless picture — so a film rendered twice still costs one picture.
const pictures = (fake ? [fakeImages] : imageMakers()).map(lettered);
// The film's own way of drawing: every maker as one, tried in order. It is named because the card asks it one
// thing before anything is made — whether the next picture is four seconds away or most of a minute.
const filmPictures = firstOf(pictures, fake ? undefined : spentFile(resolve(root, 'app/.cache/pictures-spent.json')));
const voices = fake ? [fakeVoices] : voiceMakers(resolve(root, 'app/.cache/voice'));
// Direction is the one place in the app where the *best* free model matters more than the roomiest: a storyboard is
// short, and what it needs is judgement. The configured order puts gpt-oss-120b first and the router moves anything
// out of quota to the back, so this asks the strongest model that can still answer today, then anything that can.
const storyboard = async (prompt: string) => {
  const messages = [{ role: 'user' as const, content: prompt }];
  const chars = promptSize(messages);
  const { order } = route(clients, usage, { promptChars: chars, tools: false });
  const roomy = [...clients].reverse().filter((client) => !order.includes(client) && client.maxPromptChars >= chars);
  const reply = await complete(messages, { onToken: () => {} }, [...order, ...roomy]);
  usage.record(reply.client.name, reply.usage, reply.quota);
  return reply.text;
};
// The bed under a film: a mood and a length in, a finished loop at −23 LUFS out, with its own beats and its own
// credit. The cache is on a real disk beside the voice model's, never a tmpfs.
const music = fake ? fakeMusic : createMusic({ cacheDir: resolve(root, 'app/.cache') });
// Moving pictures, two ways round: made here on this machine, slowly and without limit, or asked of the free Hugging
// Face Spaces, quickly and out of a daily quota. B-roll tries this machine first; a talking head can only be made
// out there. Either way a scene that cannot be made falls back in plain words.
const local = fake ? fakeLocalClips : localClips();
const online = fake ? fakeClips : createClips();
// B-roll is made here first, because it is unlimited and nobody is waiting on a particular face. Somebody speaking
// on camera is asked of the free Spaces and of nothing else: they are the only thing that can move a real mouth to
// a real recording, and a drawn person whose mouth does not match the words is the one thing this studio will not
// make. When they have nothing left the film is faceless and says so.
const clips = orderedClips({ broll: [local, online], presenter: [online] });
if (!fake) console.log('clips · here:', local.ready() ?? `ready (about ${MINUTES_EACH} minutes each)`, '· online:', online.ready() ?? 'ready');
const media = createMedia({
  dir: workspace,
  store,
  makers: {
    imagegen: pictures,
    voicegen: voices,
    videogen: fake ? [fakeVideos] : [hyperframesVideos({
      dir: workspace, images: filmPictures, voices: voices[0], think: storyboard, clips, local, lipsync: online, music,
      // Real photographs somebody took, when the founder has put a free Pexels key in .env. Without one the
      // studio draws every picture, which is what it did before and still does for anything nobody has photographed.
      stock: pexels(process.env, fetch, resolve(root, 'app/.cache/stock')),
      cacheDir: resolve(root, 'app/.cache'),
      // The studio's eyes: a drawn picture is looked at before it is used, and the long-form look's stills are cut
      // into planes by depth. Two small models, fetched once, run on the processor; nothing breaks without them.
      sight: createSight(sightDir(resolve(root, 'app/.cache'))),
      forbidden: [workspace, root],
      stage: () => store.loadStage(),
      // `media` is read inside these, never at the moment they are made, so the studio can ask the card that asked it.
      assets: (cardId) => media.assetsOf(cardId),
      // A wired image studio's own pictures, newest first: a wire is the founder saying "use these".
      pictures: async (cardId) => (await media.read(cardId)).results.map((one) => ({ path: one.path, prompt: one.prompt })),
      fileOf: (path) => store.pathOf(path),
      readDoc: (id) => store.readDoc(id),
      readFile: (path) => store.readFileBytes(path),
      browser: { shots: (raw, want, signal) => browser.shots(raw, want, signal), where: (session) => browser.where(session) },
    })],
  },
});
const decisions = createDecisions(workspace);
attention.source(decisionAttention(decisions));
decisions.onChange(() => { void attention.refresh(); });
// The one playbook everybody shares, and the one page everybody has read about the founder.
const skills = createSkills(workspace);
const founder = createFounder(workspace);
// The one live connection a window holds: every feed below still answers on its own address for scripts and checks,
// but the page hears all of them through this.
const events = createEvents({ attention, skills, rooms: roomFeed, media, boards, stage: () => store.loadStage() });
// Search by meaning over everything the workspace holds. The model runs inside this process; its file is fetched once.
const recall = createRecall({ dir: workspace, embed: fake ? wordEmbedder : localEmbedder(resolve(root, 'app/.cache/recall')), gather: gatherPieces(store, decisions, (roomId) => memory.read(roomId), skills) });
// Bring the saved vectors up to date shortly after start, so the first search does not wait for it.
setTimeout(() => { void recall.warm().catch(() => {}); }, 4000).unref();
// A review date falls due without anything else changing: look once an hour.
setInterval(() => { void attention.refresh(); }, 3_600_000).unref();

// What one person's turn is built from: their readable docs, their own history, and the recent talk of wired colleagues.
async function promptFor(stage: Stage, roomId: string, toolNames: string[], fresh = false) {
  const docs: Record<string, string> = {};
  for (const id of readableDocIds(stage, roomId)) docs[id] = await store.readDoc(id);
  const colleagues: Record<string, Awaited<ReturnType<typeof store.readChat>>> = {};
  for (const id of colleagueIds(stage, roomId)) colleagues[id] = await store.readChat(id);
  // A board task starts from a clean slate: the person, their documents and colleagues, not their chat.
  // Link cards wired to this person: the page text, read once and kept until the address changes.
  const pages: Record<string, { title: string; text: string }> = {};
  const mine = new Set(wired(stage, roomId, (stage.cards ?? []).map((card) => card.id)));
  for (const card of stage.cards ?? []) {
    if (card.kind !== 'link' || !card.url || !mine.has(card.id)) continue;
    let page = await store.readPage(card.id);
    if (!page || page.url !== card.url) { page = { url: card.url, ...(await browser.page(card.url).catch((error: Error) => ({ title: card.url, text: `(could not be read: ${error.message})` }))) }; await store.writePage(card.id, page); }
    pages[card.id] = page;
  }
  // What the founder has decided lately, each line with the day it was decided: everyone works from it, wired or not.
  const decided = decidedLines(await decisions.list());
  const messages = buildMessages(stage, roomId, docs, fresh ? [] : await store.readChat(roomId), toolNames, colleagues, await memory.read(roomId), fresh ? undefined : await attachedTo(roomId), pages, decided, await founder.read());
  // Image cards wired to this person ride along with the latest question, for a model that can see. An image studio
  // sends the last picture it made the same way, so a person can look at their own work.
  const pictures: { name: string; url: string }[] = [];
  for (const card of stage.cards ?? []) {
    if (!mine.has(card.id)) continue;
    // An empty picture card wired to a studio shows that studio's newest picture, so what a person sees is what
    // the founder sees on the stage. Without this the founder built exactly that and both of them got an empty box.
    const behind = card.kind === 'image' && !card.path ? studioBehind(stage, card.id) : null;
    const from = card.kind === 'imagegen' ? card.id : behind;
    const file = card.kind === 'image' && card.path ? card.path : from ? (await media.read(from)).results[0]?.path : null;
    if (!file) continue;
    const bytes = await store.readFileBytes(file).catch(() => null);
    if (bytes && bytes.length <= 4_000_000) pictures.push({ name: file, url: `data:${typeOf(file)};base64,${bytes.toString('base64')}` });
  }
  const last = messages.at(-1);
  if (pictures.length && last?.role === 'user') last.images = [...(last.images ?? []), ...pictures.slice(0, 4)];
  return messages;
}

// A consult: the question lands in the colleague's room under the asker's name, they answer once without tools, and both are kept there.
const consult: Consult = async ({ fromRoomId, toRoomId, question, signal }) => {
  const stage = await store.loadStage();
  const asker = stage.rooms.find((room) => room.id === fromRoomId)!;
  const target = stage.rooms.find((room) => room.id === toRoomId)!;
  await store.appendChat(toRoomId, { id: newMessageId(), role: 'user', text: question, at: Date.now(), from: asker.name });
  const messages = await promptFor(stage, toRoomId, []);
  const { order } = route(clients, usage, { pinned: target.model, promptChars: promptSize(messages), tools: false });
  const reply = await complete(messages, { onToken: () => {}, signal }, order);
  usage.record(reply.client.name, reply.usage, reply.quota);
  await store.appendChat(toRoomId, { id: newMessageId(), role: 'assistant', text: reply.text, at: Date.now(), provider: reply.client.name, model: reply.client.model, usage: reply.usage });
  return reply.text;
};
// The two http helpers, up here because the slices installed below are handed them.
// A feed that has gone quiet and a feed that has died look exactly the same from the other end: when this server
// restarts, or a laptop sleeps, whatever sits between (Vite's proxy, the shell's web view) can keep the window's half of
// the connection open and say nothing. So every feed says "still here" four times a minute, and a window that hears
// nothing for a while knows to open it again. A named event, so it never reaches a handler that expects real news.
const PULSE = 15_000;
const pulse = (res: ServerResponse) => {
  const beat = setInterval(() => { if (!res.writableEnded) res.write('event: pulse\ndata: 1\n\n'); }, PULSE);
  beat.unref();
  res.on('close', () => clearInterval(beat));
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function body(req: IncomingMessage): Promise<any> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 2_000_000) throw new Error('body too large');
  }
  return text ? JSON.parse(text) : {};
}

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
seams.on('turn:before', createPlaybook({ skills, recall }).before);
const tools = [...docTools, ...fileTools, ...webTools(browser, (id, card) => ({ profile: store.browserProfile(id), headed: isHeaded(card), ...(!fake && card?.kind === 'browser' && card.app ? { pace: [1500, 3000] as [number, number] } : {}) })), ...outwardTools(fake ? createMail({ AGENTMAIL_API_KEY: 'fake' }, fakeMailHttp) : createMail(), store.filesDir), ...projectTools(fake ? fakeCoder : opencodeCoder(), [workspace, root]), ...teamTools(consult), ...taskTools(boards), ...decisionTools(decisions), ...memoryTools(memory), ...recallTools(recall), ...mediaTools(media, () => !local.ready()), ...skillTools(skills), ...founderTools(founder)];
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

const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;
const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', pdf: 'application/pdf', csv: 'text/csv', json: 'application/json', md: 'text/markdown' };
const typeOf = (name: string) => TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? (TEXT_FILE.test(name) ? 'text/plain' : 'application/octet-stream');

// A chat attachment is read into memory, so it stays small; a piece of footage is written straight to disk as it
// arrives, so it can be as big as a phone makes them.
const UPLOAD_LIMIT = 300_000_000;

async function raw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error(`file too large (limit ${Math.round(limit / 1_000_000)} MB)`); chunks.push(chunk as Buffer); }
  return Buffer.concat(chunks);
}

// What the founder attached to the messages still in the window: text files as text, pictures as pictures.
async function attachedTo(roomId: string): Promise<Attached> {
  const attached: Attached = { texts: {}, images: {} };
  for (const message of recent(await store.readChat(roomId))) {
    for (const file of message.attachments ?? []) {
      const bytes = await store.readFileBytes(file.path);
      if (!bytes) continue;
      if (IMAGE_FILE.test(file.path) && bytes.length <= 4_000_000) attached.images[file.path] = `data:${typeOf(file.path)};base64,${bytes.toString('base64')}`;
      else if (TEXT_FILE.test(file.path) && bytes.length <= 400_000) attached.texts[file.path] = bytes.toString('utf8');
    }
  }
  return attached;
}

// "Learn this": the founder asking for the reflection a turn can also set off by itself, on work already finished.
async function learnFrom(turn: Turn, res: ServerResponse) {
  const learned = await learner.learn(turn, 'taught');
  return json(res, 200, { learned: learned ? { name: learned.name, action: learned.action } : null });
}

async function chat(roomId: string, text: string, res: ServerResponse, extra: { replace?: string; attachments?: Attachment[]; via?: ChatVia } = {}) {
  const stage = await store.loadStage();
  if (!stage.rooms.some((room) => room.id === roomId)) return json(res, 404, { error: 'unknown room' });
  if (busy.has(roomId)) return json(res, 409, { error: 'this person is still replying' });
  busy.add(roomId);

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event: ChatEvent) => !res.writableEnded && res.write(`data: ${JSON.stringify(event)}\n\n`);
  // One name for this turn, said on both roads out of here: whoever asked hears it on their own stream, every other
  // window hears it on the feed, and so nobody draws the same reply twice.
  const turn = newTurnId();
  send({ turn });
  // The founder pressing Stop closes the request; the turn ends there and what was said is kept.
  const stop = new AbortController();
  res.on('close', () => stop.abort());
  try {
    // Regenerate and edit: the old message and everything after it leave the conversation (to trash) before the new one goes in.
    if (extra.replace) await store.cutChat(roomId, extra.replace, true);
    await store.appendChat(roomId, { id: newMessageId(), role: 'user', text, at: Date.now(), ...(extra.via ? { via: extra.via } : {}), ...(extra.attachments?.length ? { attachments: extra.attachments } : {}) });
    roomFeed.tell({ roomId, turn, started: { ...(extra.via ? { via: extra.via } : {}) } });
    // The names in the prompt are the narrowed list too: a person is never told about a tool they are not offered.
    const mine = toolsFor(stage, roomId);
    const messages = await promptFor(stage, roomId, mine.map((tool) => tool.name));
    const room = stage.rooms.find((candidate) => candidate.id === roomId)!;
    const vision = messages.some((message) => message.role === 'user' && !!message.images?.length);
    const { order, notice } = route(clients, usage, { pinned: room.model, promptChars: promptSize(messages), tools: true, vision });
    if (vision && !order[0]?.vision) send({ notice: 'No model that can see images is set up (Gemini can), so the picture is described to the model only by its file name.' });
    if (notice) send({ notice });
    const reply = await runTurn({
      messages, tools: mine, clients: order, usage, signal: stop.signal, seams, source: 'chat', query: text,
      approve: async (event, signal) => {
        await attention.raise({ id: `approval:${event.id}`, kind: 'approval', title: event.question ?? event.name.replace(/_/g, ' '), at: Date.now(), roomId, who: room.name, event });
        try { return await approvals.ask(event.id, signal); } finally { await attention.clear(`approval:${event.id}`); }
      },
      context: { stage, roomId, store, granted: new Map() },
      // Both roads at once: the window that asked, and every window that is only watching.
      events: {
        token: (token) => { send({ token }); roomFeed.tell({ roomId, turn, token }); },
        tool: (tool) => { send({ tool }); roomFeed.tell({ roomId, turn, tool }); },
        notice: (text) => send({ notice: text }),
      },
    });
    const message = {
      id: newMessageId(), role: 'assistant' as const, text: reply.text, at: Date.now(), provider: reply.provider, model: reply.model,
      usage: reply.usage, ...(reply.tools.length ? { tools: reply.tools } : {}), ...(reply.stopped ? { stopped: true } : {}),
    };
    if (reply.text.trim() || reply.tools.length) await store.appendChat(roomId, message);
    send({ done: true, message });
    // Older talk folds into the person's memory after the reply, never in the founder's way.
    void memory.fold(roomId).catch(() => {});
  } catch (error) {
    send({ error: (error as Error).message });
  } finally {
    busy.delete(roomId);
    roomFeed.tell({ roomId, turn, ended: true });
    res.end();
  }
}

createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const refused = guard({ path, method: req.method ?? 'GET', headers: req.headers }, own);
    if (refused) return json(res, 403, { error: refused });
    const doc = /^\/api\/docs\/([^/]+)$/.exec(path)?.[1];
    const room = /^\/api\/rooms\/([^/]+)\/chat$/.exec(path)?.[1];

    if (path === '/api/stage' && req.method === 'GET') return json(res, 200, await store.loadStage());
    // One connection for the whole window, carrying every feed below it under its own channel name. The comment on
    // opening, and the pulse, are the rooms feed's for the rooms feed's reasons: a window knows it is listening
    // before the first word arrives, and it can tell a feed that has gone quiet from one that has died.
    if (path === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); pulse(res);
      res.write(': listening\n\n');
      // A window that goes away while its opening is still being read has to leave whenever it does arrive.
      let leave = () => {};
      res.on('close', () => leave());
      const stop = await events.join((envelope) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(envelope)}\n\n`); });
      if (res.writableEnded) stop(); else leave = stop;
      return;
    }
    if (path === '/api/stage' && req.method === 'PUT') {
      const [before, next] = [await store.loadStage(), (await body(req)) as Stage];
      await store.saveStage(next);
      // The window's one feed follows the stage: a board card put down here is live before this answer goes back.
      events.restage(next);
      // A browser card that left the stage takes its Chrome session with it.
      for (const card of before.cards ?? []) if (!next.cards?.some((kept) => kept.id === card.id)) void browser.close(browserSession(card.id));
      if ((before.cards ?? []).length !== (next.cards ?? []).length) void attention.refresh();
      return json(res, 200, { ok: true });
    }
    const asked = /^\/api\/approvals\/([\w.:-]{1,120})$/.exec(path)?.[1];
    if (asked && req.method === 'POST') {
      const answer = await body(req);
      const known = approvals.answer(asked, { ok: answer.ok === true, args: answer.args && typeof answer.args === 'object' ? answer.args : undefined });
      return json(res, known ? 200 : 404, known ? { ok: true } : { error: 'nothing is waiting under that id' });
    }
    if (path === '/api/missions' && req.method === 'GET') {
      const stage = await store.loadStage();
      const [chats, docs]: [Record<string, Awaited<ReturnType<typeof store.readChat>>>, Record<string, string>] = [{}, {}];
      for (const one of stage.rooms) chats[one.id] = await store.readChat(one.id);
      for (const one of stage.docs) docs[one.id] = await store.readDoc(one.id).catch(() => '');
      const tasks = (await Promise.all((stage.cards ?? []).filter((card) => card.kind === 'board').map((card) => boards.list(card.id)))).flat();
      const dismissed = await readFile(resolve(workspace, 'missions.json'), 'utf8').then((text) => JSON.parse(text).dismissed === true, () => false);
      return json(res, 200, { dismissed, missions: missionsOf({ stage, chats, docs, decisions: await decisions.list(), tasks }) });
    }
    if (path === '/api/missions/dismiss' && req.method === 'POST') { await writeFile(resolve(workspace, 'missions.json'), JSON.stringify({ dismissed: true })); return json(res, 200, { ok: true }); }
    if (path === '/api/search' && req.method === 'GET') {
      const hits = await recall.search(new URL(req.url ?? '/', 'http://localhost').searchParams.get('q') ?? '', { top: 12 });
      return json(res, 200, { hits, mode: recall.mode() });
    }
    // What the people have spent and done lately. No screen reads it yet; the file behind it is the founder's to keep.
    if (path === '/api/trace' && req.method === 'GET') return json(res, 200, await trace.summary(Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('days')) || 7));
    if (path === '/api/decisions' && req.method === 'GET') return json(res, 200, await decisions.list());
    if (path === '/api/decisions' && req.method === 'POST') return json(res, 200, await decisions.record(await body(req)));
    const ruled = /^\/api\/decisions\/([a-z0-9-]{1,100})(?:\/(decide))?$/.exec(path);
    if (ruled && ruled[2] === 'decide' && req.method === 'POST') return json(res, 200, await decisions.decide(ruled[1], await body(req)));
    if (ruled && !ruled[2] && req.method === 'DELETE') { await decisions.remove(ruled[1]); return json(res, 200, { ok: true }); }
    // The playbook. Everything in it was written without asking, so everything in it can be edited, switched off,
    // put back or thrown away by the founder, and the panel hears about every change on one feed.
    if (path === '/api/skills' && req.method === 'GET') return json(res, 200, await skills.list());
    if (path === '/api/skills/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); pulse(res);
      const tell = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      tell({ skills: await skills.list() });
      res.on('close', skills.watch(tell));
      return;
    }
    const taught = /^\/api\/skills\/([a-z0-9-]{1,80})$/.exec(path)?.[1];
    if (taught && req.method === 'PATCH') {
      const asked = await body(req);
      let skill = await skills.get(taught);
      if (!skill) return json(res, 404, { error: 'unknown skill' });
      if (asked.undo === true) skill = await skills.undo(taught);
      else if (['name', 'when', 'procedure', 'pitfalls', 'verify'].some((field) => asked[field] !== undefined)) skill = await skills.edit(taught, asked);
      if (typeof asked.state === 'string') skill = await skills.setState(taught, asked.state);
      return json(res, 200, skill);
    }
    if (taught && req.method === 'DELETE') { await skills.remove(taught); return json(res, 200, { ok: true }); }
    if (path === '/api/founder' && req.method === 'GET') return json(res, 200, { text: await founder.read() });
    if (path === '/api/founder' && req.method === 'PUT') { await founder.write(String((await body(req)).text ?? '')); return json(res, 200, { ok: true }); }
    const learns = /^\/api\/rooms\/([^/]+)\/learn$/.exec(path)?.[1];
    if (learns && req.method === 'POST') {
      const talk = await store.readChat(learns);
      const at = talk.findLastIndex((one) => one.role === 'assistant');
      const asked = at > 0 ? talk.slice(0, at).findLast((one) => one.role === 'user') : undefined;
      if (at < 0 || !asked) return json(res, 400, { error: 'there is nothing finished here to learn from yet' });
      const said = talk[at];
      return await learnFrom({ roomId: learns, source: 'chat', query: asked.text, reply: { text: said.text, tools: said.tools ?? [], provider: said.provider ?? '', model: said.model ?? '', usage: said.usage ?? { input: 0, output: 0 }, stopped: false } }, res);
    }
    if (path === '/api/threads' && req.method === 'GET') {
      const stage = await store.loadStage();
      const chats: Record<string, Awaited<ReturnType<typeof store.readChat>>> = {};
      for (const one of stage.rooms) chats[one.id] = await store.readChat(one.id);
      return json(res, 200, threadsOf(stage, chats, busy, new URL(req.url ?? '/', 'http://localhost').searchParams.get('q') ?? ''));
    }
    // One feed for every conversation on the stage, the way the studios have one: a card only draws what happened in
    // its own room, and a turn started anywhere reaches all of them.
    if (path === '/api/rooms/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); pulse(res);
      // Nothing is sent on opening, and a browser is told a feed is open only once something comes down it. A comment
      // costs one line and means a card knows it is listening before the founder's first word arrives, not after.
      res.write(': listening\n\n');
      res.on('close', roomFeed.watch((event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); }));
      return;
    }
    if (path === '/api/attention' && req.method === 'GET') return json(res, 200, await attention.list());
    if (path === '/api/attention/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); pulse(res);
      const tell = (list: unknown) => res.write(`data: ${JSON.stringify(list)}\n\n`);
      tell(await attention.list());
      res.on('close', attention.watch(tell));
      return;
    }
    // Every id on this list has a colon in it (`approval:call-1`, `run-failed:t2:5`), and a colon travels here as
    // `%3A`. Without the `%` and the decoding, Dismiss reached nothing at all and the founder pressed it for nothing.
    const dismissed = /^\/api\/attention\/([\w.:%-]{1,160})\/dismiss$/.exec(path)?.[1];
    if (dismissed && req.method === 'POST') { await attention.dismiss(decodeURIComponent(dismissed)); return json(res, 200, { ok: true }); }
    const board = /^\/api\/boards\/([^/]+)(?:\/(events|tasks)(?:\/([^/]+)(?:\/(run|stop|learn))?)?)?$/.exec(path);
    if (board) {
      const [, boardId, part, taskId, action] = board;
      if (!(await store.loadStage()).cards?.some((card) => card.id === boardId && card.kind === 'board')) return json(res, 404, { error: 'unknown board' });
      if (!part && req.method === 'GET') return json(res, 200, await boards.list(boardId));
      if (part === 'events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); pulse(res);
        const tell = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        tell({ tasks: await boards.list(boardId) });
        res.on('close', boards.watch(boardId, tell));
        return;
      }
      if (part === 'tasks' && !taskId && req.method === 'POST') return json(res, 200, await boards.add(boardId, await body(req)));
      if (taskId && !action && req.method === 'PATCH') return json(res, 200, await boards.change(boardId, taskId, await body(req)));
      if (taskId && !action && req.method === 'DELETE') { runs.stop(taskId); await boards.remove(boardId, taskId); return json(res, 200, { ok: true }); }
      // A task that cannot start (nobody to do it, already running, its person busy, a skill switched off) is not the
      // server breaking: the reason goes back as a plain "not now", and the card and needs-you show it as they always did.
      if (taskId && action === 'run' && req.method === 'POST') {
        try { await runs.start(boardId, taskId); } catch (error) { return json(res, 409, { error: (error as Error).message }); }
        return json(res, 200, { ok: true });
      }
      if (taskId && action === 'stop' && req.method === 'POST') { runs.stop(taskId); return json(res, 200, { ok: true }); }
      if (taskId && action === 'learn' && req.method === 'POST') {
        const task = (await boards.list(boardId)).find((one) => one.id === taskId);
        if (!task?.run || task.run.state !== 'done' || !task.assignee) return json(res, 400, { error: 'only a task that a person finished can be learned from' });
        // The names of what it reached for, out of the log. Not a word of what any of them came back with.
        const did = task.run.log.flatMap((one) => { const call = /^([✓✗]) (\w+)/.exec(one); return call ? [{ id: call[2], name: call[2], args: {}, ok: call[1] === '✓' }] : []; });
        return await learnFrom({
          roomId: task.assignee, source: 'run', ref: taskId, query: `${task.title}${task.detail ? `\n\n${task.detail}` : ''}`,
          reply: { text: task.run.result ?? '', tools: did, provider: task.run.provider ?? '', model: task.run.model ?? '', usage: task.run.usage ?? { input: 0, output: 0 }, stopped: false },
        }, res);
      }
    }
    // Every studio card on the stage streams through one feed, the way the attention list does.
    if (path === '/api/media/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); pulse(res);
      res.on('close', media.watch((event) => res.write(`data: ${JSON.stringify(event)}\n\n`)));
      return;
    }
    // The voices a voice studio offers, named for the founder. A fixed list: asking the model would fetch 310 MB first.
    // Best first, and each one saying who it sounds like: a founder choosing a narrator is casting, and casting
    // needs to know the gender, the accent and how good the voice actually is.
    if (path === '/api/media/voices' && req.method === 'GET') return json(res, 200, { voices: byGrade(VOICES) });
    const studio = /^\/api\/media\/([^/]+)(?:\/(make|stop|assets)(?:\/([^/]{1,120}))?)?$/.exec(path);
    if (studio) {
      const [, cardId, action, assetName] = studio;
      const card = (await store.loadStage()).cards?.find((one) => one.id === cardId && (MEDIA_KINDS as readonly string[]).includes(one.kind));
      if (!card) return json(res, 404, { error: 'unknown studio' });
      if (!action && req.method === 'GET') return json(res, 200, {
        ...(await media.read(cardId)), hint: media.ready(card.kind as MediaKind),
        // A video studio says its minutes before Make is pressed, and the minutes turn on where pictures are drawn.
        ...(card.kind === 'videogen' ? { drawnHere: filmPictures.next?.() === 'this computer' } : {}),
      });
      // The founder's own footage, dropped on a studio card. A video is far bigger than anything else this app takes,
      // so it is written to disk as it arrives rather than held in memory, and only then looked at.
      if (action === 'assets' && !assetName && req.method === 'POST') {
        const name = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? 'clip.mp4';
        const { path: saved, bytes } = await store.streamUpload(name, req, UPLOAD_LIMIT);
        const track = await probe(store.pathOf(saved)).catch(() => null);
        if (!track) { return json(res, 400, { error: 'that file could not be read as a video, a picture or a sound' }); }
        let thumb: string | undefined;
        if (track.kind === 'video') {
          const into = `media/thumb-${Date.now().toString(36)}.jpg`;
          await thumbOf(store.pathOf(saved), store.pathOf(into), Math.min(1, track.seconds / 3)).then(() => { thumb = into; }, () => {});
        } else if (track.kind === 'image') thumb = saved;
        return json(res, 200, await media.addAsset(cardId, { file: name, path: saved, kind: track.kind, bytes, seconds: track.seconds || undefined, thumb }));
      }
      // A path is not decoded on the way in, and an asset is named after a file, spaces and all.
      if (action === 'assets' && assetName && req.method === 'DELETE') { await media.removeAsset(cardId, decodeURIComponent(assetName)); return json(res, 200, { ok: true }); }
      if (action === 'make' && req.method === 'POST') {
        const asked = await body(req);
        const prompt = String(asked.prompt ?? '').trim();
        if (!prompt) return json(res, 400, { error: 'say what to make first' });
        // A video takes minutes. Every studio answers the moment the job starts and the feed carries the rest, so the
        // founder's window is never left holding a request open.
        void media.make(card, { ...asked, prompt }).catch(() => { /* the card hears the failure through the feed */ });
        return json(res, 202, { started: true });
      }
      if (action === 'stop' && req.method === 'POST') { media.stop(cardId); return json(res, 200, { ok: true }); }
    }
    const linked = /^\/api\/links\/([^/]+)$/.exec(path)?.[1];
    if (linked && req.method === 'POST') {
      const card = (await store.loadStage()).cards?.find((one) => one.id === linked);
      if (!card || card.kind !== 'link' || !card.url) return json(res, 404, { error: 'unknown link' });
      const page = { url: card.url, ...(await browser.page(card.url)) };
      await store.writePage(linked, page);
      return json(res, 200, { title: page.title, preview: page.text.slice(0, 280) });
    }
    // Whether the founder is signed in to an app card. A plain browser card has no rule, so nothing is claimed for it.
    const checked = /^\/api\/browsers\/([^/]+)\/signed-in$/.exec(path)?.[1];
    if (checked && req.method === 'GET') {
      const card = (await store.loadStage()).cards?.find((one) => one.id === checked);
      if (!card || card.kind !== 'browser') return json(res, 404, { error: 'unknown browser' });
      if (!card.app) return json(res, 200, { signedIn: null, landedOn: '' });
      const landedOn = await browser.landing(browserSession(checked), card.app.home, { profile: store.browserProfile(checked), headed: isHeaded(card) });
      return json(res, 200, { signedIn: signedIn(card.app, landedOn), landedOn });
    }
    const watched = /^\/api\/browsers\/([^/]+)$/.exec(path)?.[1];
    if (watched && req.method === 'GET') {
      if (!(await store.loadStage()).cards?.some((card) => card.id === watched && card.kind === 'browser')) return json(res, 404, { error: 'unknown browser' });
      const card = (await store.loadStage()).cards!.find((one) => one.id === watched)!;
      return json(res, 200, await browser.watch(browserSession(watched), { profile: store.browserProfile(watched), headed: isHeaded(card) }, card.kind === 'browser' ? card.app?.home : undefined));
    }
    // "Show window" changed: Chrome reads that only at start, so end the session and start it again the new way.
    const restarted = /^\/api\/browsers\/([^/]+)\/restart$/.exec(path)?.[1];
    if (restarted && req.method === 'POST') {
      const card = (await store.loadStage()).cards?.find((one) => one.id === restarted && one.kind === 'browser');
      if (!card) return json(res, 404, { error: 'unknown browser' });
      await browser.close(browserSession(restarted));
      return json(res, 200, await browser.watch(browserSession(restarted), { profile: store.browserProfile(restarted), headed: isHeaded(card) }, card.kind === 'browser' ? card.app?.home : undefined));
    }
    if (doc && req.method === 'GET') return json(res, 200, { text: await store.readDoc(doc) });
    if (doc && req.method === 'PUT') { await store.writeDoc(doc, String((await body(req)).text ?? '')); return json(res, 200, { ok: true }); }
    if (path === '/api/models' && req.method === 'GET') return json(res, 200, usage.info(clients));
    const cut = /^\/api\/rooms\/([^/]+)\/chat\/([\w-]{1,80})$/.exec(path);
    if (cut && req.method === 'DELETE') {
      if (busy.has(cut[1])) return json(res, 409, { error: 'this person is still replying' });
      return json(res, 200, await store.cutChat(cut[1], cut[2], false));
    }
    if (path === '/api/files' && req.method === 'POST') {
      const name = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? 'file';
      const data = await raw(req, 15_000_000);
      const saved = await store.saveUpload(name, data);
      return json(res, 200, { path: saved, type: typeOf(saved), size: data.length });
    }
    if (path.startsWith('/api/files/') && req.method === 'GET') {
      const name = decodeURIComponent(path.slice('/api/files/'.length));
      const bytes = await store.readFileBytes(name).catch(() => null);
      if (!bytes) return json(res, 404, { error: 'no such file' });
      // Files may hold anything a person or a page produced: never let one run as a page of this app.
      const headers = { 'content-type': typeOf(name), 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache', 'accept-ranges': 'bytes' };
      // A player asks for a piece at a time, and will not play or seek a sound or a video that answers with the lot.
      const piece = rangeOf(Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range, bytes.length);
      if (piece === 'bad') { res.writeHead(416, { ...headers, 'content-range': `bytes */${bytes.length}` }); return res.end(); }
      if (piece) {
        res.writeHead(206, { ...headers, 'content-range': `bytes ${piece.from}-${piece.to}/${bytes.length}`, 'content-length': String(piece.to - piece.from + 1) });
        return res.end(bytes.subarray(piece.from, piece.to + 1));
      }
      res.writeHead(200, { ...headers, 'content-length': String(bytes.length) });
      return res.end(bytes);
    }
    const remembered = /^\/api\/rooms\/([^/]+)\/memory$/.exec(path)?.[1];
    if (remembered && req.method === 'GET') { const { notes, summary } = await memory.read(remembered); return json(res, 200, { notes, summary }); }
    if (remembered && req.method === 'PUT') { await memory.write(remembered, await body(req)); return json(res, 200, { ok: true }); }
    if (room && req.method === 'GET') return json(res, 200, await store.readChat(room));
    if (room && req.method === 'POST') {
      const sent = await body(req);
      const text = String(sent.text ?? '').trim();
      const attachments: Attachment[] = [];
      for (const file of Array.isArray(sent.attachments) ? sent.attachments.slice(0, 5) : []) {
        const bytes = typeof file?.path === 'string' && file.path.startsWith('uploads/') ? await store.readFileBytes(file.path) : null;
        if (bytes) attachments.push({ path: file.path, type: typeOf(file.path), size: bytes.length });
      }
      if (!text && !attachments.length) return json(res, 400, { error: 'empty message' });
      // Where the founder was standing. Only what this app knows how to say back is kept; anything else is nobody.
      const via: ChatVia | undefined = sent.via === 'phone' || sent.via === 'call' ? sent.via : undefined;
      return await chat(room, text || 'See the attached file.', res, { replace: typeof sent.replace === 'string' ? sent.replace : undefined, attachments, via });
    }
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
