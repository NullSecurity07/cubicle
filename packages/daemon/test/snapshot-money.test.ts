import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, appendEntry, HOUSE, LEDGER_PATH, type Vault } from '@cubicle/core';
import { Router, QuotaTracker, parseProvidersConfig } from '@cubicle/router';
import { buildSnapshot } from '../src/ws.js';

/**
 * The wire, not the literal. `bank.test.ts` in the viewer asserts what the screen does with a `money` block; this
 * asserts that the daemon actually sends one — the half that was missing, and the reason nothing failed while the
 * whole owner-facing side of SP4 was dead (C1).
 */
const SHIPPED = parseProvidersConfig(readFileSync(path.resolve(__dirname, '../../../config/providers.yaml'), 'utf8'));

/**
 * The block's field names, pinned. `packages/viewer/src/ui/bank.test.ts` pins the same list against the literal
 * the screen is tested with, so the wire and the screen cannot drift apart without one of the two going red.
 */
const MONEY_KEYS = [
  'currency', 'cash_cents', 'cash', 'burn_cents_per_day', 'burn', 'runway_days', 'runway',
  'dormant', 'mock_revenue_cents', 'mock_revenue', 'problems', 'budgets', 'entries',
].sort();

let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-snapmoney-'));
  vault = (await scaffoldVault(dir)).vault;
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const router = (): Router => new Router(SHIPPED, new QuotaTracker(vault.db), { env: {} });

describe('buildSnapshot money (spec §6, decision 16)', () => {
  it('carries cents and the string for every figure of a funded company, with the division quotas', () => {
    appendEntry(vault, { at: '2026-09-10T08:00:00.000Z', kind: 'capital', cents: 25_000, mode: 'live', who: 'owner', why: 'Seed from savings', ref: '' }, 'owner');
    appendEntry(vault, { at: '2026-09-11T08:00:00.000Z', kind: 'cost', cents: 1_000, mode: 'live', who: 'daemon', why: 'A day of priced model calls', ref: 'model-2026-09-11' }, 'daemon');
    const m = buildSnapshot(vault, router()).money;
    expect(m).not.toBeNull();
    expect(Object.keys(m!).sort()).toEqual(MONEY_KEYS);
    expect(m!.currency).toBe('USD');
    expect(m!.cash_cents).toBe(24_000);
    expect(m!.cash).toBe('USD 240.00');
    // Formatted by the daemon, never by the viewer: the string is the one core's own `money()` produces.
    expect(m!.burn).toBe(`USD ${(m!.burn_cents_per_day / 100).toFixed(2)}`);
    expect(m!.runway).toMatch(/^\d+ days?$/);
    expect(m!.runway_days).toBe(Math.floor(m!.cash_cents / m!.burn_cents_per_day));
    expect(m!.dormant).toBe(false);
    expect(m!.problems).toBe(0);
    // The shipped providers file has real free-tier capacity, so every division and the house get a row.
    expect(m!.budgets.length).toBeGreaterThan(0);
    expect(m!.budgets.map((b) => b.division)).toContain(HOUSE);
    expect(m!.budgets.at(-1)!.division).toBe(HOUSE);
    // Newest first, and the amount is a string beside no cents at all — the row is for reading.
    expect(m!.entries[0]).toMatchObject({ kind: 'cost', amount: 'USD 10.00', mode: 'live', who: 'daemon' });
    expect(m!.entries[1]).toMatchObject({ kind: 'capital', amount: 'USD 250.00', who: 'owner', why: 'Seed from savings' });
  });

  it('an unfunded company sends zeroes and "not spending", never null and never a number for runway', () => {
    const m = buildSnapshot(vault, router()).money;
    expect(m).not.toBeNull();
    expect(m!.cash_cents).toBe(0);
    expect(m!.cash).toBe('USD 0.00');
    expect(m!.burn_cents_per_day).toBe(0);
    expect(m!.runway_days).toBeNull();
    expect(m!.runway).toBe('not spending');
    expect(m!.dormant).toBe(false);
    expect(m!.entries).toEqual([]);
  });

  it('a spent-out company is marked dormant on the wire', () => {
    appendEntry(vault, { at: '2026-09-10T08:00:00.000Z', kind: 'capital', cents: 5_000, mode: 'live', who: 'owner', why: 'Seed from savings', ref: '' }, 'owner');
    appendEntry(vault, { at: '2026-09-11T08:00:00.000Z', kind: 'cost', cents: 5_000, mode: 'live', who: 'cfo', why: 'The whole of it on a service', ref: 'j1' }, 'cfo');
    const m = buildSnapshot(vault, router()).money;
    expect(m!.dormant).toBe(true);
    expect(m!.cash_cents).toBe(0);
  });

  it('mock revenue rides beside cash and never inside it, and a row nobody can read is counted', () => {
    appendEntry(vault, { at: '2026-09-10T08:00:00.000Z', kind: 'revenue', cents: 4_000, mode: 'mock', who: 'cso', why: 'Simulated nursery order', ref: '' }, 'cso');
    vault.writeText(LEDGER_PATH, vault.readText(LEDGER_PATH).replace(/\n$/, '') + '\n| 2026-09-11T08:00:00.000Z | revenue | forty quid | live | cso | Typed by hand | |\n', 'owner');
    const m = buildSnapshot(vault, router()).money;
    expect(m!.cash_cents).toBe(0);
    expect(m!.mock_revenue_cents).toBe(4_000);
    expect(m!.mock_revenue).toBe('USD 40.00');
    expect(m!.problems).toBe(1);
  });

  it('caps a long `why` at the daemon, so the viewer never has to (M13)', () => {
    appendEntry(vault, { at: '2026-09-10T08:00:00.000Z', kind: 'cost', cents: 100, mode: 'live', who: 'cfo', why: 'A'.repeat(400), ref: '' }, 'cfo');
    const why = buildSnapshot(vault, router()).money!.entries[0].why;
    expect(why.length).toBeLessThanOrEqual(80);
    expect(why.endsWith('…')).toBe(true);
  });

  it('a book that cannot be read costs the money block and nothing else', () => {
    // `readLedger` cannot throw on bad rows (it reports them), so the failure is forced where a real one lives:
    // the ledger path itself reads as a directory, which is the shape an owner's misplaced folder takes.
    rmSync(vault.abs(LEDGER_PATH), { force: true });
    vault.writeText(`${LEDGER_PATH}/not-a-file.md`, 'oops\n', 'owner');
    const snap = buildSnapshot(vault, router());
    expect(snap.money).toBeNull();
    expect(snap.op).toBe('snapshot');
    expect(snap.teams.length).toBeGreaterThan(0);
  });

  it('without a router there are no division quotas, and the figures still arrive', () => {
    appendEntry(vault, { at: '2026-09-10T08:00:00.000Z', kind: 'capital', cents: 1_000, mode: 'live', who: 'owner', why: 'Seed from savings', ref: '' }, 'owner');
    const m = buildSnapshot(vault).money;
    expect(m!.cash_cents).toBe(1_000);
    expect(m!.budgets).toEqual([]);
  });
});
