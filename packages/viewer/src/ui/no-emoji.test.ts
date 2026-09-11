import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Emoji & symbols (U+1F300–1FAFF) and misc symbols / dingbats (U+2600–27BF): none of them in the viewer. */
const FORBIDDEN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const viewer = path.resolve(__dirname, '../..');
function walk(dir: string): string[] { return readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? walk(p) : p; }); }

describe('no emoji, no icon glyphs', () => {
  it('src/** and index.html contain no emoji or dingbat code points', () => {
    const files = [...walk(path.join(viewer, 'src')), path.join(viewer, 'index.html')];
    const hits = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => ({ f, i, l })).filter(({ l }) => FORBIDDEN.test(l)).map(({ f, i, l }) => `${path.relative(viewer, f)}:${i + 1}: ${l.trim().slice(0, 80)}`));
    expect(hits).toEqual([]);
  });
});
