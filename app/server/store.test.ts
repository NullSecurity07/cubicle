import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedStage } from '../shared/model.ts';
import { createStore, type Store } from './store.ts';

let dir: string;
let store: Store;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'stage-')); store = createStore(dir); });
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('store', () => {
  it('seeds the stage and the seed docs on first read', async () => {
    expect(await store.loadStage()).toEqual(seedStage);
    expect(await store.readDoc('brand-doc')).toContain('# Brand');
  });

  it('round-trips the stage and a doc', async () => {
    const stage = await store.loadStage();
    stage.rooms[0].x = 123;
    await store.saveStage(stage);
    await store.writeDoc('brand-doc', 'hello');
    const again = createStore(dir);
    expect((await again.loadStage()).rooms[0].x).toBe(123);
    expect(await again.readDoc('brand-doc')).toBe('hello');
  });

  it('appends chat messages in order and starts empty', async () => {
    expect(await store.readChat('marketing')).toEqual([]);
    await store.appendChat('marketing', { id: 'm', role: 'user', text: 'hi', at: 1 });
    await store.appendChat('marketing', { id: 'm', role: 'assistant', text: 'hello', at: 2, provider: 'fake' });
    expect((await store.readChat('marketing')).map((m) => m.text)).toEqual(['hi', 'hello']);
  });

  it('gives ids to conversations saved before messages had them, once', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(dir, 'rooms'), { recursive: true });
    await writeFile(join(dir, 'rooms', 'build.json'), JSON.stringify([{ role: 'user', text: 'old', at: 1 }]));
    const [first] = await store.readChat('build');
    expect(first.id).toMatch(/^m-/);
    expect((await store.readChat('build'))[0].id).toBe(first.id);
  });

  it('refuses ids that could leave the workspace', async () => {
    await expect(store.readDoc('../secret')).rejects.toThrow(/id/);
    await expect(store.appendChat('a/b', { id: 'm', role: 'user', text: 'x', at: 1 })).rejects.toThrow(/id/);
  });
});

describe('store, removing cards', () => {
  it('moves the files of removed cards to trash instead of deleting them', async () => {
    const stage = await store.loadStage();
    await store.appendChat('marketing', { id: 'm', role: 'user', text: 'keep me', at: 1 });
    await store.saveStage({ ...stage, rooms: stage.rooms.filter((room) => room.id !== 'marketing'), docs: [], wires: [] });
    expect(await store.readChat('marketing')).toEqual([]);
    expect(await store.readDoc('brand-doc')).toBe('');
    const { readdir, readFile } = await import('node:fs/promises');
    const trashed = await readdir(join(dir, 'trash'));
    expect(trashed.some((name) => name.endsWith('-marketing.json'))).toBe(true);
    expect(trashed.some((name) => name.endsWith('-brand-doc.md'))).toBe(true);
    const chat = trashed.find((name) => name.endsWith('-marketing.json'))!;
    expect(await readFile(join(dir, 'trash', chat), 'utf8')).toContain('keep me');
  });

  it('refuses a stage whose ids could leave the workspace', async () => {
    const stage = await store.loadStage();
    await expect(store.saveStage({ ...stage, docs: [{ ...stage.docs[0], id: '../x' }] })).rejects.toThrow(/id/);
  });
});
