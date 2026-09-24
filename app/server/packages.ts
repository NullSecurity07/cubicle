import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeAtomic } from './fsx.ts';

type Entry = { name: string; file_name: string; sha256: string; depends: string[]; imports: string[] };
export type Lock = { packages: Record<string, Entry> };

const MAX_BYTES = 200_000_000;
const pyodideDir = () => realpathSync(resolve(import.meta.dirname, '../node_modules/pyodide'));
export const readLock = (): Lock => JSON.parse(readFileSync(join(pyodideDir(), 'pyodide-lock.json'), 'utf8')) as Lock;
// Read once: it cannot change while the server runs, and a run with packages asks for it every time.
let version: string | undefined;
export const pyodideVersion = (): string => (version ??= JSON.parse(readFileSync(join(pyodideDir(), 'package.json'), 'utf8')).version as string);

// The Pyodide packages a piece of code needs: what it imports, mapped through the lock file, plus everything those depend on.
// Only packages from Pyodide's own lock file count; anything else is left for Python to report as missing.
export function packagesFor(code: string, lock: Lock): string[] {
  const byImport = new Map<string, string>();
  for (const [key, entry] of Object.entries(lock.packages)) for (const name of entry.imports ?? []) byImport.set(name.split('.')[0], key);
  const wanted = new Set<string>();
  const take = (key: string) => { if (wanted.has(key) || !lock.packages[key]) return; wanted.add(key); for (const dep of lock.packages[key].depends ?? []) take(lock.packages[dep] ? dep : dep.toLowerCase()); };
  for (const [, from, plain] of code.matchAll(/^[ \t]*(?:from[ \t]+([A-Za-z_]\w*)|import[ \t]+([^\n#]+))/gm)) {
    for (const name of from ? [from] : plain.split(',').map((part) => part.trim().split(/[ \t.]/)[0])) { const key = byImport.get(name); if (key) take(key); }
  }
  return [...wanted].sort();
}

// Makes sure the wheels are on disk. This runs in the server, which has the network; the sandbox never does.
// Every file must match the SHA-256 in Pyodide's lock file, or it is thrown away.
export async function ensurePackages(names: string[], cacheDir: string, lock: Lock, version: string, http: typeof fetch = fetch): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  let total = 0;
  for (const name of names) {
    const entry = lock.packages[name];
    const path = join(cacheDir, entry.file_name);
    if (await access(path).then(() => true, () => false)) continue;
    const response = await http(`https://cdn.jsdelivr.net/pyodide/v${version}/full/${entry.file_name}`, { signal: AbortSignal.timeout(180_000) }).catch(() => null);
    if (!response?.ok) throw new Error(`${name} needs a one-time download and it could not be fetched. Check the connection and try again.`);
    const data = Buffer.from(await response.arrayBuffer());
    total += data.length;
    if (total > MAX_BYTES) throw new Error('these packages are too large to load');
    if (createHash('sha256').update(data).digest('hex') !== entry.sha256) throw new Error(`${name} did not match its published checksum and was discarded`);
    await writeAtomic(path, data);
  }
}
