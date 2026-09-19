import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rangeOf, readStatic } from './static.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stage-dist-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'index.html'), '<html>stage</html>');
  await writeFile(join(dir, 'assets', 'app.js'), 'js');
  await writeFile(join(dir, '..', 'outside.txt'), 'secret');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('readStatic', () => {
  it('serves files with their type and the index for the root and for unknown pages', async () => {
    expect(await readStatic(dir, '/assets/app.js')).toMatchObject({ type: 'text/javascript' });
    expect((await readStatic(dir, '/'))!.body.toString()).toContain('stage');
    expect((await readStatic(dir, '/some/page'))!.type).toBe('text/html');
  });

  it('never leaves the folder', async () => {
    const escaped = await readStatic(dir, '/../outside.txt');
    expect(escaped?.body.toString() ?? '').not.toContain('secret');
    expect(await readStatic(dir, '/%2e%2e/outside.txt').then((file) => file?.body.toString() ?? '')).not.toContain('secret');
  });

  it('answers nothing when the client has not been built', async () => {
    expect(await readStatic(join(dir, 'missing'), '/')).toBeNull();
  });
});

describe('rangeOf', () => {
  it('reads the piece a player asked for, in every form it asks', () => {
    expect(rangeOf('bytes=0-99', 1000)).toEqual({ from: 0, to: 99 });
    expect(rangeOf(' bytes=500- ', 1000)).toEqual({ from: 500, to: 999 });
    expect(rangeOf('bytes=-200', 1000)).toEqual({ from: 800, to: 999 });
    // Past the end of the file is not an error: the last byte is as far as it goes.
    expect(rangeOf('bytes=900-5000', 1000)).toEqual({ from: 900, to: 999 });
  });

  it('asks for the whole file when nothing was asked for, and refuses a piece that is not there', () => {
    expect(rangeOf(undefined, 1000)).toBeNull();
    expect(rangeOf('', 1000)).toBeNull();
    expect(rangeOf('bytes=-', 1000)).toBeNull();
    expect(rangeOf('rows=1-2', 1000)).toBeNull();
    expect(rangeOf('bytes=1000-1200', 1000)).toBe('bad');
    expect(rangeOf('bytes=900-800', 1000)).toBe('bad');
  });
});
