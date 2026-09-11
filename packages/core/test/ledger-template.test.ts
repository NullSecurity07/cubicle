import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import { HEARTBEAT_WAKE_AREAS } from '../src/watcher.js';
import { KNOWN_JOB_TYPES } from '../src/schemas.js';

// NOTE: `packages/core/src/money.ts` (Task 1) is built in parallel on a different branch and is not present
// here, so this test checks the vault-template files and the list edits directly rather than through
// `readLedger`/`moneyReport`/`LEDGER_PATH`/`RUNWAY_PATH`/`DEFAULT_CURRENCY`. Task 1's own suite covers parsing.
const LEDGER_PATH = 'Ledger/ledger.md';
const RUNWAY_PATH = 'Ledger/runway.md';

let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-ledger-tpl-'));
  vault = (await scaffoldVault(dir)).vault;
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('a new vault comes with a book (spec §1)', () => {
  it('ships an empty, parseable-looking ledger and a runway placeholder', () => {
    expect(vault.exists(LEDGER_PATH)).toBe(true);
    expect(vault.exists(RUNWAY_PATH)).toBe(true);
    const ledger = vault.readText(LEDGER_PATH);
    expect(ledger).toContain('currency: USD');
    expect(ledger).toContain('| at | kind | amount | mode | who | why | ref |');
    expect(ledger).not.toMatch(/\|\s*\d{4}-\d{2}-\d{2}T/); // no rows yet
    expect(vault.readText(RUNWAY_PATH)).toContain('after the first heartbeat');
  });

  it('the owner editing the book wakes a heartbeat, because a capital row is how a company is revived', () => {
    expect(HEARTBEAT_WAKE_AREAS).toContain('Ledger');
  });

  it('the daily runway job is a known type', () => {
    expect(KNOWN_JOB_TYPES).toContain('finance.runway');
  });
});
