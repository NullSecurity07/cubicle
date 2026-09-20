import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCheckpoints } from './checkpoints.ts';

const git = (args: string[], cwd: string) => new Promise<void>((done) => { execFile('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }, () => done()); });

// A project folder with a repository of its own, the way a founder's really is.
async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'project-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, '.gitignore'), 'ignored/\n');
  await mkdir(join(dir, 'ignored'), { recursive: true });
  await writeFile(join(dir, 'ignored', 'cache.bin'), 'nothing anybody wants back');
  for (const name of ['one', 'two', 'three']) await writeFile(join(dir, 'src', `${name}.ts`), `export const ${name} = 1;\n`);
  await git(['init', '-q'], dir);
  return dir;
}
const read = (dir: string, name: string) => readFile(join(dir, 'src', name), 'utf8');

describe('checkpoints', () => {
  it('puts back what the step changed and leaves what the founder changed since', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'workspace-'));
    const dir = await project();
    const checkpoints = createCheckpoints({ dir: workspace });
    expect(await checkpoints.take('call-1', 'build', dir)).not.toBeNull();

    // The run changes three files and adds a fourth.
    for (const name of ['one', 'two', 'three']) await writeFile(join(dir, 'src', `${name}.ts`), `export const ${name} = 2;\n`);
    await writeFile(join(dir, 'src', 'four.ts'), 'export const four = 1;\n');
    expect(await checkpoints.seal('call-1')).toBe(true);

    // The founder reads what it did and keeps one of the three by hand.
    await writeFile(join(dir, 'src', 'two.ts'), 'export const two = 2; // I want this\n');

    const put = await checkpoints.undo('call-1');
    expect(put.restored).toEqual(['src/four.ts', 'src/one.ts', 'src/three.ts']);
    expect(put.kept).toEqual(['src/two.ts']);
    expect(await read(dir, 'one.ts')).toBe('export const one = 1;\n');
    expect(await read(dir, 'three.ts')).toBe('export const three = 1;\n');
    expect(await read(dir, 'two.ts')).toBe('export const two = 2; // I want this\n');
    await expect(read(dir, 'four.ts')).rejects.toThrow();

    // One snapshot is used once, and the project's own repository never heard about any of it.
    await expect(checkpoints.undo('call-1')).rejects.toThrow('nothing to put back');
    expect(await readFile(join(dir, '.git', 'HEAD'), 'utf8')).toContain('ref:');
    await expect(readFile(join(dir, '.git', 'index'))).rejects.toThrow();
  });

  it('respects what the project ignores, and says no when there is no folder to save', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'workspace-'));
    const dir = await project();
    const checkpoints = createCheckpoints({ dir: workspace });
    await checkpoints.take('call-2', 'build', dir);
    await rm(join(dir, 'ignored'), { recursive: true, force: true });
    await writeFile(join(dir, 'src', 'one.ts'), 'changed\n');
    await checkpoints.seal('call-2');
    const put = await checkpoints.undo('call-2');
    expect(put.restored).toEqual(['src/one.ts']);
    // A folder nobody ignored would have come back; an ignored one was never copied in the first place.
    await expect(readFile(join(dir, 'ignored', 'cache.bin'), 'utf8')).rejects.toThrow();

    expect(await checkpoints.take('call-3', 'build', join(dir, 'nowhere'))).toBeNull();
    expect(await checkpoints.seal('call-3')).toBe(false);
  });

  it('keeps the last twenty snapshots of a folder and nothing older than a week', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'workspace-'));
    const dir = await project();
    let now = new Date('2026-09-20T09:00:00').getTime();
    const checkpoints = createCheckpoints({ dir: workspace, now: () => now });
    for (let at = 0; at < 22; at += 1) { now += 60_000; await checkpoints.take(`call-${at}`, 'build', dir); }
    expect((await checkpoints.list()).map((one) => one.id)).toEqual(Array.from({ length: 20 }, (_, at) => `call-${at + 2}`));
    now += 8 * 86_400_000;
    await checkpoints.take('call-later', 'build', dir);
    expect((await checkpoints.list()).map((one) => one.id)).toEqual(['call-later']);
  });
});
