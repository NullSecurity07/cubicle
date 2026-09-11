import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import {
  LEDGER_PATH, DEFAULT_CURRENCY, LEDGER_COLUMNS,
  parseMoney, formatMoney, money, parseLedger, ledgerRow, ledgerTemplate, readLedger, appendEntry, LedgerEntry,
} from '../src/money.js';

describe('money is integer cents, parsed from strings (spec §1)', () => {
  it('reads a decimal without ever touching a float', () => {
    expect(parseMoney('250')).toBe(25000);
    expect(parseMoney('250.5')).toBe(25050);
    expect(parseMoney('250.55')).toBe(25055);
    expect(parseMoney('0.29')).toBe(29);          // Math.round(parseFloat('0.29') * 100) is 28.999… territory
    expect(parseMoney('0')).toBe(0);
    expect(parseMoney(' 1,200.00 ')).toBe(120000);
    expect(parseMoney('USD 40.00')).toBe(4000);
    expect(parseMoney('$40')).toBe(4000);
  });

  it('refuses anything it cannot represent exactly, rather than rounding it', () => {
    expect(parseMoney('250.555')).toBeNull();     // more precision than the book has
    expect(parseMoney('-1')).toBeNull();          // the kind carries the sign, not the amount
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('   ')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('1e3')).toBeNull();
    expect(parseMoney('12.')).toBeNull();
    expect(parseMoney('9999999999999')).toBeNull();   // past what cents can hold safely
  });

  it('formats back to exactly what it read', () => {
    for (const s of ['0', '0.29', '250', '250.50', '1200.00']) expect(formatMoney(parseMoney(s)!)).toBe(Number(s).toFixed(2));
    expect(formatMoney(0)).toBe('0.00');
    expect(formatMoney(7)).toBe('0.07');
    expect(formatMoney(-7)).toBe('-0.07');        // cash can go negative even though an amount cannot
    expect(money(25000)).toBe('USD 250.00');
    expect(money(25000, 'GBP')).toBe('GBP 250.00');
  });
});

describe('the ledger table (spec §1)', () => {
  const table = (...rows: string[]) => [
    '---', 'currency: GBP', '---', '# Ledger', '',
    `| ${LEDGER_COLUMNS.join(' | ')} |`,
    `|${LEDGER_COLUMNS.map(() => '---').join('|')}|`,
    ...rows, '',
  ].join('\n');

  it('reads the currency, the rows and nothing else', () => {
    const l = parseLedger(table(
      '| 2026-09-12T08:00:00.000Z | capital | 250.00 | live | owner | Seed from savings |  |',
      '| 2026-09-12T18:04:11.000Z | revenue | 40.00 | mock | cso | Simulated nursery order | job_abc |',
    ));
    expect(l.currency).toBe('GBP');
    expect(l.problems).toEqual([]);
    expect(l.entries.map((e) => [e.kind, e.cents, e.mode, e.who, e.ref])).toEqual([
      ['capital', 25000, 'live', 'owner', ''],
      ['revenue', 4000, 'mock', 'cso', 'job_abc'],
    ]);
  });

  it('keeps a row it cannot read and says which line it is on, rather than losing the money', () => {
    const l = parseLedger(table(
      '| 2026-09-12T08:00:00.000Z | capital | 250.00 | live | owner | Seed | |',
      '| 2026-09-12T09:00:00.000Z | capital | two hundred | live | owner | Typo | |',
      '| not-a-date | cost | 1.00 | live | daemon | Bad date | |',
      '| 2026-09-12T10:00:00.000Z | bribe | 1.00 | live | cfo | Not a kind | |',
    ));
    expect(l.entries).toHaveLength(1);
    // Line numbers are the ones an owner sees in the file: frontmatter (1–3), `# Ledger` (4), blank (5),
    // header (6), separator (7), then one line per row. The good row is 8.
    expect(l.problems.map((p) => p.line)).toEqual([9, 10, 11]);
    expect(l.problems[0].reason).toContain('two hundred');
    expect(l.problems[1].reason).toContain('not a timestamp');
    expect(l.problems[2].reason).toContain('kind');
    expect(l.problems[0].text).toContain('Typo');
  });

  it('defaults the currency and tolerates a book with no frontmatter at all', () => {
    const l = parseLedger('| at | kind | amount | mode | who | why | ref |\n|---|---|---|---|---|---|---|\n| 2026-09-12T08:00:00.000Z | cost | 1.00 | live | daemon | x | |\n');
    expect(l.currency).toBe(DEFAULT_CURRENCY);
    expect(l.entries).toHaveLength(1);
  });

  it('ignores a table that is not the ledger and a `why` containing a pipe', () => {
    expect(parseLedger('| a | b |\n|---|---|\n| 1 | 2 |\n').entries).toEqual([]);
    const e = LedgerEntry.parse({ at: '2026-09-12T08:00:00.000Z', kind: 'cost', cents: 100, mode: 'live', who: 'cfo', why: 'a | b\nc', ref: '' });
    expect(ledgerRow(e)).toBe('| 2026-09-12T08:00:00.000Z | cost | 1.00 | live | cfo | a / b c |  |');
    expect(parseLedger(ledgerTemplate() + ledgerRow(e) + '\n').entries[0].why).toBe('a / b c');
  });
});

describe('appending to the book (spec §1)', () => {
  let dir: string;
  let vault: Vault;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cubicle-money-'));
    vault = (await scaffoldVault(dir)).vault;
  });
  afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

  it('creates the book on the first entry and never rewrites a row after that', () => {
    expect(readLedger(vault).entries).toEqual([]);
    const first = appendEntry(vault, { at: '2026-09-12T08:00:00.000Z', kind: 'capital', cents: 25000, mode: 'live', who: 'owner', why: 'Seed' }, 'owner');
    expect(first.added).toBe(true);
    const afterOne = vault.readText(LEDGER_PATH);
    appendEntry(vault, { at: '2026-09-12T09:00:00.000Z', kind: 'cost', cents: 500, mode: 'live', who: 'daemon', why: 'A paid call' }, 'daemon');
    const afterTwo = vault.readText(LEDGER_PATH);
    expect(afterTwo.startsWith(afterOne.replace(/\n$/, ''))).toBe(true);   // byte-for-byte: only an append happened
    expect(readLedger(vault).entries.map((e) => e.kind)).toEqual(['capital', 'cost']);
  });

  it('refuses a second entry with the same ref, so a replayed cycle cannot double-charge', () => {
    const a = appendEntry(vault, { kind: 'cost', cents: 300, mode: 'live', who: 'daemon', why: 'model calls', ref: 'model-2026-09-12' }, 'daemon');
    const b = appendEntry(vault, { kind: 'cost', cents: 300, mode: 'live', who: 'daemon', why: 'model calls', ref: 'model-2026-09-12' }, 'daemon');
    expect(a.added).toBe(true);
    expect(b.added).toBe(false);
    expect(b.entry.at).toBe(a.entry.at);
    expect(readLedger(vault).entries).toHaveLength(1);
  });

  it('appends twice when there is no ref, because two identical cash sales are two sales', () => {
    appendEntry(vault, { kind: 'revenue', cents: 4000, mode: 'mock', who: 'cso', why: 'Nursery order' }, 'cso');
    appendEntry(vault, { kind: 'revenue', cents: 4000, mode: 'mock', who: 'cso', why: 'Nursery order' }, 'cso');
    expect(readLedger(vault).entries).toHaveLength(2);
  });

  it('stamps `at` itself when the caller does not, and keeps the owner\'s currency', () => {
    vault.writeText(LEDGER_PATH, ledgerTemplate('GBP', '2026-09-01T00:00:00.000Z'), 'owner');
    const r = appendEntry(vault, { kind: 'revenue', cents: 1, mode: 'live', who: 'cso', why: 'x' }, 'cso');
    expect(Date.parse(r.entry.at)).toBeGreaterThan(0);
    expect(readLedger(vault).currency).toBe('GBP');
  });
});
