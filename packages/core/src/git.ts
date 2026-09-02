import { simpleGit, type SimpleGit } from 'simple-git';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function gitFor(root: string): SimpleGit {
  return simpleGit({ baseDir: root, trimmed: true });
}

export async function ensureRepo(root: string): Promise<SimpleGit> {
  const git = gitFor(root);
  if (!existsSync(path.join(root, '.git'))) {
    await git.init(['-b', 'main']).catch(() => git.init());
  }
  // A committer identity is required for commits; fall back to a local one if the owner has none.
  const name = await git.getConfig('user.name').then((c) => c.value).catch(() => null);
  if (!name) {
    await git.addConfig('user.name', 'cubicle', false, 'local');
    await git.addConfig('user.email', 'cubicle@localhost', false, 'local');
  }
  return git;
}

/** Stage everything and commit. Returns the commit hash, or null when nothing changed. Never throws on "nothing to commit". */
export async function autoCommit(root: string, message: string): Promise<string | null> {
  const git = await ensureRepo(root);
  try {
    await git.add(['-A']);
    const status = await git.status();
    if (status.staged.length === 0 && status.files.length === 0) return null;
    const res = await git.commit(message);
    return res.commit || null;
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (/nothing to commit/i.test(msg)) return null;
    throw err;
  }
}

export async function lastCommitHash(root: string): Promise<string | null> {
  try {
    const git = gitFor(root);
    const log = await git.log({ maxCount: 1 });
    return log.latest?.hash ?? null;
  } catch {
    return null;
  }
}

/** Files under `sub` changed in the working tree relative to HEAD. */
export async function changedFiles(root: string, sub = ''): Promise<string[]> {
  const git = gitFor(root);
  const out = await git.raw(['status', '--porcelain', '--', sub || '.']);
  return out.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
}
