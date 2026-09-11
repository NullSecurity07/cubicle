import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { readCiConfig, writeCiRecord, latestCiRecord, ciStatus, ciConfigPath, ciRecordDir, newestSourceMtime, type CiRecord } from '../src/ci.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-ci-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const YAML_OK = `network: none
timeout_s: 120
steps:
  - { name: build, run: "npm run build" }
  - { name: test,  run: "npm test" }
  - { name: security-scan, run: "npm audit", allow_failure: true }
`;

/**
 * Seeded files are back-dated so the fixed timestamps in `record()` are in their future. Without this the suite
 * would be a time bomb: real wall-clock mtimes overtake a hard-coded `finished` and every freshness case flips.
 */
const SEEDED = new Date('2026-09-01T00:00:00.000Z');

function seed(slug = 'checkout'): void {
  vault.writeText(ciConfigPath(slug), YAML_OK, 'daemon');
  vault.writeText(`Workspace/${slug}/src/index.js`, 'export const x = 1;\n', 'backend_engineer');
  utimesSync(path.join(dir, ciConfigPath(slug)), SEEDED, SEEDED);
  utimesSync(path.join(dir, `Workspace/${slug}/src/index.js`), SEEDED, SEEDED);
}

function record(over: Partial<CiRecord> = {}): CiRecord {
  return { stream: 'checkout', started: '2026-09-11T10:00:00.000Z', finished: '2026-09-11T10:01:00.000Z', green: true, commit: null, steps: [{ name: 'build', code: 0, ok: true, duration_ms: 10, output: 'ok' }], ...over };
}

describe('cubicle-ci.yaml', () => {
  it('paths follow the stream slug', () => {
    expect(ciConfigPath('checkout')).toBe('Workspace/checkout/cubicle-ci.yaml');
    expect(ciRecordDir('checkout')).toBe('Workspace/checkout/.cubicle-ci');
  });

  it('parses steps, defaults network to none and allow_failure to false', () => {
    seed();
    const r = readCiConfig(vault, 'checkout');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.network).toBe('none');
    expect(r.config.timeout_s).toBe(120);
    expect(r.config.steps.map((s) => s.name)).toEqual(['build', 'test', 'security-scan']);
    expect(r.config.steps[0].allow_failure).toBe(false);
    expect(r.config.steps[2].allow_failure).toBe(true);
  });

  it('says what is wrong instead of throwing when the file is missing or malformed', () => {
    const missing = readCiConfig(vault, 'nope');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('Workspace/nope/cubicle-ci.yaml');
    vault.writeText(ciConfigPath('bad'), 'steps: "not a list"\n', 'daemon');
    const bad = readCiConfig(vault, 'bad');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/steps/);
  });
});

describe('CI records and freshness', () => {
  it('writes a record, reads the newest one back', () => {
    seed();
    writeCiRecord(vault, 'checkout', record({ finished: '2026-09-11T10:01:00.000Z' }), 'backend_engineer');
    writeCiRecord(vault, 'checkout', record({ finished: '2026-09-11T12:00:00.000Z', green: false }), 'backend_engineer');
    const latest = latestCiRecord(vault, 'checkout');
    expect(latest?.record.finished).toBe('2026-09-11T12:00:00.000Z');
    expect(latest?.record.green).toBe(false);
  });

  it('a green record older than a source file is stale', () => {
    seed();
    const src = path.join(dir, 'Workspace/checkout/src/index.js');
    const long_ago = new Date('2026-09-11T09:00:00.000Z');
    utimesSync(src, long_ago, long_ago);
    writeCiRecord(vault, 'checkout', record(), 'backend_engineer');
    expect(ciStatus(vault, 'checkout').ok).toBe(true);

    const later = new Date('2026-09-11T11:00:00.000Z');
    utimesSync(src, later, later);
    const stale = ciStatus(vault, 'checkout');
    expect(stale.ok).toBe(false);
    expect(stale.reason).toMatch(/src\/index\.js/);
    expect(stale.reason).toMatch(/ci\.run/);
  });

  it('a red record is never ok, however fresh', () => {
    seed();
    const src = path.join(dir, 'Workspace/checkout/src/index.js');
    const long_ago = new Date('2026-09-11T09:00:00.000Z');
    utimesSync(src, long_ago, long_ago);
    writeCiRecord(vault, 'checkout', record({ green: false, steps: [{ name: 'test', code: 1, ok: false, duration_ms: 5, output: '2 failing' }] }), 'backend_engineer');
    const s = ciStatus(vault, 'checkout');
    expect(s.ok).toBe(false);
    expect(s.reason).toMatch(/test/);
  });

  it('no record at all says so, and names the tool that makes one', () => {
    seed();
    const s = ciStatus(vault, 'checkout');
    expect(s.ok).toBe(false);
    expect(s.record).toBeNull();
    expect(s.reason).toMatch(/ci\.run/);
  });

  it('build output and the record directory never count as source changes', () => {
    seed();
    mkdirSync(path.join(dir, 'Workspace/checkout/node_modules/pkg'), { recursive: true });
    writeFileSync(path.join(dir, 'Workspace/checkout/node_modules/pkg/index.js'), 'x');
    mkdirSync(path.join(dir, 'Workspace/checkout/dist'), { recursive: true });
    writeFileSync(path.join(dir, 'Workspace/checkout/dist/bundle.js'), 'x');
    const before = newestSourceMtime(vault, 'checkout');
    const future = new Date(Date.now() + 60_000);
    utimesSync(path.join(dir, 'Workspace/checkout/node_modules/pkg/index.js'), future, future);
    utimesSync(path.join(dir, 'Workspace/checkout/dist/bundle.js'), future, future);
    expect(newestSourceMtime(vault, 'checkout')).toBe(before);

    // …and a record written now does not make the very run that wrote it look stale.
    writeCiRecord(vault, 'checkout', record(), 'backend_engineer');
    expect(newestSourceMtime(vault, 'checkout')).toBe(before);
  });
});
