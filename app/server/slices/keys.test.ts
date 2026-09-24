import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readKeys } from './keys.ts';

describe('keys.json', () => {
  const file = async (text?: string) => {
    const path = join(await mkdtemp(join(tmpdir(), 'keys-')), 'keys.json');
    if (text !== undefined) await writeFile(path, text);
    return path;
  };

  it('changes nothing when there is no file', async () => {
    expect(await readKeys(await file())).toEqual({ keys: {}, problems: [] });
  });

  it('says so, and keeps every default, when the file is not JSON', async () => {
    const read = await readKeys(await file('{ "command-bar": ['));
    expect(read.keys).toEqual({});
    expect(read.problems[0]).toContain('not valid JSON');
  });

  it('takes the good keys and refuses a duplicate in one sentence', async () => {
    const read = await readKeys(await file(JSON.stringify({ 'command-bar': ['Mod+P'], decisions: ['N'] })));
    expect(read.keys).toEqual({ 'command-bar': ['Mod+P'] });
    expect(read.problems).toEqual(['N is already "Open Needs you: what waits for you" (needs), so "decisions" keeps D.']);
  });
});
