import { mkdtemp } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Framework, Placed } from '../../shared/frameworks.ts';
import { seedStage, type Stage } from '../../shared/model.ts';
import { createFrameworks } from '../frameworks/store.ts';
import type { Deps } from '../install.ts';
import { createLibrary, inUse } from '../library/notes.ts';
import { createStore } from '../store.ts';
import slice from './frameworks.ts';

// The repository itself, because the built-ins the founder is given on a first start ship in it and this checks that
// they really arrive.
const root = resolve(import.meta.dirname, '../../..');
const BUILT_IN = 'startup-evaluation';
const NOTE = 'evaluating-a-startup-idea-first-time-founder-notes';
const BUILT_INS = ['customer-discovery', 'due-diligence', 'investor-update', 'launch-team', 'linkedin-content-system', 'pitch-practice', 'pmf-engine', 'pre-mortem', 'seed-round-prep', BUILT_IN, 'weekly-metrics'];
const NOTES = ['documents-that-moved-capital', NOTE, 'imagining-the-failure-first', 'linkedin-craft', 'linkedin-founder-led-content-system-notes-v2', 'measuring-product-market-fit', 'raising-a-seed-round',
  'reading-a-company-from-outside', 'talking-to-customers-without-leading-them', 'the-monthly-update', 'weekly-metrics-that-tell-the-truth', 'where-to-post-your-startup'];

// Everything the frameworks extra reaches for: a workspace, the stage as it is, and the two http helpers.
async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'frameworks-slice-'));
  const store = createStore(workspace);
  await store.loadStage();
  let asked: unknown = {};
  const answered: { status: number; body: any }[] = [];
  const deps = {
    workspace, root, fake: true, store,
    json: (_res: ServerResponse, status: number, body: unknown) => { answered.push({ status, body: body as any }); },
    body: async () => asked,
  } as unknown as Deps;
  const part = await slice.install(deps);
  const call = async (path: string, method = 'GET', said: unknown = {}) => {
    asked = said;
    const answer = await part.route!({ method } as IncomingMessage, {} as ServerResponse, path);
    return { answer, last: answered.at(-1)! };
  };
  return { workspace, store, part, call, library: createLibrary(workspace), frameworks: createFrameworks(workspace) };
}
// Every test here leaves the library knowing of nobody, because the hold on a note lives in a module both slices share.
afterEach(() => { inUse.by = () => null; });

describe('the frameworks extra', () => {
  it('gives the founder the built-in teams and their notes the first time the workspace opens', async () => {
    const { call, library } = await setup();
    const { answer, last } = await call('/api/frameworks');
    expect(answer).toBe(true);
    const listed = last.body as Framework[];
    expect(listed.map((one) => one.id).sort()).toEqual(BUILT_INS);
    expect(listed.find((one) => one.id === BUILT_IN)?.rooms).toHaveLength(5);
    expect((await library.list()).map((note) => note.id).sort()).toEqual(NOTES);
  });

  it('will not let the library drop a note a framework was built from', async () => {
    const { call, library } = await setup();
    await call('/api/frameworks');
    await expect(library.remove(NOTE)).rejects.toThrow('Startup evaluation');
    // And once the framework is gone, the note is the founder's to delete again.
    await call(`/api/frameworks/${BUILT_IN}`, 'DELETE');
    await library.remove(NOTE);
    expect((await library.list()).map((note) => note.id)).not.toContain(NOTE);
  });

  it('places the team on the stage with fresh ids, and writes the doc it shares', async () => {
    const { call, store } = await setup();
    const { last } = await call(`/api/frameworks/${BUILT_IN}/place`, 'POST', { at: { x: 400, y: 120 } });
    expect(last.status).toBe(200);
    const placed = last.body as Placed;
    expect(placed.rooms).toHaveLength(5);
    expect(placed.docs).toHaveLength(1);
    expect(placed.cards.map((card) => card.kind).sort()).toEqual(['browser', 'library']);
    expect(placed.wires).toHaveLength(16);
    // Nothing collides with what is already on the stage, and the group starts where it was asked to.
    const held = new Set([...seedStage.rooms, ...seedStage.docs].map((one) => one.id));
    for (const one of [...placed.rooms, ...placed.docs, ...placed.cards]) expect(held.has(one.id)).toBe(false);
    expect(Math.min(...placed.rooms.map((room) => room.x))).toBe(400);
    // The shared doc has its words before the card that shows it ever lands.
    expect(await store.readDoc(placed.docs[0].id)).toContain('## 1. Core assumption');
    expect((await call('/api/frameworks/nothing-here/place', 'POST', { at: { x: 0, y: 0 } })).last.status).toBe(404);
  });

  it('writes a framework from what is selected, and places it again as the same team', async () => {
    const { call, store, library } = await setup();
    await library.add({ title: 'Pricing', text: '# Pricing\n\nCharge for the value.', source: 'paste' });
    const placed = (await call(`/api/frameworks/${BUILT_IN}/place`, 'POST', { at: { x: 0, y: 0 } })).last.body as Placed;
    const stage: Stage = {
      rooms: [...seedStage.rooms, ...placed.rooms], docs: [...seedStage.docs, ...placed.docs],
      cards: placed.cards, wires: [...seedStage.wires, ...placed.wires],
    };
    await store.saveStage(stage);
    const ids = [...placed.rooms, ...placed.docs, ...placed.cards].map((one) => one.id);
    const saved = (await call('/api/frameworks/my-team', 'PUT', { name: 'My team', ids })).last.body as Framework;
    expect(saved.id).toBe('my-team');
    expect(saved.rooms).toHaveLength(5);
    expect(saved.wires).toHaveLength(16);
    // It remembers the founder's note, because the note card was part of what was selected.
    expect(saved.notes.map((note) => note.id)).toEqual([NOTE]);
    expect(saved.notes[0].hash).toHaveLength(40);
    // And the doc went in with the words it has now, not the words it shipped with.
    await store.writeDoc(placed.docs[0].id, '# Evaluation\n\nThe founder wrote this.');
    const again = (await call('/api/frameworks/my-team', 'PUT', { name: 'My team', ids })).last.body as Framework;
    expect(again.docs[0].text).toBe('# Evaluation\n\nThe founder wrote this.');
    expect(again.version).toBe(2);
    // Placed again it is the same team, with ids of its own once more.
    const twice = (await call('/api/frameworks/my-team/place', 'POST', { at: { x: 3000, y: 0 } })).last.body as Placed;
    expect(twice.rooms.map((room) => room.role)).toEqual(placed.rooms.map((room) => room.role));
    expect(twice.rooms.every((room) => !ids.includes(room.id))).toBe(true);
  });

  it('refuses a selection with nothing in it, and one with no name', async () => {
    const { call } = await setup();
    expect((await call('/api/frameworks/nothing', 'PUT', { name: 'Nothing', ids: [] })).last).toMatchObject({ status: 400, body: { error: expect.stringContaining('nothing selected') } });
    expect((await call('/api/frameworks/no-name', 'PUT', { name: '  ', ids: ['marketing'] })).last.status).toBe(400);
    expect(await createFrameworks((await setup()).workspace).read('nothing')).toBeNull();
  });

  it('takes a framework back with its test cases changed, and tidies what was typed', async () => {
    const { call, frameworks } = await setup();
    const framework = (await call(`/api/frameworks/${BUILT_IN}`)).last.body as Framework;
    const dataset = [
      ...framework.dataset.slice(0, 2),
      { id: 'A New One!', keys: ['verdict', 'verdict'], input: 'Judge this idea.', expected: 'WEAK', addedBy: 'nobody' },
      { keys: [], input: 'x'.repeat(5000) },
    ];
    const saved = (await call(`/api/frameworks/${BUILT_IN}`, 'PUT', { ...framework, dataset })).last.body as Framework;
    expect(saved.dataset).toHaveLength(4);
    expect(saved.dataset[2]).toEqual({ id: 'a-new-one', keys: ['verdict'], input: 'Judge this idea.', expected: 'WEAK', addedBy: 'founder' });
    expect(saved.dataset[3].id).toBe('case-4');
    expect(saved.dataset[3].input).toHaveLength(4000);
    expect((await frameworks.read(BUILT_IN))?.dataset).toHaveLength(4);
    // And the people are still there: saving the cases must never quietly empty the team.
    expect(saved.rooms).toHaveLength(5);
  });

  it('answers nothing about paths that are not its own', async () => {
    const { call } = await setup();
    expect((await call('/api/frameworks/Not An Id', 'GET')).answer).toBe(false);
    expect((await call('/api/frameworks', 'DELETE')).answer).toBe(false);
  });

  it('lets the note go again once the extra has been closed', async () => {
    const { call, part } = await setup();
    await call('/api/frameworks');
    expect(inUse.by(NOTE)).toBe('Startup evaluation');
    await part.close!();
    expect(inUse.by(NOTE)).toBeNull();
  });
});
