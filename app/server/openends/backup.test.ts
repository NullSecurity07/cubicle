import { mkdir, mkdtemp, readdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { autoBackup, backupDir, backupDirOf, canWrite, sameDisk, chooseBackupDir, chosenBackupDir, leaveOut, landingPlace, listBackups, makeBackup, restore } from './backup.ts';
import { END, packTar, splitPath, tarBlock, tarEntries } from './tar.ts';

const dir = (what: string) => mkdtemp(join(tmpdir(), `${what}-`));
const write = async (root: string, path: string, text: string) => {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), text);
};
// A workspace with a little of everything in it, including the folders a backup is not for.
async function workspace() {
  const root = await dir('stage');
  await write(root, 'stage.json', '{"rooms":[]}');
  await write(root, 'docs/brand.md', '# Brand\nPlain words.');
  await write(root, 'rooms/marketing.json', '[{"text":"hello"}]');
  await write(root, 'skills/ship-it.json', '{"name":"Ship it"}');
  await write(root, 'browsers/card-1/Cookies', 'not ours');
  await write(root, '.index/trace/2026-09-20.jsonl', '{}');
  await write(root, 'trash/old.json', '{}');
  await write(root, '.cache/model.bin', 'big');
  return root;
}
const gather = async (source: AsyncGenerator<Buffer>) => { const held: Buffer[] = []; for await (const chunk of source) held.push(chunk); return Buffer.concat(held); };

describe('the tar we write ourselves', () => {
  it('writes a header the old way, with the checksum that proves it', () => {
    const block = tarBlock('docs/brand.md', 42, 1_700_000_000_000);
    expect(block).toHaveLength(512);
    expect(block.subarray(0, 13).toString()).toBe('docs/brand.md');
    expect(block.subarray(257, 263).toString()).toBe('ustar\0');
    expect(block.subarray(124, 135).toString()).toBe('00000000052');
    const blank = Buffer.from(block);
    blank.fill(' ', 148, 156);
    expect(Number.parseInt(block.subarray(148, 154).toString(), 8)).toBe([...blank].reduce((sum, byte) => sum + byte, 0));
  });

  it('splits a long path where tar splits it, and refuses in words the one it cannot', () => {
    expect(splitPath('a/b.md')).toEqual({ name: 'a/b.md', prefix: '' });
    const deep = `${'folder/'.repeat(20)}note.md`;
    expect(splitPath(deep).prefix.length).toBeLessThanOrEqual(155);
    expect(splitPath(deep).name.length).toBeLessThanOrEqual(100);
    expect(() => splitPath('x'.repeat(200))).toThrow('too long for a backup');
  });

  it('reads back exactly what it wrote, and stops at the end mark', () => {
    const body = Buffer.from('Plain words.');
    const tar = Buffer.concat([tarBlock('a.md', body.length, 0), body, Buffer.alloc(512 - body.length), END, tarBlock('after.md', 0, 0)]);
    expect(tarEntries(tar).map((one) => [one.name, one.body.toString()])).toEqual([['a.md', 'Plain words.']]);
  });

  it('never follows a link out of the folder', async () => {
    const root = await dir('links');
    await write(root, 'real.md', 'mine');
    await symlink('/etc/passwd', join(root, 'away.md'));
    expect(tarEntries(await gather(packTar(root))).map((one) => one.name)).toEqual(['real.md']);
  });
});

describe('a backup', () => {
  it('holds what the founder wrote and leaves behind what can be made again', async () => {
    const root = await workspace();
    const into = await dir('backups');
    const { backup, dropped } = await makeBackup({ workspace: root, dir: into, now: () => new Date('2026-09-20T14:05:00').getTime() });
    expect(backup.file).toBe('cubicle-2026-09-20-1405.tar.gz');
    expect(dropped).toBe(0);
    const names = tarEntries(gunzipSync(await readFile(join(into, backup.file)))).filter((one) => one.kind === '0').map((one) => one.name);
    expect(names).toEqual(['docs/brand.md', 'rooms/marketing.json', 'skills/ship-it.json', 'stage.json']);
    expect(['browsers/card-1/Cookies', '.index/trace/2026-09-20.jsonl', 'trash/old.json', '.cache/model.bin'].every(leaveOut)).toBe(true);
    expect(leaveOut('docs/brand.md')).toBe(false);
    // Where this workspace's backups go is about this machine: a restored copy starts from the default.
    expect(leaveOut('backup-to.json')).toBe(true);
    expect(leaveOut('docs/backup-to.json')).toBe(false);
  });

  it('keeps five and lets the sixth go, newest first', async () => {
    const root = await workspace();
    const into = await dir('backups');
    let at = new Date('2026-09-14T09:00:00').getTime();
    for (let made = 0; made < 7; made += 1) { await makeBackup({ workspace: root, dir: into, now: () => at }); at += 86_400_000; }
    const held = await listBackups(into);
    expect(held).toHaveLength(5);
    expect(held[0].file).toBe('cubicle-2026-09-20-0900.tar.gz');
    expect(held[4].file).toBe('cubicle-2026-09-16-0900.tar.gz');
    expect(held[0].bytes).toBeGreaterThan(0);
    // Nothing half-written is ever left lying around under a name that looks like a backup.
    expect((await readdir(into)).filter((name) => name.includes('.part'))).toEqual([]);
  });

  it('goes to a folder of the founder\'s own unless this machine says otherwise', () => {
    expect(backupDir({ HOME: '/home/founder' })).toMatch(/Cubicle backups$/);
    expect(backupDir({ STAGE_BACKUP_DIR: '/tmp/elsewhere' })).toBe('/tmp/elsewhere');
  });
});

describe('putting one back', () => {
  it('unpacks into a new folder and never over the one in use', async () => {
    const root = await workspace();
    const into = await dir('backups');
    const { backup } = await makeBackup({ workspace: root, dir: into });
    const fresh = join(await dir('restored'), 'from-backup');
    expect(await restore(join(into, backup.file), fresh)).toMatchObject({ files: 4 });
    expect(await readFile(join(fresh, 'docs', 'brand.md'), 'utf8')).toBe('# Brand\nPlain words.');
    await expect(restore(join(into, backup.file), fresh)).rejects.toThrow('only ever goes into a new, empty folder');
  });

  it('refuses every entry that would land anywhere but inside that folder', async () => {
    expect(landingPlace('/home/founder/new', 'docs/brand.md', '0')).toBe('/home/founder/new/docs/brand.md');
    for (const bad of ['../../etc/passwd', '/etc/passwd', 'docs/../../away.md', 'C:\\windows\\system32']) {
      expect(() => landingPlace('/home/founder/new', bad, '0')).toThrow('outside the new folder');
    }
    expect(() => landingPlace('/home/founder/new', 'away.md', '2')).toThrow('never puts links back');
  });

  it('writes nothing at all when one entry in the archive is bad', async () => {
    const body = Buffer.from('gotcha');
    const tar = Buffer.concat([
      tarBlock('good.md', body.length, 0), body, Buffer.alloc(512 - body.length),
      tarBlock('deep/../../escape.md', body.length, 0), body, Buffer.alloc(512 - body.length), END,
    ]);
    const archive = join(await dir('bad'), 'bad.tar.gz');
    await writeFile(archive, gzipSync(tar));
    const fresh = join(await dir('restored'), 'from-bad');
    await expect(restore(archive, fresh)).rejects.toThrow('nothing was unpacked');
    expect(await readdir(fresh).catch(() => null)).toBe(null);
  });
});

describe('backupDirOf', () => {
  // A checkout of the app: the main one has a .git folder, a worktree or second checkout a .git file.
  const checkout = async (main: boolean) => {
    const root = await dir(main ? 'main-checkout' : 'worktree');
    if (main) await mkdir(join(root, '.git')); else await writeFile(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    return root;
  };
  // The founder's own folder, under a home made for the test, holding one real backup already.
  const ownerHome = async () => {
    const home = await dir('home');
    await write(join(home, 'Cubicle backups'), 'cubicle-2026-09-20-0900.tar.gz', 'theirs');
    // Made days ago, so a daily backup there is due.
    const old = (Date.now() - 3 * 86_400_000) / 1000;
    await utimes(join(home, 'Cubicle backups', 'cubicle-2026-09-20-0900.tar.gz'), old, old);
    return home;
  };

  it('keeps a fake run beside its workspace, unless the machine names a folder', () => {
    expect(backupDirOf({ fake: true, workspace: '/w', root: '/r' }, {})).toBe('/w/backups');
    expect(backupDirOf({ fake: true, workspace: '/w', root: '/r' }, { STAGE_BACKUP_DIR: '/b' })).toBe('/b');
    expect(backupDirOf({ fake: false, workspace: '/w', root: '/r' }, { STAGE_BACKUP_DIR: '/b' })).toBe('/b');
  });

  it('sends a real run on any other workspace beside that workspace, never to the founder\'s own folder', async () => {
    const scratch = await dir('scratch-ws');
    const root = await checkout(true);
    expect(backupDirOf({ fake: false, workspace: scratch, root }, {}, true, '/home/founder')).toBe(join(scratch, 'backups'));
  });

  it('keeps the founder\'s own folder for the app\'s own workspace in the main checkout only', async () => {
    const main = await checkout(true);
    expect(backupDirOf({ fake: false, workspace: join(main, 'workspace'), root: main }, {}, true, '/home/founder')).toBe('/home/founder/Cubicle backups');
    // A worktree or a second checkout run without STAGE_WORKSPACE is not the founder's app.
    const tree = await checkout(false);
    expect(backupDirOf({ fake: false, workspace: join(tree, 'workspace'), root: tree }, {}, true, '/home/founder')).toBe(join(tree, 'workspace', 'backups'));
    // A packaged build has no .git at all: it is the founder's app, and its backups never go inside the workspace.
    const packaged = await dir('packaged');
    expect(backupDirOf({ fake: false, workspace: join(packaged, 'workspace'), root: packaged }, {}, true, '/home/founder')).toBe('/home/founder/Cubicle backups');
    expect(backupDirOf({ fake: false, workspace: join(packaged, 'workspace'), root: packaged }, { STAGE_BACKUP_DIR: '/b' }, true, '/home/founder')).toBe('/b');
  });

  it('takes the folder chosen for this workspace, and only for this one', async () => {
    const one = await dir('ws-one');
    const other = await dir('ws-other');
    await chooseBackupDir(one, '/media/usb/Cubicle backups');
    expect(chosenBackupDir(one)).toBe('/media/usb/Cubicle backups');
    expect(backupDirOf({ fake: false, workspace: one, root: '/r' }, {})).toBe('/media/usb/Cubicle backups');
    expect(backupDirOf({ fake: false, workspace: other, root: '/r' }, {})).toBe(join(other, 'backups'));
    // The machine still wins over the choice.
    expect(backupDirOf({ fake: false, workspace: one, root: '/r' }, { STAGE_BACKUP_DIR: '/b' })).toBe('/b');
    await chooseBackupDir(one, null);
    expect(chosenBackupDir(one)).toBeNull();
  });

  it('never writes a scratch or worktree run\'s daily backup into the founder\'s folder, and the main checkout\'s does', async () => {
    const home = await ownerHome();
    const owner = join(home, 'Cubicle backups');
    const daily = async (workspace: string, root: string) => {
      await write(workspace, 'stage.json', '{"rooms":[]}');
      return autoBackup({ workspace, dir: () => backupDirOf({ fake: false, workspace, root }, {}, true, home) }).tick();
    };
    const scratch = await dir('scratch-ws');
    expect((await daily(scratch, await checkout(true)))?.made).toBeTruthy();
    const tree = await checkout(false);
    expect((await daily(join(tree, 'workspace'), tree))?.made).toBeTruthy();
    expect(await listBackups(join(scratch, 'backups'))).toHaveLength(1);
    expect(await listBackups(join(tree, 'workspace', 'backups'))).toHaveLength(1);
    expect((await readdir(owner)).sort()).toEqual(['cubicle-2026-09-20-0900.tar.gz']);
    // The control: the main checkout's own workspace does back up there.
    const main = await checkout(true);
    await daily(join(main, 'workspace'), main);
    expect(await listBackups(owner)).toHaveLength(2);
  });
});

describe('the backup that makes itself', () => {
  const HOUR = 3_600_000;
  it('makes one when there is none, then waits until the newest is a day old', async () => {
    const root = await workspace();
    const into = await dir('auto');
    let clock = Date.now();
    const auto = autoBackup({ workspace: root, dir: () => into, now: () => clock });
    expect((await auto.tick())?.made?.backup.file).toMatch(/^cubicle-/);
    expect(await listBackups(into)).toHaveLength(1);
    clock += 23 * HOUR;
    expect(await auto.tick()).toBeNull();
    expect(await listBackups(into)).toHaveLength(1);
    clock += 2 * HOUR;
    expect((await auto.tick())?.made).toBeTruthy();
    expect(await listBackups(into)).toHaveLength(2);
  });

  it('keeps five, the same as a backup made by hand', async () => {
    const root = await workspace();
    const into = await dir('auto');
    let clock = Date.now();
    const auto = autoBackup({ workspace: root, dir: () => into, now: () => clock });
    for (let day = 0; day < 7; day += 1) { await auto.tick(); clock += 25 * HOUR; }
    expect(await listBackups(into)).toHaveLength(5);
  });

  it('after a failure says why, and does not try again for an hour', async () => {
    const root = await workspace();
    const file = join(await dir('auto'), 'not-a-folder');
    await writeFile(file, 'x');
    let clock = Date.now();
    const auto = autoBackup({ workspace: root, dir: () => join(file, 'backups'), now: () => clock, log: () => {} });
    expect((await auto.tick())?.problem).toBeTruthy();
    clock += 30 * 60_000;
    expect(await auto.tick()).toBeNull();
    clock += 31 * 60_000;
    expect((await auto.tick())?.problem).toBeTruthy();
  });
});

describe('canWrite', () => {
  it('says yes for a folder not made yet under one that can be written, and no under a file', async () => {
    const base = await dir('probe');
    expect(await canWrite(join(base, 'later', 'backups'))).toBe(true);
    await writeFile(join(base, 'file'), 'x');
    expect(await canWrite(join(base, 'file', 'backups'))).toBe(false);
  });
});

describe('sameDisk', () => {
  // A stat that knows a few folders and which disk each is on, and nothing else.
  const disks = (known: Record<string, number>) => async (path: string) => {
    if (path in known) return { dev: known[path] };
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  };
  it('says yes when the backup folder is on the disk the workspace is on', async () => {
    expect(await sameDisk('/home/f/work', '/home/f/Cubicle backups', disks({ '/home/f/work': 1, '/home/f/Cubicle backups': 1 }))).toBe(true);
    expect(await sameDisk('/home/f/work', '/media/usb/backups', disks({ '/home/f/work': 1, '/media/usb/backups': 2 }))).toBe(false);
  });
  it('asks the nearest folder there is for a backup folder not made yet', async () => {
    expect(await sameDisk('/home/f/work', '/media/usb/later/backups', disks({ '/home/f/work': 1, '/media/usb': 2 }))).toBe(false);
    expect(await sameDisk('/home/f/work', '/home/f/work/backups', disks({ '/home/f/work': 1 }))).toBe(true);
  });
  it('does not claim the same disk when it cannot tell', async () => {
    expect(await sameDisk('/home/f/work', '/media/usb', async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); })).toBe(false);
  });
});
