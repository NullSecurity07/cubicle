import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupPlaces, readyFolder } from './places.ts';

describe('where a backup could go', () => {
  it('offers the drives mounted for this user and the synced folders that are there', async () => {
    const drives: Record<string, string[]> = { '/run/media/ada': ['KINGSTON'], '/Volumes': ['Macintosh HD'] };
    const places = await backupPlaces({ home: '/home/ada', user: 'ada', list: async (dir) => drives[dir] ?? [], isDir: async (path) => path === '/home/ada/Dropbox' });
    expect(places).toEqual([
      { label: 'KINGSTON', path: '/run/media/ada/KINGSTON/Cubicle backups' },
      { label: 'Dropbox', path: '/home/ada/Dropbox/Cubicle backups' },
    ]);
  });
});

describe('a folder made ready for backups', () => {
  it('makes it, writes to it once, and leaves nothing behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'places-'));
    const path = await readyFolder(join(root, 'usb', 'Cubicle backups'), join(root, 'workspace'));
    expect(path).toBe(join(root, 'usb', 'Cubicle backups'));
    expect(await readdir(path)).toEqual([]);
  });

  it('reads ~ as home, and refuses a part of a path or the workspace itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'places-'));
    expect(await readyFolder('~/copies', '/somewhere/else', root)).toBe(join(root, 'copies'));
    await expect(readyFolder('copies', root)).rejects.toThrow('whole path');
    await expect(readyFolder(join(root, 'ws', 'inside'), join(root, 'ws'))).rejects.toThrow('inside the workspace');
    await expect(readyFolder(join(root, 'ws'), join(root, 'ws'))).rejects.toThrow('inside the workspace');
    await expect(readyFolder('   ', root)).rejects.toThrow('say which folder');
  });

  it('says so when nothing can be written there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'places-'));
    await writeFile(join(root, 'a-file'), 'not a folder');
    await expect(readyFolder(join(root, 'a-file', 'backups'), '/tmp/ws')).rejects.toThrow(`nothing can be written to ${join(root, 'a-file', 'backups')}: ENOTDIR`);
  });
});
