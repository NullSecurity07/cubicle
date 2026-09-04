import { describe, it, expect } from 'vitest';
import { unifiedDiff } from '../src/diff.js';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('unifiedDiff', () => {
  it('is empty for identical text', () => {
    expect(unifiedDiff('a\nb\nc\n', 'a\nb\nc\n')).toBe('');
    expect(unifiedDiff('', '')).toBe('');
  });

  it('renders one hunk with the changed line and standard headers', () => {
    const out = unifiedDiff('a\nold\nc\n', 'a\nnew\nc\n');

    expect(out.split('\n')).toEqual([
      '--- current',
      '+++ proposed',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-old',
      '+new',
      ' c',
      '',
    ]);
  });

  it('names both sides when asked', () => {
    const out = unifiedDiff('a\n', 'b\n', 'Roles/ceo.md', 'Roles/ceo.md (proposed)');
    expect(out).toContain('--- Roles/ceo.md\n');
    expect(out).toContain('+++ Roles/ceo.md (proposed)\n');
  });

  it('keeps three lines of context and splits distant changes into separate hunks', () => {
    const a = lines(30);
    const b = a.split('\n').map((l, i) => (i === 4 ? 'changed early' : i === 24 ? 'changed late' : l)).join('\n');

    const out = unifiedDiff(a, b);
    const hunks = out.split('\n').filter((l) => l.startsWith('@@'));

    expect(hunks).toEqual(['@@ -2,7 +2,7 @@', '@@ -22,7 +22,7 @@']);
    expect(out).toContain('-line 5\n+changed early\n');
    expect(out).toContain('-line 25\n+changed late\n');
    expect(out).not.toContain('line 15');
  });

  it('handles pure insertion and pure deletion', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\nc\n')).toBe('--- current\n+++ proposed\n@@ -1,2 +1,3 @@\n a\n b\n+c\n');
    expect(unifiedDiff('a\nb\nc\n', 'a\nb\n')).toBe('--- current\n+++ proposed\n@@ -1,3 +1,2 @@\n a\n b\n-c\n');
  });

  it('diffs a 10k-line file quickly by trimming the common head and tail', () => {
    const a = lines(10_000);
    const b = a.split('\n').map((l, i) => (i === 5000 ? 'changed middle' : l)).join('\n');

    const started = Date.now();
    const out = unifiedDiff(a, b);
    const elapsed = Date.now() - started;

    expect(out.split('\n').filter((l) => l.startsWith('@@'))).toEqual(['@@ -4998,7 +4998,7 @@']);
    expect(out).toContain('-line 5001\n+changed middle\n');
    expect(elapsed).toBeLessThan(200); // the untrimmed 10k x 10k table takes ~100x longer and 400 MB
  });

  it('refuses a pair of inputs too large for the LCS table', () => {
    const a = Array.from({ length: 5000 }, (_, i) => `a ${i}`).join('\n');
    const b = Array.from({ length: 5000 }, (_, i) => `b ${i}`).join('\n');

    expect(unifiedDiff(a, b)).toBe('(diff too large: 5000 vs 5000 lines)\n');
  });

  it('diffs against empty text', () => {
    expect(unifiedDiff('', 'a\n')).toBe('--- current\n+++ proposed\n@@ -0,0 +1,1 @@\n+a\n');
  });
});
