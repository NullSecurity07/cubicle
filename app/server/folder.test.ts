import { mkdtemp, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectDir } from './folder.ts';

describe('projectDir', () => {
  it('takes a real folder and refuses what is missing, relative or far too broad', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'proj-'));
    await mkdir(join(dir, 'app', 'workspace'), { recursive: true });
    expect(projectDir(`${dir}/app/`)).toBe(join(dir, 'app'));
    expect(() => projectDir('')).toThrow(/full folder path/);
    expect(() => projectDir('code/app')).toThrow(/full folder path/);
    expect(() => projectDir(join(dir, 'nope'))).toThrow(/no folder/);
    expect(() => projectDir('/')).toThrow(/too broad/);
    expect(() => projectDir(homedir())).toThrow(/too broad/);
    expect(() => projectDir('~')).toThrow(/too broad/);
    expect(() => projectDir(join(dir, 'app'), [join(dir, 'app', 'workspace')])).toThrow(/too broad/);
  });
});
