import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ForgeJob } from '../../shared/forge.ts';
import type { Framework } from '../../shared/frameworks.ts';
import { hub } from '../events.ts';
import { createFrameworks } from '../frameworks/store.ts';
import type { Deps } from '../install.ts';
import { createLibrary } from '../library/notes.ts';
import { fakeClient } from '../providers.ts';
import { createStore } from '../store.ts';
import { createUsage } from '../usage.ts';
import slice from './forge.ts';

const root = resolve(import.meta.dirname, '../../..');
// A note the founder might really have written: headings to find the way around by, and a worked example under each.
const NOTE = `# Evaluating a Startup Idea

## 1. Core assumption

Name the one belief that, if false, makes everything else irrelevant. Write it as a sentence that could be shown to
be false. "People want better budgeting" is too vague. "Freelancers earning $3-10k a month will pay $15 a month to
separate their tax money" can be tested next week.

## 2. Fatal flaws

Name exactly three ways it dies, each one specific to this idea and this customer. "Competition is tough" fits every
startup and is worth nothing.

## 3. The verdict

Three outcomes and no fourth: STRONG, WEAK, PIVOT REQUIRED. Say which, in one word, and then why in two lines.
`;

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'forge-slice-'));
  const store = createStore(workspace);
  await store.loadStage();
  const library = createLibrary(workspace);
  const note = await library.add({ title: 'Evaluating a Startup Idea', text: NOTE, source: 'paste' });
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
  // Waits for the job to reach a state, because everything the forge does happens after the founder was answered.
  const until = async (id: string, want: ForgeJob['state']): Promise<ForgeJob> => {
    for (let tries = 0; tries < 600; tries += 1) {
      const job = (await call(`/api/forge/${id}`)).last.body as ForgeJob;
      if (job.state === want) return job;
      if (job.state === 'failed') throw new Error(`the forge failed: ${job.error}`);
      await new Promise((waited) => { setTimeout(waited, 20); });
    }
    throw new Error('the forge never got there');
  };
  return { workspace, store, part, call, until, note, frameworks: createFrameworks(workspace) };
}

describe('the forge', () => {
  it('reads a note, proposes a team, builds it and saves it with its scorecard', async () => {
    const { call, until, note, frameworks, workspace } = await setup();
    const started = await call('/api/forge/propose', 'POST', { noteIds: [note.id], intent: 'a team that pressure-tests an idea', mode: 'quick' });
    expect(started.last.status).toBe(200);
    const { jobId } = started.last.body as { jobId: string };

    const ready = await until(jobId, 'previewing');
    expect(ready.proposal?.rooms).toHaveLength(2);
    expect(ready.proposal?.rooms[0].brief).toContain('1. Core assumption');
    expect(ready.proposal?.dataset).toHaveLength(2);
    // One call to propose a team, and the lines say what happened.
    expect(ready.calls).toBe(1);
    expect(ready.lines.join(' ')).toContain('Evaluating a Startup Idea');

    // The founder changes a name in the preview and presses Build.
    const proposal = { ...ready.proposal!, rooms: ready.proposal!.rooms.map((person, index) => (index ? person : { ...person, name: 'Nadia' })) };
    expect((await call('/api/forge/build', 'POST', { jobId, proposal, mode: 'quick' })).last.status).toBe(200);
    const done = await until(jobId, 'done');

    // One case each, so one turn each, on top of the call that proposed them. The judge costs nothing in fake mode.
    expect(done.calls).toBe(3);
    const framework = done.framework!;
    expect(framework.rooms[0].name).toBe('Nadia');
    expect(framework.notes).toEqual([{ id: note.id, hash: note.hash }]);
    expect(framework.version).toBe(1);
    expect(framework.scorecard?.cases).toBe(2);
    expect(Object.keys(framework.scorecard!.byPerson).sort()).toEqual(['finder', 'judge']);
    expect(framework.scorecard!.mean).toBeGreaterThan(0);
    expect(done.critiques?.finder).toBeTruthy();
    // And it is really on disk, with the note wired to everybody.
    const saved = await frameworks.read(framework.id) as Framework;
    expect(saved.name).toBe(framework.name);
    expect(saved.cards.some((card) => card.kind === 'library')).toBe(true);
    expect(saved.wires.filter((wire) => wire.from === 'notes')).toHaveLength(2);

    // The run is written down beside the framework, in the shape the evals round reads.
    const runs = await readdir(join(workspace, 'frameworks', framework.id, 'runs'));
    expect(runs).toHaveLength(1);
    const run = JSON.parse(await readFile(join(workspace, 'frameworks', framework.id, 'runs', runs[0]), 'utf8'));
    expect(Object.keys(run).sort()).toEqual(['at', 'calls', 'cases', 'mean', 'mode', 'models', 'version']);
    // What the build really cost is kept with the scores: a run the founder reads a month later says what it took.
    expect(run.calls).toBe(done.calls);
    expect(run.cases).toHaveLength(2);
    expect(run.cases[0]).toMatchObject({ key: 'finder', id: 'first-case' });
    expect(run.cases[0].briefHash).toHaveLength(40);
    expect(run.models).toEqual(['fake']);
    expect(run.mean).toBe(framework.scorecard!.mean);
  }, 60_000);

  it('says every line on the window\'s one live feed as well', async () => {
    const { call, until, note } = await setup();
    const heard: { channel: string; data: any }[] = [];
    const was = hub.say;
    hub.say = (channel, data) => heard.push({ channel, data });
    try {
      const { jobId } = (await call('/api/forge/propose', 'POST', { noteIds: [note.id], intent: 'a team', mode: 'quick' })).last.body as { jobId: string };
      const ready = await until(jobId, 'previewing');
      const mine = heard.filter((one) => one.channel === 'forge');
      expect(mine.map((one) => one.data.line)).toEqual(ready.lines);
      expect(mine[0].data).toMatchObject({ kind: 'forge', jobId });
    } finally { hub.say = was; }
  }, 30_000);

  it('forges one team at a time', async () => {
    const { call, until, note } = await setup();
    const { jobId } = (await call('/api/forge/propose', 'POST', { noteIds: [note.id], intent: 'one', mode: 'quick' })).last.body as { jobId: string };
    const second = await call('/api/forge/propose', 'POST', { noteIds: [note.id], intent: 'two', mode: 'quick' });
    expect(second.last).toMatchObject({ status: 409, body: { error: expect.stringContaining('already busy'), jobId } });
    // Once the first is waiting for the founder, a second may start and takes its place.
    await until(jobId, 'previewing');
    const third = await call('/api/forge/propose', 'POST', { noteIds: [note.id], intent: 'three', mode: 'quick' });
    expect(third.last.status).toBe(200);
    expect((third.last.body as { jobId: string }).jobId).not.toBe(jobId);
    expect((await call(`/api/forge/${jobId}`)).last.status).toBe(404);
  }, 30_000);

  it('asks for a note to build from, and knows nothing of a job it never had', async () => {
    const { call } = await setup();
    expect((await call('/api/forge/propose', 'POST', { noteIds: [], intent: 'nothing' })).last).toMatchObject({ status: 400, body: { error: expect.stringContaining('at least one note') } });
    expect((await call('/api/forge/forge-nobody')).last.status).toBe(404);
    expect((await call('/api/forge/build', 'POST', { jobId: 'forge-nobody' })).last.status).toBe(404);
    expect((await call('/api/forge/forge-nobody/stop', 'POST')).last.status).toBe(404);
    expect((await call('/api/forge/forge-nobody/runs')).answer).toBe(false);
    expect((await call('/api/forge/forge-nobody', 'DELETE')).answer).toBe(false);
  });

  it('fails readably when the note has gone, and lets the founder start again', async () => {
    const { call, until, note } = await setup();
    const { jobId } = (await call('/api/forge/propose', 'POST', { noteIds: ['nothing-like-this'], intent: 'x' })).last.body as { jobId: string };
    for (let tries = 0; tries < 200; tries += 1) {
      const job = (await call(`/api/forge/${jobId}`)).last.body as ForgeJob;
      if (job.state === 'failed') { expect(job.error).toContain('not in the library'); break; }
      await new Promise((waited) => { setTimeout(waited, 20); });
    }
    const again = (await call('/api/forge/propose', 'POST', { noteIds: [note.id], intent: 'again', mode: 'quick' })).last;
    expect(again.status).toBe(200);
    await until((again.body as { jobId: string }).jobId, 'previewing');
  }, 30_000);

  it('stops a build where it is', async () => {
    const { call, until, note } = await setup();
    const { jobId } = (await call('/api/forge/propose', 'POST', { noteIds: [note.id], intent: 'a team', mode: 'quick' })).last.body as { jobId: string };
    const ready = await until(jobId, 'previewing');
    await call('/api/forge/build', 'POST', { jobId, proposal: ready.proposal, mode: 'quick' });
    expect((await call(`/api/forge/${jobId}/stop`, 'POST')).last.status).toBe(200);
    for (let tries = 0; tries < 300; tries += 1) {
      const job = (await call(`/api/forge/${jobId}`)).last.body as ForgeJob;
      if (job.state === 'failed') { expect(job.error).toContain('stopped'); return; }
      if (job.state === 'done') throw new Error('the forge finished after it was stopped');
      await new Promise((waited) => { setTimeout(waited, 20); });
    }
    throw new Error('the forge never stopped');
  }, 30_000);
});
