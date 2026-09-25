import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecisions } from './decisions.ts';
import { folderCache, writeAtomic } from './fsx.ts';
import { createSkills } from './skills.ts';

describe('a folder read once', () => {
  it('reads again only when the folder changed or this process wrote to it, and hands out copies', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'fsx-'));
    let reads = 0;
    const cache = folderCache(folder, async () => { reads += 1; return [{ names: await readdir(folder) }]; });
    expect(await cache.get()).toEqual([{ names: [] }]);
    (await cache.get())[0].names.push('changed by a caller');
    expect(await cache.get()).toEqual([{ names: [] }]);
    expect(reads).toBe(1);
    // Somebody put a file in by hand.
    await writeFile(join(folder, 'a.md'), 'x');
    expect(await cache.get()).toEqual([{ names: ['a.md'] }]);
    expect(reads).toBe(2);
    cache.drop();
    await cache.get();
    expect(reads).toBe(3);
  });

  it('writes a file whole, making its folder when asked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fsx-'));
    await writeAtomic(join(dir, 'deep', 'one.txt'), 'hello', { mkdir: true });
    expect(await readFile(join(dir, 'deep', 'one.txt'), 'utf8')).toBe('hello');
    expect(await readdir(join(dir, 'deep'))).toEqual(['one.txt']);
  });

  it('keeps the decisions and the playbook true across saves and removals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fsx-'));
    const decisions = createDecisions(dir);
    expect(await decisions.list()).toEqual([]);
    const made = await decisions.record({ title: 'Price at 20', chosen: '20 a month' });
    expect((await decisions.list()).map((one) => one.id)).toEqual([made.id]);
    await decisions.remove(made.id);
    expect(await decisions.list()).toEqual([]);

    const skills = createSkills(dir);
    const skill = await skills.create({ name: 'Ship', when: 'When shipping', procedure: ['Do it'], verify: 'Done', by: { roomId: 'build', name: 'Dev' }, source: { kind: 'run', ref: '' } });
    await skills.setState(skill.id, 'off');
    expect((await skills.list())[0].state).toBe('off');
    await skills.remove(skill.id);
    expect(await skills.list()).toEqual([]);
  });
});
