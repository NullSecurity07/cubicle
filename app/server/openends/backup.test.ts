import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { backupDir, leaveOut, landingPlace, listBackups, makeBackup, restore } from './backup.ts';
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
