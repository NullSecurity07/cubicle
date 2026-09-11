import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { headOf } from '../src/index.js';

/**
 * `headOf` reads `.git/HEAD` (and, when it's a symbolic ref, the loose ref or `packed-refs`) directly rather
 * than spawning `git rev-parse`, because the sandbox that writes a stream's Workspace/ fully controls that
 * directory. The old spawn had a 5 s timeout; a bare `readFileSync` does not, so a FIFO or a symlink to a
 * device at exactly that path must be refused before anything is opened for reading, not merely read slowly.
 */
describe('headOf', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-headof-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function gitDir(): string {
    const g = path.join(dir, '.git');
    mkdirSync(g, { recursive: true });
    return g;
  }

  it('reads the sha of a normal repo off a symbolic HEAD + loose ref', () => {
    const g = gitDir();
    const sha = 'a'.repeat(40);
    writeFileSync(path.join(g, 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(path.join(g, 'refs', 'heads'), { recursive: true });
    writeFileSync(path.join(g, 'refs', 'heads', 'main'), `${sha}\n`);
    expect(headOf(dir)).toBe(sha);
  });

  it('reads a detached HEAD sha directly', () => {
    const g = gitDir();
    const sha = 'b'.repeat(40);
    writeFileSync(path.join(g, 'HEAD'), `${sha}\n`);
    expect(headOf(dir)).toBe(sha);
  });

  it('falls back to packed-refs when there is no loose ref', () => {
    const g = gitDir();
    const sha = 'c'.repeat(40);
    writeFileSync(path.join(g, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(path.join(g, 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${sha} refs/heads/main\n`);
    expect(headOf(dir)).toBe(sha);
  });

  it('returns null for an oversized HEAD instead of reading it', () => {
    const g = gitDir();
    writeFileSync(path.join(g, 'HEAD'), 'ref: refs/heads/main\n' + 'x'.repeat(20_000));
    expect(headOf(dir)).toBeNull();
  });

  it('returns null quickly for a HEAD that is a FIFO instead of blocking on it', () => {
    const g = gitDir();
    const headPath = path.join(g, 'HEAD');
    try { execFileSync('mkfifo', [headPath], { stdio: 'ignore' }); } catch { return; } // no mkfifo on this host: skip cleanly
    const t0 = Date.now();
    expect(headOf(dir)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('returns null quickly for a HEAD that is a symlink instead of following it', () => {
    const g = gitDir();
    const headPath = path.join(g, 'HEAD');
    try { symlinkSync('/dev/zero', headPath); } catch { return; } // e.g. no /dev/zero on this host: skip cleanly
    const t0 = Date.now();
    expect(headOf(dir)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('returns null when there is no .git directory at all', () => {
    expect(headOf(dir)).toBeNull();
  });
});
