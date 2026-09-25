import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, gunzipSync } from 'node:zlib';
import type { Backup } from '../../shared/openends.ts';
import { packTar, tarEntries } from './tar.ts';

// One archive of everything the founder wrote, and a way back from it. What a backup is for is the day the machine
// is gone, so it holds the words and leaves behind everything that can be made again: browser profiles, the search
// index, caches, and the trash the app keeps for undoing things.
export const KEEP = 5;
const MADE = /^cubicle-(\d{4}-\d{2}-\d{2}-\d{4})\.tar\.gz$/;
const AGAIN = [/^browsers(\/|$)/, /^\.index(\/|$)/, /^\.cache(\/|$)/, /^trash(\/|$)/, /^backups(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.git(\/|$)/, /(^|\/)\.DS_Store$/];

export const leaveOut = (path: string) => AGAIN.some((pattern) => pattern.test(path));
// Where they go. The founder's own folder, unless this machine says otherwise — which is what a test sets.
export const backupDir = (env: NodeJS.ProcessEnv = process.env) => env.STAGE_BACKUP_DIR || join(homedir(), 'Cubicle backups');
// The folder the app itself uses. A check run works on a throwaway workspace and has no business writing into the
// founder's own folders, so in fake mode its backups land beside that workspace unless the machine says otherwise.
export const backupDirOf = (deps: { fake: boolean; workspace: string }, env: NodeJS.ProcessEnv = process.env) =>
  (deps.fake && !env.STAGE_BACKUP_DIR ? join(deps.workspace, 'backups') : backupDir(env));

const stamp = (at: number) => {
  const when = new Date(at);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}-${two(when.getHours())}${two(when.getMinutes())}`;
};

export async function listBackups(dir: string): Promise<Backup[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => MADE.test(name));
  const found = await Promise.all(names.map(async (file) => {
    const where = await stat(join(dir, file)).catch(() => null);
    return where ? { file, at: where.mtimeMs, bytes: where.size } : null;
  }));
  return found.filter((one): one is Backup => !!one).sort((one, other) => other.at - one.at);
}

// Written under a working name and renamed once it is whole, so a half-written archive is never mistaken for a backup.
// Five are kept: older ones go, and the founder is told in the same breath how many that was.
export async function makeBackup(options: { workspace: string; dir?: string; now?: () => number; keep?: number }): Promise<{ backup: Backup; dropped: number; problems: string[] }> {
  const { workspace, dir = backupDir(), now = Date.now, keep = KEEP } = options;
  await mkdir(dir, { recursive: true });
  const file = `cubicle-${stamp(now())}.tar.gz`;
  const [working, done] = [join(dir, `.${file}.part`), join(dir, file)];
  const problems: string[] = [];
  try {
    await pipeline(packTar(workspace, leaveOut, (why) => problems.push(why)), createGzip({ level: 6 }), createWriteStream(working));
    await rename(working, done);
  } catch (error) {
    await rm(working, { force: true });
    throw error;
  }
  const held = await listBackups(dir);
  const old = held.slice(keep);
  for (const one of old) await rm(join(dir, one.file), { force: true });
  const where = await stat(done);
  return { backup: { file, at: where.mtimeMs, bytes: where.size }, dropped: old.length, problems };
}

// Where an entry in an archive is allowed to land: inside the new folder, under its own name, and nowhere else.
// Anything absolute, anything that climbs out with "..", and every kind of link is refused by name.
export function landingPlace(into: string, name: string, kind: string): string {
  if (kind === '1' || kind === '2') throw new Error(`"${name}" is a link, and a restore never puts links back`);
  const path = name.replace(/\/+$/, '');
  if (!path) throw new Error('an entry in this backup has no name');
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.split('/').includes('..')) throw new Error(`"${name}" would land outside the new folder, so nothing was unpacked`);
  const full = resolve(into, path);
  if (full !== resolve(into) && !full.startsWith(resolve(into) + sep)) throw new Error(`"${name}" would land outside the new folder, so nothing was unpacked`);
  return full;
}

// Into a new folder, always. The live workspace is never written to, so a restore can be looked at first and moved
// into place by hand — and a backup from somewhere else can never overwrite today's work.
export async function restore(archive: string, into: string): Promise<{ files: number; into: string }> {
  const held = await readdir(into).catch(() => null);
  if (held?.length) throw new Error(`${into} already has something in it. A restore only ever goes into a new, empty folder.`);
  const entries = tarEntries(gunzipSync(await readFile(archive)));
  if (!entries.length) throw new Error('there is nothing in that backup');
  // Every name is checked before a single byte is written: a bad archive leaves an empty folder, not half a workspace.
  const places = entries.map((entry) => ({ entry, full: landingPlace(into, entry.name, entry.kind) }));
  let files = 0;
  for (const { entry, full } of places) {
    if (entry.kind === '5') { await mkdir(full, { recursive: true }); continue; }
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, entry.body);
    files += 1;
  }
  return { files, into };
}
