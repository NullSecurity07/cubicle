import { createWriteStream, readFileSync, statSync } from 'node:fs';
import { access, constants, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, gunzipSync } from 'node:zlib';
import type { Backup } from '../../shared/openends.ts';
import { packTar, tarEntries } from './tar.ts';

// One archive of everything the founder wrote, and a way back from it. What a backup is for is the day the machine
// is gone, so it holds the words and leaves behind everything that can be made again: browser profiles, the search
// index, caches, and the trash the app keeps for undoing things.
export const KEEP = 5;
const MADE = /^cubicle-(\d{4}-\d{2}-\d{2}-\d{4})\.tar\.gz$/;
const AGAIN = [/^browsers(\/|$)/, /^\.index(\/|$)/, /^\.cache(\/|$)/, /^trash(\/|$)/, /^backups(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.git(\/|$)/, /(^|\/)\.DS_Store$/, /^backup-to\.json$/];

export const leaveOut = (path: string) => AGAIN.some((pattern) => pattern.test(path));
// Where they go on this machine when nothing else is said: the founder's own folder, or STAGE_BACKUP_DIR.
export const backupDir = (env: NodeJS.ProcessEnv = process.env, home = homedir()) => env.STAGE_BACKUP_DIR || join(home, 'Cubicle backups');

// The folder the founder chose for one workspace ("Back up to…" in Health), kept inside that workspace, so a choice
// made for one workspace never sends another one's backups there.
const CHOICE = 'backup-to.json';
export function chosenBackupDir(workspace: string): string | null {
  try {
    const dir = (JSON.parse(readFileSync(join(workspace, CHOICE), 'utf8')) as { dir?: unknown }).dir;
    return typeof dir === 'string' && dir.trim() ? dir : null;
  } catch { return null; }
}
export async function chooseBackupDir(workspace: string, dir: string | null): Promise<void> {
  const path = join(workspace, CHOICE);
  if (!dir) { await rm(path, { force: true }); return; }
  await mkdir(workspace, { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify({ dir }, null, 2));
  await rename(`${path}.tmp`, path);
}

// The folder the app itself uses, asked each time. The machine's STAGE_BACKUP_DIR first; then the folder chosen for
// this workspace; then, for the app's own workspace, the founder's own folder. Any other workspace (a check run, a
// scratch run, a second company) keeps its backups beside it, in its own "backups": it has no business writing into
// the founder's folder, and a scratch run once did.
// `withChoice` false asks where they would go without the founder's choice: the default "Use the default" returns to.
// The founder's app runs from the main checkout, whose .git is a folder. A worktree or a second checkout has a .git
// file (or none): a run from there is somebody working on the app, and its keep-five rule must never reach the
// founder's own backups.
const mainCheckout = (root: string) => { try { return statSync(join(root, '.git')).isDirectory(); } catch { return false; } };
export const backupDirOf = (deps: { fake: boolean; workspace: string; root: string }, env: NodeJS.ProcessEnv = process.env, withChoice = true, home = homedir()) => {
  if (env.STAGE_BACKUP_DIR) return env.STAGE_BACKUP_DIR;
  const chosen = withChoice ? chosenBackupDir(deps.workspace) : null;
  if (chosen) return chosen;
  const own = !deps.fake && resolve(deps.workspace) === resolve(deps.root, 'workspace') && mainCheckout(deps.root);
  return own ? backupDir(env, home) : join(deps.workspace, 'backups');
};

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

// Could a backup be written there right now? Asked without writing anything: the folder itself if it is there, or the
// nearest folder above it that is, since a backup makes the rest. A drive that is not plugged in says no here.
export async function canWrite(dir: string): Promise<boolean> {
  let at = resolve(dir);
  for (;;) {
    const found = await stat(at).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : undefined));
    if (found === undefined) return false;
    if (found) return found.isDirectory() && (await access(at, constants.W_OK).then(() => true, () => false));
    const up = dirname(at);
    if (up === at) return false;
    at = up;
  }
}

// Is the backup folder on the disk the workspace is on? Then the day that disk dies takes both. Asked of the folder
// itself if it is there, or the nearest folder above it that is, since a backup makes the rest. When it cannot tell
// (a folder it may not look at), it does not claim they share a disk. `look` is `stat`, or a stand-in in a test.
export type StatDev = (path: string) => Promise<{ dev: number }>;
export async function sameDisk(workspace: string, dir: string, look: StatDev = stat): Promise<boolean> {
  try {
    const home = (await look(resolve(workspace))).dev;
    for (let at = resolve(dir); ; at = dirname(at)) {
      const found = await look(at).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (found) return found.dev === home;
      if (dirname(at) === at) return false;
    }
  } catch { return false; }
}

// A backup is due when the newest is a day old, or when there is none.
export const DUE_AFTER = 86_400_000;
// One that failed (the drive unplugged, the disk full) is tried again an hour later, not on every tick.
const RETRY_AFTER = 3_600_000;

// The backup nobody has to remember. Asked on the half-minute tick; it makes one only when one is due, with the same
// makeBackup and the same five kept as the button in Health.
export function autoBackup(options: { workspace: string; dir: () => string; now?: () => number; log?: (line: string) => void }) {
  const { workspace, dir, now = Date.now, log = (line) => console.log(line) } = options;
  let failedAt = -Infinity;
  return {
    async tick(): Promise<{ made?: Awaited<ReturnType<typeof makeBackup>>; problem?: string; where?: string } | null> {
      if (now() - failedAt < RETRY_AFTER) return null;
      const where = dir();
      const newest = (await listBackups(where))[0];
      if (newest && now() - newest.at < DUE_AFTER) return null;
      try {
        const made = await makeBackup({ workspace, dir: where, now });
        failedAt = -Infinity;
        return { made };
      } catch (error) {
        failedAt = now();
        const problem = (error as Error).message;
        log(`the daily backup to ${where} failed: ${problem}`);
        return { problem, where };
      }
    },
  };
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
