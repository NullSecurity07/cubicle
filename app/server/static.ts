import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

// The built client, for the desktop shell. Unknown paths get the index; nothing outside `dir` is ever read.
export async function readStatic(dir: string, urlPath: string): Promise<{ body: Buffer; type: string } | null> {
  const wanted = normalize(join(dir, decodeURIComponent(urlPath)));
  const inside = wanted === dir || wanted.startsWith(dir + sep);
  for (const path of inside && extname(wanted) ? [wanted, join(dir, 'index.html')] : [join(dir, 'index.html')]) {
    try {
      return { body: await readFile(path), type: TYPES[extname(path)] ?? 'application/octet-stream' };
    } catch { /* try the index next */ }
  }
  return null;
}
