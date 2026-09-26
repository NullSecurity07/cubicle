import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Which paths had their bytes pushed to the disk, in order.
const synced: string[] = [];
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  const open: typeof real.open = async (...args) => {
    const handle = await real.open(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => { synced.push(String(args[0])); return sync(); };
    return handle;
  };
  return { ...real, open, default: { ...real, open } };
});
const { writeAtomic } = await import('./fsx.ts');

describe('a file written whole', () => {
  it('is on the disk before it takes the old one\'s name, and so is the name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fsx-sync-'));
    const path = join(dir, 'stage.json');
    await writeAtomic(path, '{"rooms":[]}');
    expect(await readFile(path, 'utf8')).toBe('{"rooms":[]}');
    expect(synced).toEqual([`${path}.tmp`, dir]);
  });
});
