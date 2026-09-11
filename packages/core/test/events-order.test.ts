import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';

let dir: string; let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-events-order-')); vault = (await scaffoldVault(dir)).vault;
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const emit = (n: number) => vault.events.emit({ type: 'deploy.done', agent: 'sre', payload: { n } });

describe('EventLog.query order (fix wave item 1 / I2)', () => {
  it('a bounded desc query returns the newest rows, newest first', () => {
    emit(1); emit(2); emit(3);
    const newest = vault.events.query({ types: ['deploy.done'], limit: 2, order: 'desc' });
    expect(newest.map((e) => e.payload.n)).toEqual([3, 2]);
  });

  it('asc stays the default order, and a limit always keeps the newest rows (integration rule: a bounded query never freezes on the first N events)', () => {
    emit(1); emit(2); emit(3);
    expect(vault.events.query({ types: ['deploy.done'], limit: 2 }).map((e) => e.payload.n)).toEqual([2, 3]);
    expect(vault.events.query({ types: ['deploy.done'], limit: 2, order: 'asc' }).map((e) => e.payload.n)).toEqual([2, 3]);
    expect(vault.events.query({ types: ['deploy.done'] }).map((e) => e.payload.n)).toEqual([1, 2, 3]);
  });

  it('an unbounded desc query returns the whole log newest first', () => {
    emit(1); emit(2); emit(3);
    expect(vault.events.query({ types: ['deploy.done'], order: 'desc' }).map((e) => e.payload.n)).toEqual([3, 2, 1]);
  });

  it('desc composes with the other filters', () => {
    for (let i = 1; i <= 5; i++) vault.events.emit({ type: 'deploy.done', agent: 'sre', job: i % 2 ? 'job_a' : 'job_b', payload: { n: i } });
    const a = vault.events.query({ types: ['deploy.done'], job: 'job_a', limit: 2, order: 'desc' });
    expect(a.map((e) => e.payload.n)).toEqual([5, 3]);
  });

  it('the newest window is what a sweep past the limit still sees', () => {
    for (let i = 0; i < 600; i++) emit(i);
    const window = vault.events.query({ types: ['deploy.done'], limit: 500, order: 'desc' });
    expect(window.length).toBe(500);
    expect(window[0].payload.n).toBe(599);
    expect(window.at(-1)!.payload.n).toBe(100);
    // The ascending window of the same size cannot see the recent end at all — the I2 bug.
    expect(vault.events.query({ types: ['deploy.done'], limit: 500 }).at(-1)!.payload.n).toBe(599);   // asc order, but still the newest 500
    expect(vault.events.query({ types: ['deploy.done'], limit: 500 })[0].payload.n).toBe(100);
  });
});
