import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';

// A tar writer and reader of our own, in the oldest and plainest form there is (ustar), so a backup can be opened by
// anything on any machine — `tar xzf` included — and nothing has to be installed to make one.
// Everything here works in 512-byte blocks, which is what tar is.
const BLOCK = 512;
const NAME = 100;
const PREFIX = 155;
export const END = Buffer.alloc(BLOCK * 2);
export type Held = { name: string; size: number; kind: '0' | '5' | string; link: string };

const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, '0').slice(-(width - 1));
const put = (block: Buffer, text: string, at: number, width: number) => { block.write(text.slice(0, width), at, width, 'utf8'); };

// A path longer than a hundred characters is split over tar's two name fields at a slash. One that cannot be split
// that way is refused in words rather than written down wrong: a backup that unpacks to the wrong place is worse
// than one file that was named and left out.
export function splitPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= NAME) return { name: path, prefix: '' };
  for (let at = path.indexOf('/'); at >= 0; at = path.indexOf('/', at + 1)) {
    const [prefix, name] = [path.slice(0, at), path.slice(at + 1)];
    if (Buffer.byteLength(prefix) <= PREFIX && Buffer.byteLength(name) <= NAME && name) return { name, prefix };
  }
  throw new Error(`this name is too long for a backup and was left out: ${path}`);
}

export function tarBlock(path: string, size: number, mtime: number, kind: '0' | '5' = '0', mode = kind === '5' ? 0o755 : 0o644): Buffer {
  const { name, prefix } = splitPath(kind === '5' && !path.endsWith('/') ? `${path}/` : path);
  const block = Buffer.alloc(BLOCK);
  put(block, name, 0, NAME);
  put(block, `${octal(mode, 8)}\0`, 100, 8);
  put(block, `${octal(0, 8)}\0`, 108, 8);
  put(block, `${octal(0, 8)}\0`, 116, 8);
  put(block, `${octal(kind === '5' ? 0 : size, 12)}\0`, 124, 12);
  put(block, `${octal(Math.floor(mtime / 1000), 12)}\0`, 136, 12);
  block.fill(' ', 148, 156);
  put(block, kind, 156, 1);
  put(block, 'ustar\0', 257, 6);
  put(block, '00', 263, 2);
  put(block, prefix, 345, PREFIX);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(block, `${octal(sum, 7)}\0 `, 148, 8);
  return block;
}

const pad = (size: number) => (size % BLOCK ? Buffer.alloc(BLOCK - (size % BLOCK)) : null);

// Everything under a folder, deepest last, as one tar. `skip` is asked with each path relative to the folder, so a
// whole subtree can be left out before it is walked. Links are never followed: a backup holds this folder only.
export async function* packTar(dir: string, skip: (path: string) => boolean = () => false, onProblem: (why: string) => void = () => {}): AsyncGenerator<Buffer> {
  async function* walk(here: string, base: string): AsyncGenerator<Buffer> {
    const found = await readdir(here, { withFileTypes: true }).catch(() => []);
    for (const entry of found.sort((one, other) => one.name.localeCompare(other.name))) {
      const path = base ? posix.join(base, entry.name) : entry.name;
      if (skip(path) || entry.isSymbolicLink()) continue;
      const full = join(here, entry.name);
      try {
        if (entry.isDirectory()) {
          const where = await stat(full);
          yield tarBlock(path, 0, where.mtimeMs, '5');
          yield* walk(full, path);
        } else if (entry.isFile()) {
          const where = await stat(full);
          yield tarBlock(path, where.size, where.mtimeMs);
          let written = 0;
          for await (const chunk of createReadStream(full)) { written += (chunk as Buffer).length; yield chunk as Buffer; }
          // A file somebody wrote to while we were reading it: the header is already out, so the block count must match it.
          if (written < where.size) yield Buffer.alloc(where.size - written);
          const rest = pad(where.size);
          if (rest) yield rest;
        }
      } catch (error) { onProblem((error as Error).message); }
    }
  }
  yield* walk(dir, '');
  yield END;
}

// The other way round: what a tar holds, in the order it holds it. A damaged tail stops the reading rather than
// throwing, because half a backup read is still every file before the damage.
export function tarEntries(buffer: Buffer): (Held & { body: Buffer })[] {
  const found: (Held & { body: Buffer })[] = [];
  for (let at = 0; at + BLOCK <= buffer.length;) {
    const block = buffer.subarray(at, at + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const read = (from: number, width: number) => block.subarray(from, from + width).toString('utf8').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(read(124, 12) || '0', 8) || 0;
    const prefix = read(345, PREFIX);
    const name = read(0, NAME);
    if (!name) break;
    found.push({ name: prefix ? `${prefix}/${name}` : name, size, kind: read(156, 1) || '0', link: read(157, NAME), body: buffer.subarray(at + BLOCK, at + BLOCK + size) });
    at += BLOCK + size + (size % BLOCK ? BLOCK - (size % BLOCK) : 0);
  }
  return found;
}
