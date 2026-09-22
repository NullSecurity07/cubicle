import { mkdtemp } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EvalsView, Run } from '../../shared/evals.ts';
import type { Framework } from '../../shared/frameworks.ts';
import { createRunStore } from '../evals/store.ts';
import { createFrameworks } from '../frameworks/store.ts';
import type { Deps } from '../install.ts';
import { createLibrary } from '../library/notes.ts';
import { fakeClient } from '../providers.ts';
import { createStore } from '../store.ts';
import { createUsage } from '../usage.ts';
import forge from './forge.ts';
import slice from './evals.ts';

const root = resolve(import.meta.dirname, '../../..');
const NOTE = `# Evaluating a Startup Idea

## 1. Core assumption

Name the one belief that, if false, makes everything else irrelevant.

## 2. The verdict

Three outcomes and no fourth: STRONG, WEAK, PIVOT REQUIRED.
`;

// A small team with two people and one case each: enough to have a mean, a person's share of it and a case that can
// be made to go backwards, and small enough that a whole run is a second.
const team = (over: Partial<Framework> = {}): Framework => ({
  id: 'small-team', name: 'Small team', intent: 'a team that tests a thing', version: 1, builtAt: 1000,
  notes: [{ id: 'evaluating-a-startup-idea', hash: 'whatever' }],
  rooms: [
    { key: 'finder', name: 'Ada', role: 'Assumption finder', accent: '#4e8cff', brief: 'Name the one belief the idea rests on.', w: 380, h: 440 },
    { key: 'judge', name: 'Bruno', role: 'Verdict judge', accent: '#e6a93c', brief: 'Three allowed outcomes. STRONG: it holds. WEAK: a step fails.', w: 380, h: 440 },
  ],
  docs: [{ key: 'working', title: 'Working notes', text: '# Working notes\n' }],
  cards: [], wires: [{ from: 'finder', to: 'working' }],
  layout: { finder: { x: 0, y: 0 }, judge: { x: 460, y: 0 }, working: { x: 0, y: 500 } },
  dataset: [
    { id: 'first-case', keys: ['finder'], input: 'Name the core assumption of renting a spare room.', rubric: 'One falsifiable sentence.', addedBy: 'founder' },
    { id: 'second-case', keys: ['judge'], input: 'The assumption holds and the pain is real. Verdict?', expected: 'STRONG', addedBy: 'founder' },
  ],
  ...over,
});

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'evals-slice-'));
  const store = createStore(workspace);
  await store.loadStage();
  const library = createLibrary(workspace);
  await library.add({ title: 'Evaluating a Startup Idea', text: NOTE, source: 'paste' });
  const frameworks = createFrameworks(workspace);
  let asked: unknown = {};
  const answered: { status: number; body: any }[] = [];
  const deps = {
    workspace, root, fake: true, store, clients: [fakeClient], usage: createUsage(null),
    json: (_res: ServerResponse, status: number, body: unknown) => { answered.push({ status, body: body as any }); },
    body: async () => asked,
  } as unknown as Deps;
  const part = await slice.install(deps);
  const call = async (path: string, method = 'GET', said: unknown = {}) => {
    asked = said;
    const answer = await part.route!({ method } as IncomingMessage, {} as ServerResponse, path);
    return { answer, last: answered.at(-1)! };
  };
  // A rerun answers the founder at once and goes on working, so everything after it waits for the lines to stop.
  const settled = async (id: string): Promise<EvalsView> => {
    for (let tries = 0; tries < 800; tries += 1) {
      const held = (await call(`/api/frameworks/${id}/runs`)).last.body as EvalsView;
      if (!held.job || held.job.state !== 'testing') {
        if (held.job?.state === 'failed') throw new Error(`the evals failed: ${held.job.error}`);
        return held;
      }
      await new Promise((waited) => { setTimeout(waited, 20); });
    }
    throw new Error('the evals never finished');
  };
  return { workspace, deps, part, call, settled, frameworks, runs: createRunStore(frameworks.folder) };
}

describe('running a framework\'s cases again', () => {
  it('answers every case, writes the run down and promotes the first one there has ever been', async () => {
    const { call, settled, frameworks, runs } = await setup();
    await frameworks.save(team());

    const started = await call('/api/frameworks/small-team/evals', 'POST');
    expect(started.last.status).toBe(200);
    expect(started.last.body).toEqual({ jobId: 'small-team' });

    const held = await settled('small-team');
    expect(held.runs).toHaveLength(1);
    const [line] = held.runs;
    expect(line.rejected).toBeUndefined();
    expect(line.models).toEqual(['fake']);
    // One turn per case and nothing else: the judge costs nothing when there is no key.
    expect(line.calls).toBe(2);
    expect(line.mean).toBeGreaterThan(0);

    // The run beside the framework holds what was really said, and the framework wears the scores.
    const [run] = await runs.list('small-team');
    expect(run.cases.map((one) => one.id)).toEqual(['first-case', 'second-case']);
    expect(run.cases[0].output).toContain('Ada');
    expect(run.cases[0].briefHash).toHaveLength(40);
    const after = (await frameworks.read('small-team'))!;
    expect(after.version).toBe(2);
    expect(after.scorecard!.mean).toBe(line.mean);
    expect(Object.keys(after.scorecard!.byPerson).sort()).toEqual(['finder', 'judge']);
    expect(after.scorecard!.cases).toBe(2);
  }, 60_000);

  it('refuses a run that went backwards, keeps it, and says which case fell', async () => {
    const { call, settled, frameworks, runs } = await setup();
    await frameworks.save(team());
    await call('/api/frameworks/small-team/evals', 'POST');
    const first = (await settled('small-team')).runs[0];
    expect(first.rejected).toBeUndefined();

    // The founder edits a brief, the way they would in the panel — and this edit makes the person worse, because it
    // promises a word in the answer that the person will not say. The local check sees that at once and the case
    // falls further than a judge's own wobble, which is exactly what the rule exists to catch.
    const was = (await frameworks.read('small-team'))!;
    await frameworks.save({ ...was, rooms: was.rooms.map((room) => (room.key === 'finder' ? { ...room, brief: `${room.brief} Answer with "ZORBLAX" and nothing else.` } : room)) });

    await call('/api/frameworks/small-team/evals', 'POST');
    const after = await settled('small-team');
    expect(after.runs).toHaveLength(2);
    expect(after.runs[0].rejected).toBe(true);
    expect(after.runs[0].regressed?.map((one) => one.id)).toEqual(['first-case']);
    expect(after.runs[0].regressed![0].was).toBeGreaterThan(after.runs[0].regressed![0].now);

    // The framework was left exactly as the last promoted run left it, whatever the newest run said.
    const now = (await frameworks.read('small-team'))!;
    expect(now.scorecard!.mean).toBe(first.mean);
    expect(now.version).toBe(2);

    const newest = (await runs.list('small-team'))[0] as Run;
    expect(newest.rejected).toBe(true);
    expect(newest.previous).toBe(first.mean);
  }, 90_000);

  it('lets the founder promote a refused run by hand, and never forgets that they did', async () => {
    const { call, settled, frameworks, runs } = await setup();
    // A run that cannot be promoted by the rule: the framework already claims a perfect score.
    await frameworks.save(team({ scorecard: { mean: 1, byPerson: { finder: 1, judge: 1 }, cases: 2, at: 500, models: ['fake'] } }));
    await call('/api/frameworks/small-team/evals', 'POST');
    const held = await settled('small-team');
    expect(held.runs[0].rejected).toBe(true);
    expect((await frameworks.read('small-team'))!.version).toBe(1);

    const forced = await call(`/api/frameworks/small-team/runs/${held.runs[0].at}/promote`, 'POST');
    expect(forced.last.status).toBe(200);
    const after = (forced.last.body as { framework: Framework }).framework;
    expect(after.version).toBe(2);
    expect(after.scorecard!.mean).toBe(held.runs[0].mean);
    // The file says the founder overruled the rule, and goes on saying it.
    expect((await runs.list('small-team'))[0].forced).toBe(true);
    expect((await call('/api/frameworks/small-team/runs')).last.body.runs[0].forced).toBe(true);
  }, 60_000);

  it('holds the rule against a run whose mean rose while one case fell off a cliff', async () => {
    const { runs, frameworks, call, settled } = await setup();
    await frameworks.save(team());
    await call('/api/frameworks/small-team/evals', 'POST');
    await settled('small-team');
    // Written by hand, because a stand-in judge cannot be talked into a cliff: the rule is what is under test.
    const [promoted] = await runs.list('small-team');
    await runs.write('small-team', {
      at: Date.now(), version: 2, models: ['fake'], calls: 2,
      cases: [{ ...promoted.cases[0], scores: { format: 0 } }, { ...promoted.cases[1], scores: { format: 1 } }],
      mean: 0.5, rejected: true,
    });
    const listed = (await call('/api/frameworks/small-team/runs')).last.body as EvalsView;
    expect(listed.runs[0].regressed?.map((one) => one.id)).toEqual([promoted.cases[0].id]);
  }, 60_000);
});

describe('what the evals refuse to do', () => {
  it('knows nothing of a framework that is not there, and will not score one with no cases', async () => {
    const { call, frameworks } = await setup();
    expect((await call('/api/frameworks/nobody/evals', 'POST')).last.status).toBe(404);
    await frameworks.save(team({ dataset: [] }));
    const empty = await call('/api/frameworks/small-team/evals', 'POST');
    expect(empty.last.status).toBe(400);
    expect(empty.last.body.error).toContain('no test cases');
    expect((await call('/api/frameworks/small-team/runs/1700000000000/promote', 'POST')).last.status).toBe(404);
  });

  it('leaves paths that are not its own to whoever comes next', async () => {
    const { call } = await setup();
    expect((await call('/api/frameworks')).answer).toBe(false);
    expect((await call('/api/frameworks/small-team')).answer).toBe(false);
    expect((await call('/api/frameworks/small-team/place', 'POST')).answer).toBe(false);
  });

  it('waits for the forge rather than running beside it, and the forge waits for it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'evals-lock-'));
    const store = createStore(workspace);
    await store.loadStage();
    const library = createLibrary(workspace);
    const note = await library.add({ title: 'Evaluating a Startup Idea', text: NOTE, source: 'paste' });
    const frameworks = createFrameworks(workspace);
    await frameworks.save(team());
    let asked: unknown = {};
    const answered: { status: number; body: any }[] = [];
    const deps = {
      workspace, root, fake: true, store, clients: [fakeClient], usage: createUsage(null),
      json: (_res: ServerResponse, status: number, body: unknown) => { answered.push({ status, body: body as any }); },
      body: async () => asked,
    } as unknown as Deps;
    const evals = await slice.install(deps);
    const built = await forge.install(deps);
    const post = async (part: typeof evals, path: string, said: unknown = {}) => {
      asked = said;
      await part.route!({ method: 'POST' } as IncomingMessage, {} as ServerResponse, path);
      return answered.at(-1)!;
    };

    expect((await post(evals, '/api/frameworks/small-team/evals')).status).toBe(200);
    // The forge is turned away while the evals are running, in the evals' own words.
    const turned = await post(built, '/api/forge/propose', { noteIds: [note.id], intent: 'a team', mode: 'quick' });
    expect(turned.status).toBe(409);
    expect(turned.body.error).toContain('evals are already running');
    await evals.close!();
    await built.close!();
  }, 60_000);
});
