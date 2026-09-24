import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Stage } from '../shared/model.ts';
import { forgetWhich, newId, offerWhenWired, patchStageVia, which, whichAsync } from './slice-kit.ts';
import { createStore } from './store.ts';
import type { Tool } from './tools/registry.ts';

const tool = (name: string) => ({ name, description: name, parameters: {}, async run() { return { text: name }; } }) as Tool;

describe('ids', () => {
  it('keeps each caller\'s prefix and shape', () => {
    expect(newId('forge-')).toMatch(/^forge-[a-z0-9]+-[a-z0-9]{1,4}$/);
    expect(newId('lead-', 4, '')).toMatch(/^lead-[a-z0-9]{5,}$/);
    expect(newId('rule-', 6, '-', 36 ** 3)).toMatch(/^rule-1000-[a-z0-9]{1,6}$/);
    expect(newId('h-')).not.toBe(newId('h-'));
  });
});

describe('finding a program', () => {
  it('looks in the caller\'s own folders first, then the PATH, and says null when it is nowhere', async () => {
    const home = await mkdtemp(join(tmpdir(), 'which-'));
    const [first, onPath] = [join(home, 'first'), join(home, 'path')];
    await mkdir(first, { recursive: true });
    await mkdir(onPath, { recursive: true });
    await writeFile(join(onPath, 'tool'), '');
    const env = { PATH: onPath };
    expect(which('tool', { env })).toBe(join(onPath, 'tool'));
    expect(which('tool', { env, extra: [first] })).toBe(join(onPath, 'tool'));
    await writeFile(join(first, 'tool'), '');
    // Another environment than the app's own is never remembered, so this sees the new file at once.
    expect(which('tool', { env, extra: [first] })).toBe(join(first, 'tool'));
    expect(await whichAsync('tool', { env, extra: [first] })).toBe(join(first, 'tool'));
    expect(which('nothing-here', { env })).toBeNull();
    expect(await whichAsync('nothing-here', { env })).toBeNull();
  });

  it('remembers answers about the app\'s own PATH for a minute, and lets a removed program go', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'which-own-'));
    const PATH = process.env.PATH;
    process.env.PATH = [dir, PATH].join(delimiter);
    try {
      forgetWhich();
      expect(which('cubicle-which-probe')).toBeNull();
      await writeFile(join(dir, 'cubicle-which-probe'), '');
      await chmod(join(dir, 'cubicle-which-probe'), 0o755);
      // Kept: the answer is the one given a moment ago, until it is forgotten or the minute is up.
      expect(which('cubicle-which-probe')).toBeNull();
      forgetWhich();
      expect(which('cubicle-which-probe')).toBe(join(dir, 'cubicle-which-probe'));
      await rm(join(dir, 'cubicle-which-probe'));
      expect(which('cubicle-which-probe')).toBeNull();
    } finally { process.env.PATH = PATH; forgetWhich(); }
  });
});

describe('offering by wire', () => {
  const stage = {
    rooms: [{ id: 'a' }, { id: 'b' }], docs: [], cards: [{ id: 'leads-1', kind: 'leads' }],
    wires: [{ id: 'w', from: 'a', fromHandle: 'r', to: 'leads-1', toHandle: 'l' }],
  } as unknown as Stage;
  const all = [tool('add_lead'), tool('read_doc')];

  it('offers a card\'s tools only to the people wired to such a card', () => {
    const offer = offerWhenWired('leads', ['add_lead']);
    expect(offer(all, stage, 'a').map((one) => one.name)).toEqual(['add_lead', 'read_doc']);
    expect(offer(all, stage, 'b').map((one) => one.name)).toEqual(['read_doc']);
  });

  it('takes a test of its own for what is not a card', () => {
    const offer = offerWhenWired((_stage, roomId) => roomId === 'b', ['add_lead']);
    expect(offer(all, stage, 'a').map((one) => one.name)).toEqual(['read_doc']);
    expect(offer(all, stage, 'b').map((one) => one.name)).toEqual(['add_lead', 'read_doc']);
  });
});

describe('patching the stage', () => {
  // A map finishing while a coder session is saved: each loaded the stage and saved its own copy, and one change was
  // lost. One after another, both are there.
  it('keeps both of two changes made at the same moment', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'patch-')));
    const stage = await store.loadStage();
    stage.cards = [{ id: 'coder-1', kind: 'project', path: '/p', x: 0, y: 0, w: 1, h: 1 }];
    await store.saveStage(stage);
    const project = (edit: Record<string, unknown>) => (one: Stage) => {
      one.cards = (one.cards ?? []).map((card) => (card.id === 'coder-1' ? { ...card, ...edit } : card));
    };
    await Promise.all([
      patchStageVia(store, project({ session: 'ses_1' })),
      patchStageVia(store, project({ graph: { at: 1, nodes: 2, edges: 3, communities: 1 } })),
    ]);
    expect((await store.loadStage()).cards?.[0]).toMatchObject({ session: 'ses_1', graph: { nodes: 2 } });
  });

  it('saves nothing when nothing changed, and hands a store that has its own patch straight to it', async () => {
    let saves = 0;
    const held = { rooms: [], docs: [], wires: [], cards: [] } as unknown as Stage;
    const store = { loadStage: async () => structuredClone(held), saveStage: async () => { saves += 1; } };
    await patchStageVia(store, () => {});
    expect(saves).toBe(0);
    await patchStageVia(store, (stage) => { stage.cards = [{ id: 'x' } as never]; });
    expect(saves).toBe(1);
    const own: string[] = [];
    await patchStageVia({ ...store, patchStage: async () => { own.push('patch'); return held; } }, () => {});
    expect(own).toEqual(['patch']);
  });
});
