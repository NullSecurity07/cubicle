import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

// A file written whole or not at all: to a side file first, then renamed over the old one, so a reader never sees half.
// Each write has its own side file, so two writes to one path at once never share one and trip over each other.
let sides = 0;
export async function writeAtomic(path: string, text: string | Buffer, options: { mkdir?: boolean } = {}) {
  if (options.mkdir) await mkdir(dirname(path), { recursive: true });
  // The bytes are pushed to the disk before the rename, and the folder after it: without that, a power cut soon after
  // can leave the new name pointing at an empty file, which is worse than the old one.
  const side = `${path}.${process.pid}-${(sides += 1)}.tmp`;
  const file = await open(side, 'w');
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  await rename(side, path).catch(async (error) => { await rm(side, { force: true }); throw error; });
  const folder = await open(dirname(path), 'r').catch(() => null);
  if (folder) { try { await folder.sync(); } catch { /* not every system lets a folder be synced */ } finally { await folder.close(); } }
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

// An id that is safe to name a file by: lower-case letters, digits and dashes, starting with a letter or digit.
export const safeId = (id: string, max = 64) => {
  if (!new RegExp(`^[a-z0-9][a-z0-9-]{0,${max - 1}}$`).test(id)) throw new Error(`bad id: ${id}`);
  return id;
};
// A name made into an id: what the founder called it, so the file in the workspace is the thing they named.
export const slugOf = (name: string, fallback: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || fallback;
// The first of `base`, `base-2`, `base-3`… that no file in the folder is named yet.
export async function freshId(folder: string, base: string, extension: string) {
  const taken = new Set((await readdir(folder).catch(() => [] as string[])).map((name) => (name.endsWith(extension) ? name.slice(0, -extension.length) : name)));
  for (let count = 1; ; count += 1) { const id = count === 1 ? base : `${base}-${count}`; if (!taken.has(id)) return id; }
}
