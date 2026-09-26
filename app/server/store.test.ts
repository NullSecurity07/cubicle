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

  it('refuses a window that saves over a stage it has not seen, and counts every save', async () => {
    const seen = await store.loadStage();
    const first = await store.putStage(seen, 0);
    expect(first.stale).toBe(false);
    expect((await store.loadStage()).rev).toBe(1);
    // A second window still holds the stage as it was before the first one saved.
    const late = await store.putStage({ ...seen, rooms: [] }, 0);
    expect(late.stale).toBe(true);
    expect((await store.loadStage()).rooms).toHaveLength(seen.rooms.length);
    await store.patchStage((stage) => { stage.rooms[0].x = 7; });
    expect((await store.loadStage()).rev).toBe(2);
  });

  it('tells whoever listens what the stage became after every save', async () => {
    const heard: (number | undefined)[] = [];
    const listened = createStore(dir, () => {}, (stage) => heard.push(stage.rev));
    const seen = await listened.loadStage();
    await listened.putStage(seen, 0);
    await listened.patchStage((stage) => { stage.rooms[0].x = 9; });
    expect(heard).toEqual([1, 2]);
  });

  it('lets a window that saw a person\'s card take it away, and takes a revision only from its argument', async () => {
    const seen = await store.loadStage();
    await store.patchStage((stage) => { stage.docs.push({ id: 'doc-new', title: 'New', x: 900, y: 0, w: 340, h: 300 }); });
    const heard = await store.loadStage();
    await store.writeDoc('doc-new', 'words');
    // The window heard of the doc (revision 1), and the founder took it away again.
    const { next, stale } = await store.putStage({ ...heard, docs: seen.docs, rev: 99 }, heard.rev);
    expect(stale).toBe(false);
    expect(next.docs.map((one) => one.id)).not.toContain('doc-new');
    expect(await store.readDoc('doc-new')).toBe('');
    // A revision in the body is not a revision: the stage is saved whole, and the body's number is not kept.
    const { stale: bodyOnly, next: saved } = await store.putStage({ ...next, rev: 0 });
    expect(bodyOnly).toBe(false);
    expect(saved.rev).toBe(next.rev! + 1);
  });

  it('keeps both of two messages written to one conversation at once', async () => {
    await Promise.all([
      store.appendChat('marketing', { id: 'a', role: 'user', text: 'one', at: 1 }),
      store.appendChat('marketing', { id: 'b', role: 'assistant', text: 'two', at: 2 }),
      store.appendChat('marketing', { id: 'c', role: 'user', text: 'three', at: 3 }),
    ]);
    expect((await store.readChat('marketing')).map((m) => m.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('keeps a message written while another is being cut out', async () => {
    await store.appendChat('marketing', { id: 'a', role: 'user', text: 'one', at: 1 });
    await Promise.all([store.cutChat('marketing', 'a', false), store.appendChat('marketing', { id: 'b', role: 'user', text: 'two', at: 2 })]);
    expect((await store.readChat('marketing')).map((m) => m.id)).toEqual(['b']);
  });

  it('writes a message in place by its id, or at the end when it is new', async () => {
    await store.appendChat('marketing', { id: 'a', role: 'user', text: 'ask', at: 1 });
    await store.putMessage('marketing', { id: 'r', role: 'assistant', text: 'half', at: 2, stopped: true });
    await store.appendChat('marketing', { id: 'q', role: 'user', text: 'from a colleague', at: 3 });
    await store.putMessage('marketing', { id: 'r', role: 'assistant', text: 'whole', at: 4 });
    expect((await store.readChat('marketing')).map((m) => `${m.id}:${m.text}`)).toEqual(['a:ask', 'r:whole', 'q:from a colleague']);
  });
});
