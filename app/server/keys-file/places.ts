import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

// Where a founder would put a copy of their work that is not on this machine's disk: a USB drive, or a folder a sync
// service carries off it. Only folders that are there right now are offered, each with "Cubicle backups" inside it.
const SYNCED: [string, string][] = [
  ['Dropbox', 'Dropbox'], ['Nextcloud', 'Nextcloud'], ['OneDrive', 'OneDrive'], ['Google Drive', 'Google Drive'], ['GoogleDrive', 'Google Drive'],
  ['pCloudDrive', 'pCloud'], ['Sync', 'Syncthing'], ['MEGA', 'MEGA'], ['Library/Mobile Documents/com~apple~CloudDocs', 'iCloud Drive'],
];
const INSIDE = 'Cubicle backups';

type Look = { home?: string; user?: string; list?: (dir: string) => Promise<string[]>; isDir?: (path: string) => Promise<boolean> };
const folders = async (dir: string) => (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((one) => one.isDirectory()).map((one) => one.name);
const isFolder = async (path: string) => (await stat(path).catch(() => null))?.isDirectory() ?? false;

export async function backupPlaces(look: Look = {}): Promise<{ label: string; path: string }[]> {
  const home = look.home ?? homedir();
  const user = look.user ?? userInfo().username;
  const list = look.list ?? folders;
  const isDir = look.isDir ?? isFolder;
  const found: { label: string; path: string }[] = [];
  // Drives the desktop mounted for this user: /run/media/<user> on most Linux desktops, /media/<user> on Ubuntu, /Volumes on a Mac.
  for (const root of [join('/run/media', user), join('/media', user), '/Volumes']) {
    for (const drive of await list(root)) if (drive !== 'Macintosh HD') found.push({ label: drive, path: join(root, drive, INSIDE) });
  }
  for (const [folder, label] of SYNCED) {
    const path = join(home, folder);
    if (await isDir(path) && !found.some((one) => one.label === label)) found.push({ label, path: join(path, INSIDE) });
  }
  return found;
}

// A folder the founder typed, made ready to hold backups: a whole path (a leading ~ is their home), not inside the
// workspace it would be copying, made if it is not there, and written to once to be sure it can be.
export async function readyFolder(typed: string, workspace: string, home = homedir()): Promise<string> {
  const trimmed = typed.trim().replace(/^~(?=$|\/)/, home);
  if (!trimmed) throw new Error('say which folder');
  if (!isAbsolute(trimmed)) throw new Error('give the whole path to the folder, starting with / (or ~ for your home)');
  const path = resolve(trimmed);
  const within = relative(resolve(workspace), path);
  if (!within || (!within.startsWith('..') && !isAbsolute(within))) throw new Error('that folder is inside the workspace it would be copying. Pick one outside it: a USB drive, or a synced folder.');
  try {
    await mkdir(path, { recursive: true });
    const probe = join(path, `.cubicle-write-test-${process.pid}`);
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
  } catch (error) {
    throw new Error(`nothing can be written to ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  return path;
}
