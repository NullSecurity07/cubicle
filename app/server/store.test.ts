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
    await store.appendChat('marketing', { role: 'user', text: 'hi', at: 1 });
    await store.appendChat('marketing', { role: 'assistant', text: 'hello', at: 2, provider: 'fake' });
    expect((await store.readChat('marketing')).map((m) => m.text)).toEqual(['hi', 'hello']);
  });

  it('refuses ids that could leave the workspace', async () => {
    await expect(store.readDoc('../secret')).rejects.toThrow(/id/);
    await expect(store.appendChat('a/b', { role: 'user', text: 'x', at: 1 })).rejects.toThrow(/id/);
  });
});
