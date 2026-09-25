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

describe('store, changes made here and in a window', () => {
  const doc = (id: string) => ({ id, title: id, x: 0, y: 0, w: 340, h: 300 });

  it('keeps both of two changes made at once', async () => {
    await Promise.all([
      store.patchStage((stage) => { stage.docs.push(doc('doc-one')); }),
      store.patchStage((stage) => { stage.docs.push(doc('doc-two')); }),
    ]);
    const ids = (await store.loadStage()).docs.map((one) => one.id);
    expect(ids).toContain('doc-one');
    expect(ids).toContain('doc-two');
  });

  it('writes nothing for a change that changed nothing', async () => {
    await store.loadStage();
    const before = await store.patchStage(() => {});
    expect(before).toEqual(seedStage);
  });

  it('keeps what a change put on the stage until a window sends it back, and then lets the window decide', async () => {
    const seen = await store.loadStage();
    await store.patchStage((stage) => {
      stage.docs.push(doc('doc-new'));
      stage.wires.push({ id: 'marketing-doc-new', from: 'marketing', fromHandle: 'r', to: 'doc-new', toHandle: 'l' });
    });
    // A window that never heard of it saves the stage it has: the doc and its wire stay, and nothing goes to trash.
    const { next } = await store.putStage(seen);
    expect(next.docs.map((one) => one.id)).toContain('doc-new');
    expect(next.wires.map((one) => one.id)).toContain('marketing-doc-new');
    // Once it has sent them back, taking them away is the founder's own doing.
    await store.putStage(next);
    await store.putStage(seen);
    const after = await store.loadStage();
    expect(after.docs.map((one) => one.id)).not.toContain('doc-new');
    expect(after.wires.map((one) => one.id)).not.toContain('marketing-doc-new');
  });

  it('drops a kept wire whose person the window took away', async () => {
    const seen = await store.loadStage();
    await store.patchStage((stage) => { stage.wires.push({ id: 'marketing-brand-doc-x', from: 'marketing', fromHandle: 'r', to: 'brand-doc', toHandle: 'l' }); });
    const { next } = await store.putStage({ ...seen, rooms: seen.rooms.filter((one) => one.id !== 'marketing'), wires: seen.wires.filter((one) => one.from !== 'marketing' && one.to !== 'marketing') });
    expect(next.wires.some((one) => one.id === 'marketing-brand-doc-x')).toBe(false);
  });
});
