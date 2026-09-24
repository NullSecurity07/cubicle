import { join, resolve } from 'node:path';
import type { EvalsJob, EvalsView, Run, RunCase } from '../../shared/evals.ts';
import { EVALS_CHANNEL } from '../../shared/evals.ts';
import type { Case, Framework } from '../../shared/frameworks.ts';
import { answerCase, createPassages } from '../evals/answer.ts';
import { busyWith, claiming } from '../evals/lock.ts';
import { lineOf, meanOfCases, regressionsOf, scorecardOf, settle } from '../evals/promote.ts';
import { fakeJudge, scoreCase, scoreWord, type Judge } from '../evals/score.ts';
import { autoevalsJudge, judgeClientsOf, readyEnough } from '../evals/scorers.ts';
import { createRunStore } from '../evals/store.ts';
import { briefHash } from '../forge/build.ts';
import { createFrameworks } from '../frameworks/store.ts';
import { hub } from '../events.ts';
import type { Deps, Slice } from '../install.ts';
import { createLibrary } from '../library/notes.ts';
import type { ModelMessage } from '../prompt.ts';
import { complete, promptSize } from '../providers.ts';
import { createRecall, localEmbedder, wordEmbedder } from '../recall.ts';
import { route } from '../router.ts';

// Evals: running a framework's people against the founder's own test cases again, and deciding whether what came out
// is allowed to become what the framework says about itself. A framework is only a building block worth placing if
// somebody keeps score, and this is the part that does — the experiment, and the one rule that stops a team quietly
// getting worse while its average goes up.
//
// Nothing here happens on the founder's stage: the people answering live in a stage held in memory for the length of
// one run, exactly as they do in the forge, and the only things that reach disk are the run file and — when the run
// earns it — the framework's new scorecard.

const RERUN = /^\/api\/frameworks\/([a-z0-9][a-z0-9-]{0,79})\/evals$/;
const RUNS = /^\/api\/frameworks\/([a-z0-9][a-z0-9-]{0,79})\/runs$/;
const PROMOTE = /^\/api\/frameworks\/([a-z0-9][a-z0-9-]{0,79})\/runs\/(\d{10,16})\/promote$/;
const MOST_LINES = 400;
const MOST_OUTPUT = 6000;
const WARM_AFTER = 9000;

type Job = EvalsJob & { stop: AbortController; models: Set<string> };
const view = (job: Job): EvalsJob => ({
  id: job.id, state: job.state, lines: job.lines, calls: job.calls, ...(job.error ? { error: job.error } : {}),
});

export default {
  name: 'evals',
  install(deps: Deps) {
    const library = createLibrary(deps.workspace);
    const frameworks = createFrameworks(deps.workspace);
    const runs = createRunStore(frameworks.folder);
    // The library's own recall, over the same passages and the same saved vectors the library slice and the forge
    // use: a note is chunked and embedded once for this workspace however many things are asking about it.
    const recall = createRecall({
      dir: join(library.folder, '.recall'),
      embed: deps.fake ? wordEmbedder : localEmbedder(resolve(deps.root, 'app/.cache/recall')),
      gather: library.pieces,
    });
    setTimeout(() => { void recall.warm().catch(() => {}); }, WARM_AFTER).unref();

    let job: Job | null = null;
    const unclaim = claiming(deps.workspace, () => (job?.state === 'testing' ? `The evals are already running on ${job.id}.` : null));

    // A line the founder reads while they wait: kept on the job for whoever asks afterwards, and said at once on the
    // window's one live feed for whoever is watching now. The forge says its lines the same way.
    const say = (held: Job, line: string) => {
      held.lines = [...held.lines, line].slice(-MOST_LINES);
      hub.say(EVALS_CHANNEL, { kind: 'evals', id: held.id, line, state: held.state });
    };

    // One model call that comes back as words, counted. Only the stand-in judge below needs it — the scorers have
    // their own way through — and it exists so a workspace whose only provider does not speak the OpenAI API can
    // still score its frameworks.
    const ask = async (held: Job, messages: ModelMessage[]): Promise<string> => {
      const { order } = route(deps.clients, deps.usage, { promptChars: promptSize(messages), tools: false });
      const reply = await complete(messages, { onToken: () => {}, signal: held.stop.signal }, order);
      held.calls += 1;
      held.models.add(reply.client.name);
      deps.usage.record(reply.client.name, reply.usage, reply.quota);
      return reply.text;
    };

    // The same three judges the forge uses, chosen the same way: nothing at all in fake mode, the `autoevals` scorers
    // through the keys this app already holds otherwise — every provider that can judge, best first, so a rate limit
    // on one moves the scoring to the next rather than leaving the case unread. A 429 lets that provider cool, as it
    // would after a person's turn.
    const judgeFor = (held: Job): Judge => {
      if (deps.fake) return fakeJudge;
      const clients = judgeClientsOf(deps.clients, readyEnough(deps.usage));
      if (!clients.length) return ({ messages }) => ask(held, messages);
      held.models.add(clients[0].name);
      return autoevalsJudge({
        clients, onCall: () => { held.calls += 1; },
        onLimited: (name, milliseconds) => { deps.usage.cool(name, milliseconds); },
      });
    };

    // Every case the framework has, put to the person whose case it is, with the brief that framework holds right
    // now. Serial, because they all go through the same free quota and the founder is watching the lines.
    async function testAll(held: Job, framework: Framework): Promise<RunCase[]> {
      const notes = await library.list();
      const noteIds = framework.notes.map((note) => note.id);
      const passagesFor = createPassages({
        recall, noteIds,
        titleOf: (id) => notes.find((note) => note.id === id)?.title ?? 'the founder\'s notes',
      });
      const judge = judgeFor(held);
      const done: RunCase[] = [];

      for (const room of framework.rooms) {
        const mine = framework.dataset.filter((kase: Case) => kase.keys.includes(room.key));
        if (!mine.length) continue;
        say(held, `${room.name}, ${room.role}: ${mine.length === 1 ? 'one case' : `${mine.length} cases`}.`);
        for (const kase of mine) {
          if (held.stop.signal.aborted) throw new Error('The evals were stopped.');
          const base = { id: kase.id, key: room.key, briefHash: briefHash(room.brief) };
          // An answer every provider refused is one failed case, written down with why, and the run goes on: one
          // person's bad minute is not a reason to lose the other twelve answers.
          const reply = await answerCase({
            team: framework, noteIds, key: room.key, brief: room.brief, input: kase.input,
            passages: await passagesFor(kase),
            store: deps.store, clients: deps.clients, usage: deps.usage, signal: held.stop.signal,
          }).catch((error: Error) => ({ failed: (error.message || 'no answer').replace(/\s+/g, ' ').slice(0, 300) }));
          held.calls += 1;
          if ('failed' in reply) {
            if (held.stop.signal.aborted) throw new Error('The evals were stopped.');
            done.push({ ...base, output: '', scores: {}, critique: '', failed: reply.failed });
            say(held, `${room.name} · ${kase.id} · failed — ${reply.failed}`);
            continue;
          }
          if (reply.provider) held.models.add(reply.provider);
          const output = reply.text.slice(0, MOST_OUTPUT);
          const judged = await scoreCase({ kase, output, brief: room.brief, chunks: (await passagesFor(kase)).map((one) => one.text) }, judge);
          done.push({ ...base, output, scores: judged.scores, critique: judged.critique, ...(judged.judged === false ? { judged: false as const } : {}) });
          say(held, `${room.name} · ${kase.id} · ${scoreWord(judged)}${judged.critique ? ` — ${judged.critique}` : ''}`);
        }
      }
      return done;
    }

    // The framework, with a run's scores written into it. One version up, because the founder's people are about to
    // start answering to a different number than they did this morning.
    const promoteInto = async (framework: Framework, run: Run) =>
      frameworks.save({ ...framework, version: (framework.version ?? 0) + 1, scorecard: scorecardOf(run) });

    // The whole experiment: run every case, decide, write the run down whatever it says, and promote only what the
    // rule allows. The run file is written before the framework is touched, so a promotion that failed half way
    // through still leaves the evidence of what happened.
    async function rerun(held: Job, framework: Framework) {
      const cases = await testAll(held, framework);
      const at = Date.now();
      const models = [...held.models].sort();
      const previous = await runs.lastPromoted(framework.id);
      const { run, promote, regressed, unscored } = settle(
        { at, version: framework.version ?? 1, models, cases, mean: meanOfCases(cases), calls: held.calls },
        previous, framework.scorecard?.mean,
      );
      await runs.write(framework.id, run);
      if (promote) await promoteInto(framework, run);
      held.state = 'done';
      const why = unscored.length
        ? `${unscored.length === 1 ? 'one case was' : `${unscored.length} cases were`} not scored`
        : regressed.length ? `${regressed.length === 1 ? 'one case went' : `${regressed.length} cases went`} backwards` : 'that is below what it scores now';
      say(held, promote
        ? `${framework.name} scored ${run.mean.toFixed(2)} on ${cases.length} ${cases.length === 1 ? 'case' : 'cases'}, in ${held.calls} calls. It is the framework's score now.`
        : `${framework.name} scored ${run.mean.toFixed(2)}, and ${why}. The run is kept, and nothing changed.`);
    }

    const failed = (held: Job, error: Error) => {
      if (job !== held) return;
      held.state = 'failed';
      held.error = error.message;
      say(held, error.message);
    };

    // Every run this framework has had, with the cases that went backwards worked out fresh. They are worked out
    // rather than stored because "backwards" is always relative to whatever was promoted before that run, and that
    // is a question about the list, not about one file.
    async function history(id: string): Promise<EvalsView> {
      const held = await runs.list(id);
      const lines = held.map((run, at) => {
        // The run that was on the framework when this one was made: the newest promoted one older than it.
        const before = held.slice(at + 1).find((one) => !one.rejected) ?? null;
        return lineOf(run, regressionsOf(run, before));
      });
      return { runs: lines, ...(job && job.id === id ? { job: view(job) } : {}) };
    }

    return {
      async route(req, res, path) {
        if (!path.startsWith('/api/frameworks/')) return false;
        const method = req.method ?? 'GET';

        const rerunning = RERUN.exec(path)?.[1];
        if (rerunning && method === 'POST') {
          const taken = busyWith(deps.workspace);
          if (taken) { deps.json(res, 409, { error: taken }); return true; }
          const framework = await frameworks.read(rerunning).catch(() => null);
          if (!framework) { deps.json(res, 404, { error: 'there is no framework by that name' }); return true; }
          if (!framework.dataset.length) { deps.json(res, 400, { error: 'This team has no test cases yet, so there is nothing to score it on.' }); return true; }
          const held: Job = { id: rerunning, state: 'testing', lines: [], calls: 0, models: new Set(), stop: new AbortController() };
          job = held;
          say(held, `Running ${framework.dataset.length === 1 ? 'one case' : `${framework.dataset.length} cases`} against ${framework.name} as it stands.`);
          // Answered at once and watched by the lines: a run of thirteen cases takes minutes, and holding the
          // request open would look like a page that had stopped.
          void rerun(held, framework).catch((error: Error) => failed(held, error));
          deps.json(res, 200, { jobId: held.id });
          return true;
        }

        const listing = RUNS.exec(path)?.[1];
        if (listing && method === 'GET') { deps.json(res, 200, await history(listing)); return true; }

        const forcing = PROMOTE.exec(path);
        if (forcing && method === 'POST') {
          const [, id, when] = forcing;
          const framework = await frameworks.read(id).catch(() => null);
          const run = await runs.find(id, Number(when));
          if (!framework || !run) { deps.json(res, 404, { error: 'there is no run of that framework at that moment' }); return true; }
          // The founder overruling the rule is written down as the founder overruling the rule: `forced` stays in
          // the file for good, so a scorecard nobody's arithmetic agreed with can never be mistaken for one it did.
          const kept: Run = { ...run, forced: true };
          await runs.write(id, kept);
          deps.json(res, 200, { framework: await promoteInto(framework, kept) });
          return true;
        }
        return false;
      },
      // A run left going when the app goes away stops where it is, and nothing is left answering for a workspace
      // that has closed.
      close: async () => { job?.stop.abort(); job = null; unclaim(); },
    };
  },
} satisfies Slice;
