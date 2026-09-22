import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ChatMessage } from '../../shared/model.ts';
import type { ForgeJob, ForgeMode, Person, Proposal } from '../../shared/forge.ts';
import { FORGE_CHANNEL } from '../../shared/forge.ts';
import type { Case } from '../../shared/frameworks.ts';
import { frameworkId } from '../../shared/frameworks.ts';
import { fakeJudge, JUDGE_CHUNKS, type Judge } from '../evals/score.ts';
import { buildTeam, runOf, scorecardOf, scratchStage, withWinners, type PersonResult } from '../forge/build.ts';
import { readNotes, shapesOf, type NoteRead } from '../forge/notes.ts';
import { checkProposal, frameworkOf, proposeMessages } from '../forge/propose.ts';
import { createFrameworks } from '../frameworks/store.ts';
import { hub } from '../events.ts';
import type { Deps, Slice } from '../install.ts';
import { completeJson } from '../json.ts';
import { createLibrary, noteOf, notesBlock } from '../library/notes.ts';
import { runTurn } from '../loop.ts';
import { buildMessages, type ModelMessage } from '../prompt.ts';
import { complete, promptSize, type ModelClient } from '../providers.ts';
import { createRecall, localEmbedder, wordEmbedder } from '../recall.ts';
import { route } from '../router.ts';

// The forge: the founder chooses the notes they learned from, says in a line what they want a team for, and a model
// proposes one. They read it, change what they like, and press Build — and then every person is written twice, put
// through the founder's own test cases and scored against the notes before any of it is offered to their stage.
// Nothing the forge runs happens on that stage: the people it tests live in a stage held in memory for the length of
// one run. People never call the forge, so it installs no tools at all.

const ONE = /^\/api\/forge\/([a-z0-9][a-z0-9-]{0,63})$/;
const STOP = /^\/api\/forge\/([a-z0-9][a-z0-9-]{0,63})\/stop$/;
const RUNNING: ForgeJob['state'][] = ['reading', 'proposing', 'building', 'testing'];
const MOST_LINES = 400;
const WARM_AFTER = 7000;

// Everything one forge job is, including the parts the window is never shown: the notes it read, what it may stop,
// and which models have answered so far.
type Job = ForgeJob & {
  notes: NoteRead[]; noteIds: string[]; intent: string;
  models: Set<string>; stop: AbortController;
};

// What the founder's window sees. The insides stay here.
const view = (job: Job): ForgeJob => ({
  id: job.id, state: job.state, mode: job.mode, lines: job.lines, calls: job.calls,
  ...(job.proposal ? { proposal: job.proposal } : {}), ...(job.framework ? { framework: job.framework } : {}),
  ...(job.critiques ? { critiques: job.critiques } : {}), ...(job.error ? { error: job.error } : {}),
});

const newJobId = () => `forge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const stamp = (at: number) => new Date(at).toISOString().replace(/[:.]/g, '-');

export default {
  name: 'forge',
  install(deps: Deps) {
    const library = createLibrary(deps.workspace);
    const frameworks = createFrameworks(deps.workspace);
    // The library's own recall, over the same passages and the same saved vectors the library slice uses: a note is
    // chunked and embedded once for this workspace however many things are asking about it.
    const recall = createRecall({
      dir: join(library.folder, '.recall'),
      embed: deps.fake ? wordEmbedder : localEmbedder(resolve(deps.root, 'app/.cache/recall')),
      gather: library.pieces,
    });
    setTimeout(() => { void recall.warm().catch(() => {}); }, WARM_AFTER).unref();

    let job: Job | null = null;

    // A line the founder reads while they wait. It is kept on the job for whoever asks afterwards, and said at once
    // on the window's one live feed for whoever is watching now.
    const say = (held: Job, line: string) => {
      held.lines = [...held.lines, line].slice(-MOST_LINES);
      hub.say(FORGE_CHANNEL, { kind: 'forge', jobId: held.id, line });
    };

    // The roomiest model that is ready: proposing a team is the one call in the app that is given whole sections of
    // the founder's notes, so it goes to whichever configured model can hold the most of them. `route` decides what
    // is ready — quota left, not resting on a 429 — and this only reorders what it allows.
    const biggest = (promptChars: number): ModelClient[] => {
      const { order } = route(deps.clients, deps.usage, { promptChars, tools: false });
      return [...order].sort((one, other) => other.maxPromptChars - one.maxPromptChars);
    };

    // One model call that comes back as words, counted. Everything the forge spends goes through here or through a
    // person's own turn, so the number the founder watches is the number that was really spent.
    const ask = async (held: Job, messages: ModelMessage[]): Promise<string> => {
      const reply = await complete(messages, { onToken: () => {}, signal: held.stop.signal }, biggest(promptSize(messages)));
      held.calls += 1;
      held.models.add(reply.client.name);
      deps.usage.record(reply.client.name, reply.usage, reply.quota);
      return reply.text;
    };

    // The judge. In fake mode nothing is asked of any model: the scores come from the case's own id, so a browser
    // journey and the unit tests run offline and say the same thing twice.
    const judgeFor = (held: Job): Judge => (deps.fake ? fakeJudge : ({ messages }) => ask(held, messages));

    // The passages of the founder's notes that answer one case, asked for once and kept: the same three go to the
    // person answering and to the judge scoring them, which is the only way the two can be talking about the same
    // thing. Each passage keeps the note it came from, because a person is told which of the founder's notes they
    // are reading.
    const chunkCache = new Map<string, { title: string; text: string }[]>();
    const passagesFor = async (held: Job, kase: Case) => {
      const known = chunkCache.get(kase.id);
      if (known) return known;
      const hits = await recall.search(kase.input, { allow: (piece) => held.noteIds.includes(noteOf(piece.id)), top: JUDGE_CHUNKS });
      const titles = new Map(held.notes.map((note) => [note.id, note.title]));
      const found = hits.map((hit) => ({ title: titles.get(noteOf(hit.id)) ?? 'the founder\'s notes', text: hit.text }));
      chunkCache.set(kase.id, found);
      return found;
    };
    const chunksFor = async (held: Job, kase: Case): Promise<string[]> => (await passagesFor(held, kase)).map((one) => one.text);

    // One whole turn of one candidate, on a stage that exists only here. No tools are offered — a team is being
    // measured on its judgement, not on what it can go and fetch — and nothing it says is written anywhere.
    const answer = async (held: Job, proposal: Proposal, person: Person, brief: string, kase: Case): Promise<string> => {
      const stage = scratchStage({ ...proposal, rooms: proposal.rooms.map((one) => (one.key === person.key ? { ...one, brief } : one)) }, held.noteIds);
      const roomId = `forge-${person.key}`;
      const docs = Object.fromEntries(proposal.docs.map((doc) => [`forge-${doc.key}`, doc.text]));
      const history: ChatMessage[] = [{ id: 'case', role: 'user', text: kase.input, at: Date.now() }];
      const [system, ...rest] = buildMessages(stage, roomId, docs, history);
      // The founder's notes reach the person exactly as they would on their own stage: the passages that answer this
      // question, under the name of the note. The library's seam cannot do it here — it reads the founder's saved
      // stage, and this stage was never saved — so the block is added the same way, by hand.
      const passages = await passagesFor(held, kase);
      const byNote = [...new Set(passages.map((one) => one.title))].map((title) => ({ title, chunks: passages.filter((one) => one.title === title).map((one) => one.text) }));
      const block = notesBlock(byNote);
      const messages = [block && system.role === 'system' ? { ...system, content: `${system.content}\n\n${block}` } : system, ...rest];
      const { order } = route(deps.clients, deps.usage, { promptChars: promptSize(messages), tools: false });
      const reply = await runTurn({
        messages, tools: [], clients: order, usage: deps.usage, signal: held.stop.signal, source: 'run', query: kase.input,
        context: { stage, roomId, store: deps.store, granted: new Map() },
        events: { token: () => {}, tool: () => {} },
      });
      held.calls += 1;
      if (reply.provider) held.models.add(reply.provider);
      return reply.text;
    };

    // An id nothing is saved under yet: a second team forged from the same notes never overwrites the first.
    const freeId = async (name: string): Promise<string> => {
      const stem = frameworkId(name);
      let id = stem;
      for (let tries = 2; await frameworks.read(id).catch(() => null); tries += 1) id = `${stem}-${tries}`;
      return id;
    };

    // The record of what was run, beside the framework it was run for. The evals round reads these; this round only
    // writes them, whole, whether or not the scores were good.
    const keepRun = async (id: string, run: unknown, at: number) => {
      const folder = join(frameworks.folder, id, 'runs');
      const file = join(folder, `${stamp(at)}.json`);
      await mkdir(folder, { recursive: true });
      await writeFile(`${file}.tmp`, `${JSON.stringify(run, null, 2)}\n`);
      await rename(`${file}.tmp`, file);
    };

    const failed = (held: Job, error: Error) => {
      if (job !== held) return;
      held.state = 'failed';
      held.error = error.message;
      say(held, error.message);
    };

    // Reading the notes and proposing the team. One model call, and one retry if what came back was not the shape a
    // framework has to be — the model is shown exactly what was wrong with its own answer.
    async function propose(held: Job) {
      held.state = 'reading';
      say(held, `Reading ${held.noteIds.length === 1 ? 'the note' : `${held.noteIds.length} notes`}.`);
      held.notes = await readNotes(held.noteIds, {
        find: async (id) => (await library.list()).find((note) => note.id === id),
        read: (id) => library.read(id),
        search: async (query, noteId, top) => (await recall.search(query, { allow: (piece) => noteOf(piece.id) === noteId, top })).map((hit) => hit.text),
      });
      say(held, `${held.notes.map((note) => `"${note.title}"`).join(', ')}: ${held.notes.reduce((sum, note) => sum + note.headings.length, 0)} sections.`);
      held.state = 'proposing';
      say(held, 'Asking for a team.');
      const messages = proposeMessages({ intent: held.intent, notes: held.notes });
      held.proposal = await completeJson(
        messages,
        (value) => checkProposal(value, { notes: shapesOf(held.notes), intent: held.intent }),
        biggest(promptSize(messages)),
        { signal: held.stop.signal, onReply: (reply) => { held.calls += 1; held.models.add(reply.client.name); deps.usage.record(reply.client.name, reply.usage, reply.quota); } },
      );
      held.state = 'previewing';
      say(held, `${held.proposal.name}: ${held.proposal.rooms.length} people, ${held.proposal.dataset.length} test cases. Yours to change.`);
    }

    // Writing the briefs, running the cases, scoring them, and saving what came out. The framework is written last,
    // so a run that fails half way through leaves the founder's frameworks exactly as they were.
    async function build(held: Job, proposal: Proposal) {
      held.state = 'building';
      chunkCache.clear();
      say(held, held.mode === 'quick' ? 'Building: one brief each, the first case.' : 'Building: two briefs each, every case, then one rewrite.');
      const people: PersonResult[] = await buildTeam({
        proposal, mode: held.mode, noteTitles: held.notes.map((note) => note.title),
        chunksFor: (kase) => chunksFor(held, kase),
        ask: (messages) => ask(held, messages),
        answer: (person, brief, kase) => answer(held, proposal, person, brief, kase),
        judge: judgeFor(held),
        line: (text) => say(held, text),
        onTesting: () => { held.state = 'testing'; },
        signal: held.stop.signal,
      });

      const at = Date.now();
      const models = [...held.models].sort();
      const won = withWinners(proposal, people);
      const id = await freeId(won.name);
      const scorecard = scorecardOf({ people, models, at });
      const framework = frameworkOf(won, {
        id, intent: held.intent, version: 1, builtAt: at, scorecard,
        notes: held.notes.map((note) => ({ id: note.id, hash: note.hash })),
      });
      await keepRun(id, runOf({ people, version: 1, mode: held.mode, models, at }), at);
      held.framework = await frameworks.save(framework);
      held.critiques = Object.fromEntries(people.map((person) => [person.key, person.critique]));
      held.proposal = won;
      held.state = 'done';
      say(held, `${framework.name} scored ${scorecard.mean.toFixed(2)} on ${scorecard.cases} ${scorecard.cases === 1 ? 'case' : 'cases'}, in ${held.calls} calls. It is yours to place.`);
    }

    return {
      async route(req, res, path) {
        if (!path.startsWith('/api/forge')) return false;
        const method = req.method ?? 'GET';

        if (path === '/api/forge/propose' && method === 'POST') {
          if (job && RUNNING.includes(job.state)) { deps.json(res, 409, { error: 'The forge is already busy with a team.', jobId: job.id }); return true; }
          const asked = (await deps.body(req)) ?? {};
          const noteIds = [...new Set((Array.isArray(asked.noteIds) ? (asked.noteIds as unknown[]) : []).map(String))].slice(0, 5);
          if (!noteIds.length) { deps.json(res, 400, { error: 'Choose at least one note to build from.' }); return true; }
          const held: Job = {
            id: newJobId(), state: 'reading', mode: asked.mode === 'full' ? 'full' : 'quick', lines: [], calls: 0,
            notes: [], noteIds, intent: String(asked.intent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
            models: new Set(), stop: new AbortController(),
          };
          job = held;
          // The founder is answered at once and watches the lines: a first call to a big model takes long enough
          // that holding the request open would look like a page that had stopped.
          void propose(held).catch((error: Error) => failed(held, error));
          deps.json(res, 200, { jobId: held.id });
          return true;
        }

        if (path === '/api/forge/build' && method === 'POST') {
          const asked = (await deps.body(req)) ?? {};
          const held = job;
          if (!held || held.id !== String(asked.jobId ?? '')) { deps.json(res, 404, { error: 'That forge job is no longer here. Start again.' }); return true; }
          if (RUNNING.includes(held.state)) { deps.json(res, 409, { error: 'The forge is already busy with a team.', jobId: held.id }); return true; }
          try {
            // The founder's own edits, not a model's answer: the shape is held to, the rules a model is held to are
            // not. They may write a brief any way they like.
            held.proposal = checkProposal(asked.proposal ?? held.proposal, { notes: shapesOf(held.notes), intent: held.intent, lenient: true });
          } catch (error) { deps.json(res, 400, { error: (error as Error).message }); return true; }
          held.mode = asked.mode === 'full' ? 'full' : asked.mode === 'quick' ? 'quick' : held.mode;
          held.error = undefined;
          held.stop = new AbortController();
          const proposal = held.proposal;
          void build(held, proposal).catch((error: Error) => failed(held, error));
          deps.json(res, 200, { jobId: held.id });
          return true;
        }

        const stopping = STOP.exec(path)?.[1];
        if (stopping && method === 'POST') {
          if (!job || job.id !== stopping) { deps.json(res, 404, { error: 'That forge job is no longer here.' }); return true; }
          job.stop.abort();
          deps.json(res, 200, { ok: true });
          return true;
        }

        const id = ONE.exec(path)?.[1];
        if (id && method === 'GET') {
          if (!job || job.id !== id) deps.json(res, 404, { error: 'That forge job is no longer here.' });
          else deps.json(res, 200, view(job));
          return true;
        }
        return false;
      },
      // A forge left running when the app goes away stops where it is: half a team is never written down.
      close: async () => { job?.stop.abort(); job = null; },
    };
  },
} satisfies Slice;
