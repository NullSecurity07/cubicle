import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Framework } from '../../shared/frameworks.ts';
import { createLibrary } from '../library/notes.ts';
import { copyBuiltIns, createFrameworks, takeUpdate, updatesOf } from './store.ts';
import { contentHash } from './shipped.ts';

const NOTE = '# Evaluating an idea\n\nStep one: find the core assumption, written as a falsifiable sentence.\n';
const team = (extra: Partial<Framework> = {}): Framework => ({
  id: 'pressure-test', name: 'Pressure test', intent: 'Pressure-test an idea.', version: 1, builtAt: 1,
  notes: [{ id: 'evaluating-an-idea', hash: 'nothash' }],
  rooms: [{ key: 'assumption', name: 'Ananya', role: 'Assumption finder', accent: '#ee8a72', brief: 'Find the one belief.', w: 380, h: 440 }],
  docs: [{ key: 'evaluation', title: 'Evaluation', text: '# Evaluation\n' }],
  cards: [{ key: 'notes', kind: 'library', noteId: 'evaluating-an-idea', w: 260, h: 180 }],
  wires: [{ from: 'notes', to: 'assumption' }],
  layout: { notes: { x: 0, y: 0 }, assumption: { x: 0, y: 230 } },
  dataset: [], ...extra,
});

// A folder shaped like `app/frameworks` in the repository: one framework, and the note it was built from beside it.
async function builtIns(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'built-in-'));
  await mkdir(join(dir, 'pressure-test', 'notes'), { recursive: true });
  await writeFile(join(dir, 'pressure-test', 'framework.json'), JSON.stringify(team(), null, 2));
  await writeFile(join(dir, 'pressure-test', 'notes', 'evaluation-notes.md'), NOTE);
  // Something that is not a framework at all, to be walked past rather than tripped over.
  await mkdir(join(dir, 'half-finished'), { recursive: true });
  return dir;
}
const setup = async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'frameworks-'));
  return { workspace, frameworks: createFrameworks(workspace), library: createLibrary(workspace) };
};

describe('the frameworks a workspace holds', () => {
  it('writes one as a file of its own and reads it back', async () => {
    const { workspace, frameworks } = await setup();
    await frameworks.save(team());
    expect(JSON.parse(await readFile(join(workspace, 'frameworks', 'pressure-test', 'framework.json'), 'utf8')).name).toBe('Pressure test');
    expect((await frameworks.read('pressure-test'))?.rooms[0].name).toBe('Ananya');
    expect((await frameworks.list()).map((one) => one.id)).toEqual(['pressure-test']);
    expect(await frameworks.read('nothing-here')).toBeNull();
  });

  it('lists the newest first and lets one go', async () => {
    const { frameworks } = await setup();
    await frameworks.save(team());
    await frameworks.save(team({ id: 'second-team', name: 'Second team', builtAt: 5 }));
    expect((await frameworks.list()).map((one) => one.id)).toEqual(['second-team', 'pressure-test']);
    await frameworks.remove('pressure-test');
    expect((await frameworks.list()).map((one) => one.id)).toEqual(['second-team']);
  });

  it('walks past a file somebody broke by hand instead of refusing to list anything', async () => {
    const { workspace, frameworks } = await setup();
    await frameworks.save(team());
    await mkdir(join(workspace, 'frameworks', 'nonsense'), { recursive: true });
    await writeFile(join(workspace, 'frameworks', 'nonsense', 'framework.json'), '{ not json');
    expect((await frameworks.list()).map((one) => one.id)).toEqual(['pressure-test']);
  });

  it('says which framework holds a note, so the library can refuse to let it go', async () => {
    const { frameworks } = await setup();
    await frameworks.save(team());
    expect((await frameworks.holders()).get('evaluating-an-idea')).toBe('Pressure test');
    expect((await frameworks.holders()).get('hiring-notes')).toBeUndefined();
  });

  it('refuses a name that is not a framework id at all', async () => {
    const { frameworks } = await setup();
    await expect(frameworks.save(team({ id: '../escape' }))).rejects.toThrow('bad id');
    await expect(frameworks.read('../escape')).rejects.toThrow('bad id');
  });
});

describe('the built-in frameworks', () => {
  it('copies them in on a first start, with the notes they were built from', async () => {
    const { frameworks, library } = await setup();
    expect(await copyBuiltIns(await builtIns(), frameworks, library)).toEqual(['pressure-test']);
    expect((await frameworks.list()).map((one) => one.name)).toEqual(['Pressure test']);
    const notes = await library.list();
    expect(notes.map((note) => note.id)).toEqual(['evaluating-an-idea']);
    expect(notes[0].source).toBe('file');
    expect(notes[0].title).toBe('Evaluating an idea');
    expect(await library.read('evaluating-an-idea')).toBe(NOTE);
  });

  it('copies nothing the second time, so what the founder changed stays changed', async () => {
    const { frameworks, library } = await setup();
    const from = await builtIns();
    await copyBuiltIns(from, frameworks, library);
    await frameworks.save(team({ intent: 'Changed by the founder.', dataset: [{ id: 'mine', keys: ['assumption'], input: 'Judge this.', addedBy: 'founder' }] }));
    expect(await copyBuiltIns(from, frameworks, library)).toEqual([]);
    const held = await frameworks.read('pressure-test');
    expect(held?.intent).toBe('Changed by the founder.');
    expect(held?.dataset).toHaveLength(1);
    expect(await library.list()).toHaveLength(1);
  });

  it('puts a copy made before there were shelves on its shelf, and changes nothing else of it', async () => {
    const { workspace, frameworks, library } = await setup();
    const from = await builtIns();
    await copyBuiltIns(from, frameworks, library);
    await frameworks.save(team({ intent: 'Changed by the founder.' }));
    await writeFile(join(from, 'pressure-test', 'framework.json'), JSON.stringify(team({ stage: 'Find out', intent: 'Shipped words.' }), null, 2));
    await copyBuiltIns(from, frameworks, library);
    const held = JSON.parse(await readFile(join(workspace, 'frameworks', 'pressure-test', 'framework.json'), 'utf8')) as Framework;
    expect(held.stage).toBe('Find out');
    expect(held.intent).toBe('Changed by the founder.');
    // A shelf the founder chose is theirs as well.
    await frameworks.save({ ...held, stage: 'Raise' });
    await copyBuiltIns(from, frameworks, library);
    expect((await frameworks.read('pressure-test'))?.stage).toBe('Raise');
  });

  it('leaves a note the founder already has under that title alone', async () => {
    const { frameworks, library } = await setup();
    await library.add({ title: 'Evaluating an idea', text: 'My own words.', source: 'paste' });
    await copyBuiltIns(await builtIns(), frameworks, library);
    expect(await library.read('evaluating-an-idea')).toBe('My own words.');
    expect(await library.list()).toHaveLength(1);
  });

  it('is nothing at all when the repository has no built-ins to copy', async () => {
    const { frameworks, library } = await setup();
    expect(await copyBuiltIns(join(tmpdir(), 'not-a-folder-at-all'), frameworks, library)).toEqual([]);
    expect(await frameworks.list()).toEqual([]);
  });
});

// A built-in team that has moved on since the workspace copied it: the ledger remembers the old version's content, and
// the folder holds today's. The old one is the same team with an older brief, the way the live-teams run left them.
const OLD = team({ rooms: [{ ...team().rooms[0], brief: 'Find the belief. (old brief)' }] });
const NEW_BRIEF = 'Find the one belief. Never invent a number.';
async function movedOn(): Promise<string> {
  const dir = await builtIns();
  const today = team({ rooms: [{ ...team().rooms[0], brief: NEW_BRIEF }] });
  await writeFile(join(dir, 'pressure-test', 'framework.json'), JSON.stringify(today, null, 2));
  const hashOf = (one: Framework) => contentHash(one as unknown as Record<string, unknown>);
  await writeFile(join(dir, 'shipped.json'), JSON.stringify({ 'pressure-test': [hashOf(OLD), hashOf(today)] }));
  return dir;
}
const trashed = async (workspace: string) => (await readdir(join(workspace, 'trash')).catch(() => [] as string[])).filter((name) => name.endsWith('-framework-pressure-test.json'));
const briefOf = async (frameworks: ReturnType<typeof createFrameworks>) => (await frameworks.read('pressure-test'))?.rooms[0].brief;

describe('a built-in team that changed since the workspace copied it', () => {
  it('replaces a copy nobody touched with today\'s team, and keeps the old one in trash', async () => {
    const { workspace, frameworks, library } = await setup();
    await frameworks.save(OLD);
    // Promoting a run bumps the version and writes a scorecard: the app's bookkeeping, never the founder's edit.
    await frameworks.save({ ...OLD, version: 3, scorecard: { mean: 0.8, byPerson: {}, cases: 1, at: 1, models: [] } });
    expect(await copyBuiltIns(await movedOn(), frameworks, library)).toEqual(['pressure-test']);
    expect(await briefOf(frameworks)).toBe(NEW_BRIEF);
    expect((await frameworks.read('pressure-test'))?.shippedHash).toMatch(/^[0-9a-f]{16}$/);
    expect(await trashed(workspace)).toHaveLength(1);
    expect(await updatesOf(await movedOn(), frameworks)).toEqual(new Set());
  });

  it('does not count a shelf as a change: a copy from before shelves is still untouched, and gets its shelf', async () => {
    const { frameworks, library } = await setup();
    const dir = await builtIns();
    const shipped = team({ stage: 'Find out' });
    await writeFile(join(dir, 'pressure-test', 'framework.json'), JSON.stringify(shipped, null, 2));
    await writeFile(join(dir, 'shipped.json'), JSON.stringify({ 'pressure-test': [contentHash(shipped as unknown as Record<string, unknown>)] }));
    expect(contentHash(team() as unknown as Record<string, unknown>)).toBe(contentHash(shipped as unknown as Record<string, unknown>));
    await frameworks.save(team());
    expect(await copyBuiltIns(dir, frameworks, library)).toEqual([]);
    expect((await frameworks.read('pressure-test'))?.stage).toBe('Find out');
    expect(await updatesOf(dir, frameworks)).toEqual(new Set());
  });

  it('keeps a copy the founder edited and marks it as having an update', async () => {
    const { frameworks, library } = await setup();
    const from = await movedOn();
    await frameworks.save({ ...OLD, intent: 'Changed by the founder.' });
    expect(await copyBuiltIns(from, frameworks, library)).toEqual([]);
    expect((await frameworks.read('pressure-test'))?.intent).toBe('Changed by the founder.');
    expect(await updatesOf(from, frameworks)).toEqual(new Set(['pressure-test']));
  });

  it('takes the update on the founder\'s press: today\'s team in place, their copy in trash', async () => {
    const { workspace, frameworks, library } = await setup();
    const from = await movedOn();
    await frameworks.save({ ...OLD, intent: 'Changed by the founder.' });
    await copyBuiltIns(from, frameworks, library);
    const taken = await takeUpdate(from, 'pressure-test', frameworks, library);
    expect(taken?.rooms[0].brief).toBe(NEW_BRIEF);
    expect(taken?.intent).toBe('Pressure-test an idea.');
    expect(await trashed(workspace)).toHaveLength(1);
    expect(JSON.parse(await readFile(join(workspace, 'trash', (await trashed(workspace))[0]), 'utf8')).intent).toBe('Changed by the founder.');
    expect(await updatesOf(from, frameworks)).toEqual(new Set());
    expect(await takeUpdate(from, 'no-such-team', frameworks, library)).toBeNull();
  });

  it('stamps a copy from before stamping whose content is today\'s team, and leaves every word of it', async () => {
    const { workspace, frameworks, library } = await setup();
    const from = await movedOn();
    const today = JSON.parse(await readFile(join(from, 'pressure-test', 'framework.json'), 'utf8')) as Framework;
    await frameworks.save(today);
    expect((await frameworks.read('pressure-test'))?.shippedHash).toBeUndefined();
    expect(await copyBuiltIns(from, frameworks, library)).toEqual([]);
    const held = await frameworks.read('pressure-test');
    expect(held?.shippedHash).toBe(contentHash(today as unknown as Record<string, unknown>));
    expect(held?.rooms[0].brief).toBe(NEW_BRIEF);
    expect(await trashed(workspace)).toHaveLength(0);
    // Edited after stamping, with nothing newer shipped: simply the founder's, and no update is offered.
    await frameworks.save({ ...held!, intent: 'Mine now.' });
    expect(await updatesOf(from, frameworks)).toEqual(new Set());
  });

  it('never writes over a copy broken by hand, and never saves the list\'s update mark', async () => {
    const { workspace, frameworks, library } = await setup();
    await mkdir(join(workspace, 'frameworks', 'pressure-test'), { recursive: true });
    await writeFile(join(workspace, 'frameworks', 'pressure-test', 'framework.json'), '{ half');
    expect(await copyBuiltIns(await movedOn(), frameworks, library)).toEqual([]);
    expect(await readFile(join(workspace, 'frameworks', 'pressure-test', 'framework.json'), 'utf8')).toBe('{ half');
    await frameworks.save({ ...team(), update: true });
    expect(JSON.parse(await readFile(join(workspace, 'frameworks', 'pressure-test', 'framework.json'), 'utf8')).update).toBeUndefined();
  });
});
