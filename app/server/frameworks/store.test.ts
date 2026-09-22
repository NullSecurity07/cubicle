import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Framework } from '../../shared/frameworks.ts';
import { createLibrary } from '../library/notes.ts';
import { copyBuiltIns, createFrameworks } from './store.ts';

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
