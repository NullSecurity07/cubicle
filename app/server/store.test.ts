import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedStage, type Stage } from '../shared/model.ts';
import { makeBackup } from './openends/backup.ts';
import { createStore, type Damage, type Store } from './store.ts';

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
    // Nor for one that only set the same fields again in another order.
    const again = await store.patchStage((stage) => ({ ...stage, rooms: stage.rooms.map((room) => Object.fromEntries(Object.entries(room).reverse()) as typeof room) }));
    expect(again.rev).toBeUndefined();
    expect((await store.loadStage()).rev).toBeUndefined();
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

describe('store, a file that cannot be read', () => {
  const damaged: Damage[] = [];
  let backups: string;
  beforeEach(async () => {
    damaged.length = 0;
    backups = await mkdtemp(join(tmpdir(), 'backups-'));
    store = createStore(dir, undefined, undefined, { backups: () => backups, onDamaged: (one) => damaged.push(one) });
  });
  afterEach(() => rm(backups, { recursive: true, force: true }));
  // Half a file, the way a crash or a careless hand edit leaves one.
  const cut = async (path: string) => { const text = await readFile(join(dir, path), 'utf8'); await writeFile(join(dir, path), text.slice(0, Math.floor(text.length / 2))); };
  const aside = async (folder: string, name: string) => (await readdir(join(dir, folder))).filter((one) => one.startsWith(`${name}.corrupt-`) && one.endsWith('.json'));

  it('moves a cut-off stage aside and starts again from the first stage when no backup holds it', async () => {
    const stage = await store.loadStage();
    stage.rooms[0].x = 777;
    await store.saveStage(stage);
    await store.writeDoc('brand-doc', 'my own brand words');
    await cut('stage.json');
    const again = await store.loadStage();
    expect(again.rooms.map((one) => one.id)).toEqual(seedStage.rooms.map((one) => one.id));
    expect(again.rooms[0].x).toBe(seedStage.rooms[0].x);
    // The founder's doc is not written over by the seed.
    expect(await store.readDoc('brand-doc')).toBe('my own brand words');
    const [bad] = await aside('.', 'stage');
    expect(bad).toBeTruthy();
    expect(await readFile(join(dir, bad), 'utf8')).toContain('"rooms"');
    expect(damaged).toEqual([{ file: 'stage.json', aside: join(dir, bad), from: null }]);
    // Read again, it is a good file now: nothing more is moved or said.
    await store.loadStage();
    expect(await aside('.', 'stage')).toHaveLength(1);
    expect(damaged).toHaveLength(1);
  });

  it('puts a cut-off stage back from the newest backup that holds it', async () => {
    const stage = await store.loadStage();
    stage.rooms[0].x = 111;
    await store.saveStage(stage);
    await makeBackup({ workspace: dir, dir: backups, now: () => new Date('2026-09-25T09:00:00').getTime() });
    await store.saveStage({ ...stage, rooms: [{ ...stage.rooms[0], x: 222 }, ...stage.rooms.slice(1)] });
    await makeBackup({ workspace: dir, dir: backups, now: () => new Date('2026-09-26T09:00:00').getTime() });
    await cut('stage.json');
    const again = await store.loadStage();
    expect(again.rooms[0].x).toBe(222);
    expect(damaged).toHaveLength(1);
    expect(damaged[0].from?.file).toBe('cubicle-2026-09-26-0900.tar.gz');
    expect(await aside('.', 'stage')).toHaveLength(1);
  });

  it('never fails a save because the stage on disk was cut off', async () => {
    await store.loadStage();
    await cut('stage.json');
    await store.saveStage({ ...structuredClone(seedStage), rooms: [{ ...seedStage.rooms[0], x: 5 }] });
    expect((await store.loadStage()).rooms[0].x).toBe(5);
    expect(damaged).toHaveLength(1);
  });

  it('moves a cut-off conversation aside and starts it empty when no backup holds it', async () => {
    await store.appendChat('marketing', { id: 'a', role: 'user', text: 'one', at: 1 });
    await store.appendChat('marketing', { id: 'b', role: 'user', text: 'two', at: 2 });
    await cut('rooms/marketing.json');
    expect(await store.readChat('marketing')).toEqual([]);
    const [bad] = await aside('rooms', 'marketing');
    expect(await readFile(join(dir, 'rooms', bad), 'utf8')).toContain('"one"');
    expect(damaged).toEqual([{ file: 'rooms/marketing.json', aside: join(dir, 'rooms', bad), from: null }]);
    // And the next message is written, not refused.
    await store.appendChat('marketing', { id: 'c', role: 'user', text: 'three', at: 3 });
    expect((await store.readChat('marketing')).map((m) => m.id)).toEqual(['c']);
  });

  it('puts a cut-off conversation back from a backup, and a message written to it lands after what was there', async () => {
    await store.appendChat('marketing', { id: 'a', role: 'user', text: 'one', at: 1 });
    await makeBackup({ workspace: dir, dir: backups, now: () => new Date('2026-09-26T09:00:00').getTime() });
    await store.appendChat('marketing', { id: 'b', role: 'user', text: 'two', at: 2 });
    await cut('rooms/marketing.json');
    await store.appendChat('marketing', { id: 'c', role: 'user', text: 'three', at: 3 });
    expect((await store.readChat('marketing')).map((m) => m.id)).toEqual(['a', 'c']);
    expect(damaged).toHaveLength(1);
    expect(damaged[0]).toMatchObject({ file: 'rooms/marketing.json', from: { file: 'cubicle-2026-09-26-0900.tar.gz' } });
  });

  it('moves the damaged file aside once when several ask at the same moment', async () => {
    await store.appendChat('marketing', { id: 'a', role: 'user', text: 'one', at: 1 });
    await cut('rooms/marketing.json');
    await Promise.all([store.readChat('marketing'), store.readChat('marketing'), store.appendChat('marketing', { id: 'b', role: 'user', text: 'two', at: 2 })]);
    expect(await aside('rooms', 'marketing')).toHaveLength(1);
    expect(damaged).toHaveLength(1);
    expect((await store.readChat('marketing')).map((m) => m.id)).toEqual(['b']);
  });

  it('never leaves the stage missing while it is put back, so loads at the same moment neither seed it nor touch the docs', async () => {
    const stage = await store.loadStage();
    await store.saveStage({ ...stage, rooms: [{ ...stage.rooms[0], x: 111 }, ...stage.rooms.slice(1)] });
    await store.writeDoc('brand-doc', 'MY OWN BRAND');
    await store.writeDoc('company-brief', 'MY OWN BRIEF');
    await makeBackup({ workspace: dir, dir: backups, now: () => new Date('2026-09-26T09:00:00').getTime() });
    await cut('stage.json');
    const later = (ms: number) => new Promise<void>((settle) => setTimeout(settle, ms)).then(() => store.loadStage());
    const loads = await Promise.all([store.loadStage(), later(0), later(2), later(5), later(20)]);
    for (const one of loads) expect(one.rooms[0].x).toBe(111);
    expect((await store.loadStage()).rooms[0].x).toBe(111);
    expect(await store.readDoc('brand-doc')).toBe('MY OWN BRAND');
    expect(await store.readDoc('company-brief')).toBe('MY OWN BRIEF');
    expect(await aside('.', 'stage')).toHaveLength(1);
    expect(damaged).toHaveLength(1);
  });

  it('keeps a message written while a damaged conversation is being put back', async () => {
    await store.appendChat('marketing', { id: 'a', role: 'user', text: 'one', at: 1 });
    await makeBackup({ workspace: dir, dir: backups, now: () => new Date('2026-09-26T09:00:00').getTime() });
    await cut('rooms/marketing.json');
    const reading = store.readChat('marketing');
    await new Promise((settle) => setTimeout(settle, 1));
    await Promise.all([reading, store.appendChat('marketing', { id: 'b', role: 'user', text: 'two', at: 2 })]);
    expect((await store.readChat('marketing')).map((m) => m.id)).toEqual(['a', 'b']);
    expect(await aside('rooms', 'marketing')).toHaveLength(1);
  });

  it('puts the stage back on a revision above any a window could hold, and tells the windows', async () => {
    const told: Stage[] = [];
    store = createStore(dir, undefined, (stage) => told.push(stage), { backups: () => backups, onDamaged: (one) => damaged.push(one) });
    let stage = await store.loadStage();
    await makeBackup({ workspace: dir, dir: backups, now: () => new Date('2026-09-26T09:00:00').getTime() });
    // Many saves after the backup: an open window holds a revision far past the backup's.
    for (let count = 0; count < 30; count += 1) { await store.saveStage(stage); stage = await store.loadStage(); }
    const window = stage.rev!;
    await cut('stage.json');
    const back = await store.loadStage();
    expect(back.rev).toBeGreaterThan(window);
    expect(back.rev).toBeGreaterThan(1_000_000);
    expect(told.at(-1)?.rev).toBe(back.rev);
    // Saved on from there, it counts up as before.
    await store.saveStage(back);
    expect((await store.loadStage()).rev).toBe(back.rev! + 1);
  });

  it('starts a cut-off memory empty rather than failing the person', async () => {
    await store.writeMemory('marketing', { notes: 'kept', summary: '' });
    await cut('rooms/marketing.memory.json');
    expect(await store.readMemory('marketing')).toEqual({ notes: '', summary: '', upTo: undefined });
    expect(damaged.map((one) => one.file)).toEqual(['rooms/marketing.memory.json']);
  });
});
