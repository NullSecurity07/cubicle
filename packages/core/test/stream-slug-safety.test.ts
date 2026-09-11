import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { createStream, readStream, streamSlug, isValidStreamSlug } from '../src/streams.js';
import { ciStatus } from '../src/ci.js';

let dir: string; let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-slug-')); vault = (await scaffoldVault(dir)).vault;
  createStream(vault, { name: 'Checkout', problem: 'p', customers: 'c', outcome_metric: 'm', owner_team: 'dev', error_budget: 4 }, 'product_manager');
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

/** Every one of these reached `vault.abs` before, where `..` throws UnsafePathError out of whatever called it. */
const HOSTILE = ['../../etc', '..', 'a/../../b', 'Checkout', 'check out', 'check,out', '-checkout', '', 'a'.repeat(49), 'x/y'];

describe('a model-supplied stream slug never throws (fix wave item 4 / C2, M7)', () => {
  it('readStream reads a bad slug as "no such stream"', () => {
    expect(readStream(vault, 'checkout')).not.toBeNull();
    for (const bad of HOSTILE) expect(() => readStream(vault, bad), bad).not.toThrow();
    for (const bad of HOSTILE) expect(readStream(vault, bad), bad).toBeNull();
  });

  it('ciStatus refuses a bad slug instead of throwing a path error at the agent', () => {
    for (const bad of HOSTILE) {
      let st!: ReturnType<typeof ciStatus>;
      expect(() => { st = ciStatus(vault, bad); }, bad).not.toThrow();
      expect(st.ok, bad).toBe(false);
      expect(st.record, bad).toBeNull();
      expect(st.reason, bad).toMatch(/is not a stream slug/);
    }
  });

  it('a well-formed slug with no stream still gets the ordinary "run ci.run" refusal', () => {
    const st = ciStatus(vault, 'checkout');
    expect(st.ok).toBe(false);
    expect(st.reason).toMatch(/no CI record/);
  });

  it('streamSlug never produces a slug that ends in a hyphen, even at the length cap', () => {
    // 'growth-and-retention-for-…' cut at 48 used to land on a hyphen (M7).
    const long = 'Growth and retention for the checkout funnel x' + ' y';
    expect(streamSlug(long).endsWith('-')).toBe(false);
    expect(streamSlug(long).length).toBeLessThanOrEqual(48);
    for (const name of ['Checkout v2!', 'Growth  &  Retention', 'a'.repeat(80), 'a'.repeat(47) + ' b', '!!!', '  ']) {
      const slug = streamSlug(name);
      expect(isValidStreamSlug(slug), `${name} -> ${slug}`).toBe(true);
      expect(slug.endsWith('-'), `${name} -> ${slug}`).toBe(false);
    }
  });

  it('every slug streamSlug produces round-trips through readStream', () => {
    const name = 'Growth and retention for the checkout funnel and more';
    const slug = createStream(vault, { name, problem: 'p', customers: 'c', outcome_metric: 'm', owner_team: 'dev', error_budget: 4 }, 'product_manager');
    expect(isValidStreamSlug(slug)).toBe(true);
    expect(readStream(vault, slug)).not.toBeNull();
  });
});
