import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// A file written whole or not at all: to a side file first, then renamed over the old one, so a reader never sees half.
export async function writeAtomic(path: string, text: string | Buffer, options: { mkdir?: boolean } = {}) {
  if (options.mkdir) await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
}

// What a folder of small files says, read once and kept while nothing changes. Whatever this process writes drops it
// (`drop`); a file added, removed or renamed in by hand moves the folder's own time, and that is looked at on every
// read. Every caller gets its own copy, so nobody can change what the next one is handed.
export function folderCache<T>(folder: string, read: () => Promise<T[]>) {
  let held: { at: number; list: T[] } | null = null;
  const timeOf = () => stat(folder).then((info) => info.mtimeMs, () => -1);
  return {
    async get(): Promise<T[]> {
      const at = await timeOf();
      if (held && held.at === at) return structuredClone(held.list);
      const list = await read();
      // Only kept when the folder did not change while it was being read.
      if ((await timeOf()) === at) held = { at, list: structuredClone(list) };
      return list;
    },
    drop() { held = null; },
  };
}
