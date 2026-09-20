import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Undone } from '../../shared/safety.ts';

// A copy of the project folder, taken the moment before a coding agent is let into it, kept in a store of this app's
// own. The project's own repository, its index, its branches and its hooks are never touched and never trusted: git
// is told where to keep its own bookkeeping, told to read no configuration, and told to run no hooks.
export type Checkpoint = {
  id: string; roomId: string; dir: string; store: string; commit: string; at: number;
  // What the step left behind: every path that differs from the snapshot, and what it hashed to when the step ended.
  // A path the step deleted is null. Filled in once the step is over; until then there is nothing to put back.
  after?: Record<string, string | null>;
};
const KEEP = 20;
const KEEP_MS = 7 * 86_400_000;
// A snapshot is for the founder's own work, not for what a build left behind: anything this big is left where it is.
const BIG = 10_000_000;
const CHUNK = 400;
// More files than a project has is not a project — somebody wired a card to a whole disk. Counting stops there
// instead of walking it: a coding step must not wait on this, and a folder that big has no undo.
const TOO_MANY = 20_000;

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');
const fileHash = async (path: string) => readFile(path).then((bytes) => createHash('sha256').update(bytes).digest('hex'), () => null);

export function createCheckpoints(deps: { dir: string; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const folder = join(deps.dir, '.index', 'checkpoints');
  const indexPath = join(folder, 'index.json');
  let queue: Promise<unknown> = Promise.resolve();

  // Nothing of the project's own git reaches this: no configuration files, no hooks, no credential helper, and a
  // committer this app names itself.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: folder,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: 'Cubicle', GIT_AUTHOR_EMAIL: 'cubicle@localhost', GIT_COMMITTER_NAME: 'Cubicle', GIT_COMMITTER_EMAIL: 'cubicle@localhost',
  };
  const git = (store: string, dir: string, args: string[]) => new Promise<string | null>((done) => {
    execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', `--git-dir=${store}`, `--work-tree=${dir}`, ...args],
      { env, timeout: 60_000, maxBuffer: 32_000_000 }, (error, out) => done(error ? null : out));
  });
  const storeFor = (dir: string) => join(folder, hashOf(dir).slice(0, 16));
  // Everything in the folder that the project does not ignore, and never more than a project's worth: as soon as
  // there are too many, git is stopped mid-walk and the folder is left alone.
  const files = (store: string, dir: string) => new Promise<string[] | null>((done) => {
    const run = spawn('git', [`--git-dir=${store}`, `--work-tree=${dir}`, 'ls-files', '-co', '--exclude-standard', '-z'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    const found: string[] = [];
    let rest = '';
    let over = false;
    const timer = setTimeout(() => { over = true; run.kill('SIGTERM'); }, 30_000);
    run.stdout.on('data', (chunk: Buffer) => {
      const parts = (rest + chunk).split('\0');
      rest = parts.pop() ?? '';
      for (const path of parts) if (path) found.push(path);
      if (found.length > TOO_MANY) { over = true; run.kill('SIGTERM'); }
    });
    run.on('error', () => { clearTimeout(timer); done(null); });
    run.on('close', (code) => { clearTimeout(timer); done(over || code !== 0 ? null : found); });
  });

  const read = async (): Promise<Checkpoint[]> => JSON.parse((await readFile(indexPath, 'utf8').catch(() => '[]')) || '[]') as Checkpoint[];
  function write(list: Checkpoint[]) {
    const job = queue.then(async () => {
      await mkdir(folder, { recursive: true });
      await writeFile(`${indexPath}.tmp`, JSON.stringify(list, null, 2));
      await rename(`${indexPath}.tmp`, indexPath);
    });
    queue = job.catch(() => {});
    return job;
  }

  // Twenty snapshots of a folder, or a week, whichever runs out first. A folder nobody has a snapshot of any more
  // takes its store with it, because a founder's disk should not fill up with last month's undo.
  async function prune(list: Checkpoint[]): Promise<Checkpoint[]> {
    const perDir = new Map<string, number>();
    const kept: Checkpoint[] = [];
    for (const one of [...list].sort((a, b) => b.at - a.at)) {
      const count = (perDir.get(one.dir) ?? 0) + 1;
      perDir.set(one.dir, count);
      if (count <= KEEP && now() - one.at <= KEEP_MS) kept.push(one);
    }
    for (const gone of list.filter((one) => !kept.includes(one))) {
      if (!kept.some((one) => one.store === gone.store)) await rm(gone.store, { recursive: true, force: true }).catch(() => {});
    }
    return kept.sort((a, b) => a.at - b.at);
  }

  return {
    list: read,
    // Before the step. A folder that is not there, or a machine without git, gets no snapshot and no undo — the step
    // still runs, and the receipt says so.
    async take(id: string, roomId: string, dir: string): Promise<Checkpoint | null> {
      const store = storeFor(dir);
      await mkdir(folder, { recursive: true });
      // A store nothing came of is taken away again, so a folder that cannot be saved leaves nothing behind.
      const giveUp = async () => {
        if (!(await read()).some((one) => one.store === store)) await rm(store, { recursive: true, force: true }).catch(() => {});
        return null;
      };
      if ((await git(store, dir, ['init', '-q'])) === null) return giveUp();
      const listed = await files(store, dir);
      if (listed === null) return giveUp();
      const paths: string[] = [];
      for (let at = 0; at < listed.length; at += CHUNK) {
        const sizes = await Promise.all(listed.slice(at, at + CHUNK).map((path) => stat(join(dir, path)).then((found) => found.size, () => Infinity)));
        for (const [index, size] of sizes.entries()) if (size <= BIG) paths.push(listed[at + index]);
      }
      // The index is emptied first, so each snapshot is exactly the files that were there, and a file the founder
      // deleted between two steps is not quietly carried forward.
      if ((await git(store, dir, ['read-tree', '--empty'])) === null) return giveUp();
      for (let at = 0; at < paths.length; at += CHUNK) {
        if ((await git(store, dir, ['add', '--', ...paths.slice(at, at + CHUNK)])) === null) return giveUp();
      }
      if ((await git(store, dir, ['commit', '-q', '--no-verify', '--allow-empty', '-m', `before ${id}`])) === null) return giveUp();
      const commit = (await git(store, dir, ['rev-parse', 'HEAD']))?.trim();
      if (!commit) return giveUp();
      const point: Checkpoint = { id, roomId, dir, store, commit, at: now() };
      await write(await prune([...(await read()), point]));
      return point;
    },
    // After the step: what it changed, and what those files hold now. Anything the founder changes later will not
    // match this, and is left alone when they undo.
    async seal(id: string): Promise<boolean> {
      const list = await read();
      const point = list.find((one) => one.id === id);
      if (!point) return false;
      const changed = await git(point.store, point.dir, ['status', '--porcelain', '-z']);
      const records = (changed ?? '').split('\0').filter(Boolean);
      const paths: string[] = [];
      for (let at = 0; at < records.length; at += 1) {
        const record = records[at];
        paths.push(record.slice(3));
        // A rename is written as two records: the new path, then where it came from. Both are files that moved.
        if (/^[RC]/.test(record)) { at += 1; if (records[at]) paths.push(records[at]); }
      }
      const after: Record<string, string | null> = {};
      for (const path of [...new Set(paths)]) after[path] = await fileHash(join(point.dir, path));
      await write(list.map((one) => (one.id === id ? { ...one, after } : one)));
      return true;
    },
    // Put the folder back as it was. A file the founder has changed since the step is theirs, so it stays exactly as
    // they left it and is named to them; everything else goes back. One snapshot is used once.
    async undo(id: string): Promise<Undone> {
      const list = await read();
      const point = list.find((one) => one.id === id);
      if (!point || !point.after) throw new Error('there is no saved copy of that step, so there is nothing to put back');
      const restored: string[] = [];
      const kept: string[] = [];
      for (const [path, left] of Object.entries(point.after)) {
        if ((await fileHash(join(point.dir, path))) !== left) { kept.push(path); continue; }
        const inSnapshot = (await git(point.store, point.dir, ['cat-file', '-e', `${point.commit}:${path}`])) !== null;
        const put = inSnapshot
          ? (await git(point.store, point.dir, ['checkout', point.commit, '--', path])) !== null
          : await rm(join(point.dir, path), { force: true }).then(() => true, () => false);
        (put ? restored : kept).push(path);
      }
      await write(list.filter((one) => one.id !== id));
      return { dir: point.dir, roomId: point.roomId, restored: restored.sort(), kept: kept.sort() };
    },
  };
}
