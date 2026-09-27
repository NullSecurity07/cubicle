import { copyFile, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { trashStamp } from './clock.ts';
import { writeAtomic } from './fsx.ts';
import { listBackups } from './openends/backup.ts';
import { tarEntries } from './openends/tar.ts';

// A file the app could not read (a crash left half of it, or a hand edit broke it): where it was, where the damaged
// copy was moved to, and the backup it was put back from, or null when none held it and it started again. `what` is
// how the founder knows the file, for a file that is not the stage or a conversation.
export type Damage = { file: string; aside: string; from: { file: string; at: number } | null; what?: { thing: string; again: string; first: string } };

// The newest copy of a workspace file (by its path in the workspace, with forward slashes) that parses, from the
// backups in `where`, newest first; null when no backup holds one.
export async function backupCopy(where: string | null | undefined, name: string): Promise<{ text: string; file: string; at: number } | null> {
  if (!where) return null;
  for (const one of await listBackups(where)) {
    try {
      const entry = tarEntries(gunzipSync(await readFile(join(where, one.file)))).find((held) => held.name === name && held.kind === '0');
      if (!entry) continue;
      const text = entry.body.toString('utf8');
      JSON.parse(text);
      return { text, file: one.file, at: one.at };
    } catch { /* an unreadable archive, or a damaged copy in it: try the one before */ }
  }
  return null;
}

// Where the side books (promises, bets, boards, Needs you, the partner's notes) find the backups and whom they tell
// about a damaged file. The app sets both as it starts; until then nothing is put back and the damage is only kept.
export const bookRescue: { backups: () => string | null; tell: (damage: Damage) => void } = { backups: () => null, tell: () => {} };

const rescuing = new Map<string, Promise<unknown>>();

// A side book read from disk: what it holds, or null when there is no such file yet. A file that will not parse used
// to read as an empty book, and the next change wrote the empty book over it: the founder's promises, bets or tasks
// gone without a word. Now it is rescued as the stage is: the good copy is found in the newest backup first, the
// damaged file is copied aside beside it as <name>.corrupt-<time>.json, and the good copy (or `empty`, when no backup
// holds one) is renamed over it, so the path is never missing; then the founder is told. The file is looked at again
// just before, so a second reader never moves aside a good copy the first one put back. Any other failure to read is
// thrown, never taken for an empty book.
export async function readBook<T>(path: string, workspace: string, rescue: { empty: T; what: Damage['what'] }): Promise<T | null> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try { return JSON.parse(text) as T; } catch { /* damaged: rescued below */ }
  let job = rescuing.get(path);
  if (!job) {
    job = mend(path, workspace, rescue).finally(() => rescuing.delete(path));
    rescuing.set(path, job);
  }
  return structuredClone(await job) as T;
}

async function mend<T>(path: string, workspace: string, rescue: { empty: T; what: Damage['what'] }): Promise<T> {
  const file = relative(workspace, path).split(sep).join('/');
  const found = await backupCopy(bookRescue.backups(), file);
  const now = await readFile(path, 'utf8').catch(() => null);
  if (now === null) return rescue.empty;
  try { return JSON.parse(now) as T; } catch { /* still damaged: this reader is the one to put it back */ }
  const aside = join(dirname(path), `${basename(path, '.json')}.corrupt-${trashStamp()}.json`);
  await copyFile(path, aside);
  const text = found?.text ?? JSON.stringify(rescue.empty, null, 2);
  await writeAtomic(path, text, { mkdir: true });
  bookRescue.tell({ file, aside, from: found ? { file: found.file, at: found.at } : null, what: rescue.what });
  return JSON.parse(text) as T;
}
