import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttention, damageAttention } from './attention.ts';
import { createBoards } from './boards.ts';
import { makeBackup } from './openends/backup.ts';
import { betsBook } from './partner/bets.ts';
import { promisesBook } from './partner/promises.ts';
import { partnerState } from './partner/state.ts';
import { bookRescue, type Damage } from './rescue.ts';

let workspace: string;
let backups: string;
const damaged: Damage[] = [];
const before = { ...bookRescue };
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'books-'));
  backups = await mkdtemp(join(tmpdir(), 'books-backups-'));
  damaged.length = 0;
  bookRescue.backups = () => backups;
  bookRescue.tell = (damage) => { damaged.push(damage); };
});
afterEach(async () => {
  Object.assign(bookRescue, before);
  await rm(workspace, { recursive: true, force: true });
  await rm(backups, { recursive: true, force: true });
});

// Half a file, the way a crash or a careless hand edit leaves one.
const cut = async (name: string) => { const text = await readFile(join(workspace, name), 'utf8'); await writeFile(join(workspace, name), text.slice(0, Math.floor(text.length / 2))); return text; };
const aside = async (folder: string, name: string) => (await readdir(join(workspace, folder))).filter((one) => one.startsWith(`${name}.corrupt-`) && one.endsWith('.json'));
const backUp = () => makeBackup({ workspace, dir: backups, now: () => new Date('2026-09-26T09:00:00').getTime() });
const NOON = new Date('2026-09-27T12:00:00').getTime();

describe('a side book that will not parse', () => {
  it('puts cut-off promises back from the newest backup, keeps the damaged copy and says so', async () => {
    const book = promisesBook(workspace, () => NOON);
    await book.add({ what: 'send the deck to Ana', due: '2026-10-01' } as never);
    await backUp();
    const whole = await cut('promises.json');
    expect((await book.list()).map((one) => one.what)).toEqual(['send the deck to Ana']);
    const [bad] = await aside('.', 'promises');
    expect(whole.startsWith(await readFile(join(workspace, bad), 'utf8'))).toBe(true);
    expect(damaged).toEqual([expect.objectContaining({ file: 'promises.json', aside: join(workspace, bad), from: expect.objectContaining({ file: 'cubicle-2026-09-26-0900.tar.gz' }) })]);
    expect(damaged[0].what?.thing).toBe('Your promises file');
    expect(damageAttention(damaged[0], NOON).title).toBe('Your promises file was damaged, and was put back from a backup');
  });

  it('starts cut-off promises empty when no backup holds them, and the next write does not take the damaged copy away', async () => {
    const book = promisesBook(workspace, () => NOON);
    await book.add({ what: 'call the bank', due: '2026-10-01' } as never);
    await cut('promises.json');
    expect(await book.list()).toEqual([]);
    await book.add({ what: 'hire a designer', due: '2026-10-02' } as never);
    expect((await book.list()).map((one) => one.what)).toEqual(['hire a designer']);
    const [bad] = await aside('.', 'promises');
    expect(await readFile(join(workspace, bad), 'utf8')).toContain('call the bank');
    expect(damaged).toEqual([expect.objectContaining({ file: 'promises.json', from: null })]);
    expect(damageAttention(damaged[0], NOON)).toMatchObject({ kind: 'file-damaged', title: 'Your promises file was damaged, and your promises started again' });
  });

  it('puts cut-off bets back from a backup, or starts them empty without one', async () => {
    const book = betsBook(workspace, () => NOON);
    await book.propose({ what: 'a cheaper plan', hypothesis: 'more sign-ups', metric: 'sign-ups', target: 50, checkDate: '2026-10-10' } as never);
    await backUp();
    await cut('bets.json');
    expect((await book.list()).map((one) => one.what)).toEqual(['a cheaper plan']);
    expect(damaged[0]).toMatchObject({ file: 'bets.json', from: { file: 'cubicle-2026-09-26-0900.tar.gz' } });

    await rm(backups, { recursive: true, force: true });
    await cut('bets.json');
    expect(await book.list()).toEqual([]);
    expect(damaged[1]).toMatchObject({ file: 'bets.json', from: null });
    expect(await aside('.', 'bets')).toHaveLength(2);
  });

  it('leaves a good file exactly as it is, and says nothing', async () => {
    const book = promisesBook(workspace, () => NOON);
    await book.add({ what: 'send the deck to Ana', due: '2026-10-01' } as never);
    const text = await readFile(join(workspace, 'promises.json'), 'utf8');
    const when = (await stat(join(workspace, 'promises.json'))).mtimeMs;
    await book.list();
    await book.list();
    expect(await readFile(join(workspace, 'promises.json'), 'utf8')).toBe(text);
    expect((await stat(join(workspace, 'promises.json'))).mtimeMs).toBe(when);
    expect(await aside('.', 'promises')).toEqual([]);
    expect(damaged).toEqual([]);
  });

  it('rescues a board, the Needs you list and the partner\'s notes the same way', async () => {
    await mkdir(join(workspace, 'boards'), { recursive: true });
    await writeFile(join(workspace, 'boards', 'board-1.json'), '[{"id":"t1","title":"Ship');
    await writeFile(join(workspace, 'attention.json'), '{"open":[{"id":"x"');
    await writeFile(join(workspace, 'partner.json'), '{"decided":[');
    expect(await createBoards(workspace).list('board-1')).toEqual([]);
    expect(await createAttention(workspace, () => NOON).list()).toEqual([]);
    expect(await partnerState(workspace).read()).toMatchObject({ decided: [], plans: [] });
    expect(damaged.map((one) => one.file).sort()).toEqual(['attention.json', 'boards/board-1.json', 'partner.json']);
    expect(await aside('boards', 'board-1')).toHaveLength(1);
    expect(await aside('.', 'attention')).toHaveLength(1);
    expect(await aside('.', 'partner')).toHaveLength(1);
  });

  it('moves a damaged file aside once when several read it at the same moment', async () => {
    await writeFile(join(workspace, 'bets.json'), '{"bets":[');
    const book = betsBook(workspace, () => NOON);
    await Promise.all([book.list(), book.list(), book.list()]);
    expect(await aside('.', 'bets')).toHaveLength(1);
    expect(damaged).toHaveLength(1);
  });
});
