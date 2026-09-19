import { createHash } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensurePackages, packagesFor, readLock, type Lock } from './packages.ts';

describe('packagesFor', () => {
  const lock = readLock();
  it('maps imports to Pyodide packages with everything they depend on, and ignores the rest', () => {
    expect(packagesFor('import pandas as pd\nfrom matplotlib import pyplot as plt', lock)).toEqual(expect.arrayContaining(['pandas', 'numpy', 'matplotlib', 'python-dateutil', 'pillow']));
    expect(packagesFor('import csv, json\nfrom statistics import mean\nimport requests_that_do_not_exist', lock)).toEqual([]);
    expect(packagesFor('    import numpy, os  # indented, with a comment\nx = "import pandas"', lock)).toEqual(['numpy']);
    expect(packagesFor('from bs4 import BeautifulSoup', lock)).toEqual(expect.arrayContaining(['beautifulsoup4', 'soupsieve']));
  });
});

describe('ensurePackages', () => {
  const wheel = Buffer.from('a wheel');
  const lock: Lock = { packages: { tiny: { name: 'tiny', file_name: 'tiny-1.0.whl', sha256: createHash('sha256').update(wheel).digest('hex'), depends: [], imports: ['tiny'] } } };
  const serve = (body: Buffer | null) => (async () => (body ? new Response(new Uint8Array(body)) : new Response('', { status: 503 }))) as unknown as typeof fetch;

  it('keeps a wheel that matches its published hash, and does not fetch it twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wheels-'));
    let asked = 0;
    const http = (async (url: string) => { asked += 1; expect(url).toBe('https://cdn.jsdelivr.net/pyodide/v9.9.9/full/tiny-1.0.whl'); return new Response(new Uint8Array(wheel)); }) as unknown as typeof fetch;
    await ensurePackages(['tiny'], dir, lock, '9.9.9', http);
    await ensurePackages(['tiny'], dir, lock, '9.9.9', http);
    expect(asked).toBe(1);
    expect(await readdir(dir)).toEqual(['tiny-1.0.whl']);
  });

  it('throws away a wheel that does not match, and says plainly when the network is down', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wheels-'));
    await expect(ensurePackages(['tiny'], dir, lock, '9.9.9', serve(Buffer.from('tampered')))).rejects.toThrow(/did not match its published checksum/);
    await expect(ensurePackages(['tiny'], dir, lock, '9.9.9', serve(null))).rejects.toThrow(/one-time download/);
    expect(await readdir(dir)).toEqual([]);
  });
});
