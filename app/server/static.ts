import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { staticType } from './http.ts';

// What a player asked for out of a file: the first and last byte it wants, or 'bad' when the range falls outside the
// file, or nothing when it asked for the whole thing. WebKit will not play or seek a sound or a video without this.
export function rangeOf(header: string | undefined, size: number): { from: number; to: number } | 'bad' | null {
  const asked = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
  if (!asked || (!asked[1] && !asked[2])) return null;
  // "bytes=-500" means the last 500 bytes.
  const from = asked[1] ? Number(asked[1]) : Math.max(0, size - Number(asked[2]));
  const to = asked[1] && asked[2] ? Math.min(Number(asked[2]), size - 1) : size - 1;
  return from > to || from >= size ? 'bad' : { from, to };
}

// The built client, for the desktop shell. Unknown paths get the index; nothing outside `dir` is ever read.
export async function readStatic(dir: string, urlPath: string): Promise<{ body: Buffer; type: string } | null> {
  const wanted = normalize(join(dir, decodeURIComponent(urlPath)));
  const inside = wanted === dir || wanted.startsWith(dir + sep);
  for (const path of inside && extname(wanted) ? [wanted, join(dir, 'index.html')] : [join(dir, 'index.html')]) {
    try {
      return { body: await readFile(path), type: staticType(path) };
    } catch { /* try the index next */ }
  }
  return null;
}
