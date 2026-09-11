import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createStream, readFlags, expiredFlags, flagsPath } from '@cubicle/core';
import { maybeFlagLessons } from '../src/evolution.js';

let dir: string; let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-flags-')); vault = (await scaffoldVault(dir)).vault;
  createStream(vault, { name: 'Checkout', problem: 'p', customers: 'c', outcome_metric: 'm', owner_team: 'dev' }, 'product_manager');
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const flags = (...f: Record<string, unknown>[]) => JSON.stringify({ flags: f }, null, 2);
const NOW = new Date('2026-10-15T09:00:00.000Z');

describe('flags.json', () => {
  it('reads the convention from Workspace/<stream>/flags.json', () => {
    expect(flagsPath('checkout')).toBe('Workspace/checkout/flags.json');
    vault.writeText(flagsPath('checkout'), flags({ key: 'new_checkout', owner: 'backend_engineer', state: 'off', created: '2026-09-11', remove_by: '2026-10-09' }), 'backend_engineer');
    const f = readFlags(vault, 'checkout');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ key: 'new_checkout', owner: 'backend_engineer', state: 'off', remove_by: '2026-10-09' });
  });

  it('a missing or malformed file is empty, never a crash', () => {
    expect(readFlags(vault, 'checkout')).toEqual([]);
    vault.writeText(flagsPath('checkout'), '{ not json', 'backend_engineer');
    expect(readFlags(vault, 'checkout')).toEqual([]);
    vault.writeText(flagsPath('checkout'), flags({ key: 'x' }), 'backend_engineer');
    expect(readFlags(vault, 'checkout')).toEqual([]);   // no owner, no remove_by: not a flag anyone owns
  });

  it('expiredFlags is exactly those past their removal date', () => {
    const list = [
      { key: 'a', owner: 'sre', state: 'on' as const, created: '2026-09-01', remove_by: '2026-10-01' },
      { key: 'b', owner: 'sre', state: 'on' as const, created: '2026-09-01', remove_by: '2026-12-01' },
    ];
    expect(expiredFlags(list, '2026-10-15').map((f) => f.key)).toEqual(['a']);
    expect(expiredFlags(list, '2026-09-30')).toEqual([]);
  });
});

describe('an expired flag becomes a lesson (operating model §21)', () => {
  it('writes one lesson line naming the flag, its owner and its date, and warns once', () => {
    vault.writeText(flagsPath('checkout'), flags(
      { key: 'new_checkout', owner: 'backend_engineer', state: 'on', created: '2026-09-11', remove_by: '2026-10-09' },
      { key: 'later', owner: 'sre', state: 'off', created: '2026-09-11', remove_by: '2026-12-01' },
    ), 'backend_engineer');

    const made = maybeFlagLessons(vault, NOW);
    expect(made).toEqual(['new_checkout']);
    const lessons = vault.readText('Memory/lessons.md');
    expect(lessons).toMatch(/new_checkout/);
    expect(lessons).toMatch(/backend_engineer/);
    expect(lessons).toMatch(/2026-10-09/);
    expect(lessons).not.toMatch(/later/);
    const w = vault.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === 'flags');
    expect(w).toHaveLength(1);
    expect(w[0].payload).toMatchObject({ stream: 'checkout' });
  });

  it('says the same thing once, not every tick', () => {
    vault.writeText(flagsPath('checkout'), flags({ key: 'new_checkout', owner: 'backend_engineer', state: 'on', created: '2026-09-11', remove_by: '2026-10-09' }), 'backend_engineer');
    expect(maybeFlagLessons(vault, NOW)).toEqual(['new_checkout']);
    expect(maybeFlagLessons(vault, NOW)).toEqual([]);
    expect(vault.readText('Memory/lessons.md').match(/new_checkout/g)).toHaveLength(1);
  });

  it('a stream with no flags file is silent', () => {
    expect(maybeFlagLessons(vault, NOW)).toEqual([]);
    expect(vault.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === 'flags')).toEqual([]);
  });
});
