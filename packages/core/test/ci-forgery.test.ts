import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, rmSync as rmFile } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { writeCiRecord, latestCiRecord, ciStatus, ciRecordAttested, ciConfigPath, ciRecordDir, type CiRecord } from '../src/ci.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-ci-forge-')); vault = (await scaffoldVault(dir)).vault; seed(); });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const SLUG = 'checkout';

function seed(): void {
  vault.writeText(ciConfigPath(SLUG), 'steps:\n  - { name: test, run: "npm test" }\n', 'daemon');
  vault.writeText(`Workspace/${SLUG}/src/index.js`, 'export const x = 1;\n', 'backend_engineer');
}

const record = (over: Partial<CiRecord> = {}): CiRecord => ({
  stream: SLUG, started: '2026-09-11T10:00:00.000Z', finished: '2026-09-11T10:01:00.000Z', green: true, commit: null,
  steps: [{ name: 'test', code: 0, ok: true, duration_ms: 10, output: 'ok' }], ...over,
});

/**
 * What a `cubicle-ci.yaml` step can do: `Workspace/<slug>` is bind-mounted read-write at /work/stream and the
 * container runs as the host uid, so a step writes straight into `.cubicle-ci/` with no vault API in the loop.
 */
function forge(name: string, rec: CiRecord): string {
  const rel = `${ciRecordDir(SLUG)}/${name}`;
  mkdirSync(path.join(dir, ciRecordDir(SLUG)), { recursive: true });
  writeFileSync(path.join(dir, rel), JSON.stringify(rec, null, 2) + '\n');
  return rel;
}

describe('a CI record is only usable when the vault wrote it (fix wave item 3 / C1)', () => {
  it('a green, far-future record written by a pipeline step is ignored', () => {
    const rel = forge('9999-01-01T00-00-00-000Z.json', record({ finished: '9999-01-01T00:00:00.000Z' }));
    expect(ciRecordAttested(vault, rel)).toBe(false);
    expect(latestCiRecord(vault, SLUG)).toBeNull();
    const st = ciStatus(vault, SLUG);
    expect(st.ok).toBe(false);
    expect(st.record).toBeNull();
    expect(st.reason).toMatch(/not written by ci\.run/);
    expect(st.reason).toContain(rel);
  });

  it('a record ci.run wrote is attested and usable', () => {
    const rel = writeCiRecord(vault, SLUG, record(), 'backend_engineer');
    expect(ciRecordAttested(vault, rel)).toBe(true);
    expect(latestCiRecord(vault, SLUG)!.path).toBe(rel);
    expect(ciStatus(vault, SLUG).ok).toBe(true);
  });

  it('editing a genuine record after the fact breaks its attestation', () => {
    const rel = writeCiRecord(vault, SLUG, record({ green: false, steps: [{ name: 'test', code: 1, ok: false, duration_ms: 9, output: 'boom' }] }), 'backend_engineer');
    expect(ciStatus(vault, SLUG).ok).toBe(false);
    // The step rewrites its own red record as green, at the same path and the same name.
    writeFileSync(path.join(dir, rel), JSON.stringify(record(), null, 2) + '\n');
    expect(ciRecordAttested(vault, rel)).toBe(false);
    expect(ciStatus(vault, SLUG).ok).toBe(false);
    expect(ciStatus(vault, SLUG).record).toBeNull();
  });

  it('a forged newest record does not hide the genuine record behind it', () => {
    writeCiRecord(vault, SLUG, record({ finished: '2026-09-11T10:01:00.000Z', green: false, steps: [{ name: 'test', code: 1, ok: false, duration_ms: 9, output: 'boom' }] }), 'backend_engineer');
    forge('9999-01-01T00-00-00-000Z.json', record({ finished: '9999-01-01T00:00:00.000Z' }));
    const st = ciStatus(vault, SLUG);
    expect(st.ok).toBe(false);
    expect(st.reason).toMatch(/was red/);            // the genuine one still decides, not the forgery
    expect(st.record!.green).toBe(false);
  });

  it('the ship gate stays shut even when every record on disk is forged', () => {
    for (const n of ['2026-09-11T11-00-00-000Z.json', '9999-01-01T00-00-00-000Z.json']) forge(n, record({ finished: n.slice(0, 4) === '9999' ? '9999-01-01T00:00:00.000Z' : '2026-09-11T11:00:00.000Z' }));
    expect(ciStatus(vault, SLUG).ok).toBe(false);
    expect(ciStatus(vault, SLUG).reason).toMatch(/2 files/);
  });

  it('attestation survives a cache rebuild, so genuine records keep working', () => {
    const rel = writeCiRecord(vault, SLUG, record(), 'backend_engineer');
    expect(vault.rebuildWrittenSha()).toBeGreaterThan(0);
    expect(ciRecordAttested(vault, rel)).toBe(true);
    expect(ciStatus(vault, SLUG).ok).toBe(true);
  });

  it('a record file that has been deleted is skipped rather than throwing', () => {
    const rel = writeCiRecord(vault, SLUG, record(), 'backend_engineer');
    rmFile(path.join(dir, rel));
    expect(ciRecordAttested(vault, rel)).toBe(false);
    expect(latestCiRecord(vault, SLUG)).toBeNull();
    expect(ciStatus(vault, SLUG).ok).toBe(false);
  });
});
