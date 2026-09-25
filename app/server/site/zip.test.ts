import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { zip } from './zip.ts';

// Reads a zip back through its central directory, the way an unzipper finds its files.
function entries(bytes: Buffer): { name: string; body: Buffer }[] {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const out: { name: string; body: Buffer }[] = [];
  for (let index = 0; index < count; index += 1) {
    const method = bytes.readUInt16LE(at + 10);
    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const offset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = offset + 30 + bytes.readUInt16LE(offset + 26);
    const raw = bytes.subarray(start, start + size);
    out.push({ name, body: method === 8 ? inflateRawSync(raw) : raw });
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return out;
}

describe('the zip writer', () => {
  it('writes files that come back byte for byte, text deflated and pictures stored', async () => {
    const html = Buffer.from('<!doctype html>'.repeat(200));
    const picture = Buffer.from(Array.from({ length: 300 }, (_, index) => index % 256));
    const packed = zip([{ name: 'site/index.html', bytes: html, at: Date.UTC(2026, 8, 25) }, { name: 'site/media/hero.webp', bytes: picture }]);
    expect(packed.length).toBeLessThan(html.length);
    expect(entries(packed)).toEqual([{ name: 'site/index.html', body: html }, { name: 'site/media/hero.webp', body: picture }]);
    // The system's own unzipper agrees, where there is one.
    if (existsSync('/usr/bin/unzip')) {
      const at = await mkdtemp(join(tmpdir(), 'zip-'));
      await writeFile(join(at, 'site.zip'), packed);
      expect(execFileSync('/usr/bin/unzip', ['-t', join(at, 'site.zip')], { encoding: 'utf8' })).toMatch(/No errors detected/);
      execFileSync('/usr/bin/unzip', ['-q', join(at, 'site.zip'), '-d', at]);
      expect(await readFile(join(at, 'site/index.html'))).toEqual(html);
    }
  });

  it('refuses a name that climbs out of its folder', () => {
    expect(() => zip([{ name: '../evil', bytes: Buffer.from('x') }])).toThrow(/bad name/);
  });
});
