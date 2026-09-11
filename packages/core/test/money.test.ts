import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    // Hand-written expected strings, never `Number(s).toFixed(2)` — the oracle for a test that exists to
    // prove no float touches the value must not itself go through a float.
    const cases: [string, string][] = [
      ['0', '0.00'], ['0.29', '0.29'], ['250', '250.00'], ['250.50', '250.50'], ['1200.00', '1200.00'],
    ];
    for (const [s, expected] of cases) expect(formatMoney(parseMoney(s)!)).toBe(expected);
    expect(formatMoney(0)).toBe('0.00');
    expect(formatMoney(7)).toBe('0.07');
    expect(formatMoney(-7)).toBe('-0.07');        // cash can go negative even though an amount cannot
    expect(money(25000)).toBe('USD 250.00');
    expect(money(25000, 'GBP')).toBe('GBP 250.00');
  });

  it('strips only the declared currency code, not any three letters (review M1/ruling 4)', () => {
    expect(parseMoney('abc 12.00')).toBeNull();          // not USD (the default), and not money either
    expect(parseMoney('USD 12.00')).toBe(1200);
    expect(parseMoney('GBP 12.00', 'GBP')).toBe(1200);
    expect(parseMoney('USD 12.00', 'GBP')).toBeNull();    // wrong code for the declared currency
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

  it('reports a row with too few cells as a problem instead of dropping it silently (review I3/ruling 3)', () => {
    const l = parseLedger(table('| 2026-09-12T08:00:00.000Z | cost | 5.00 |'));
    expect(l.entries).toEqual([]);
    expect(l.problems).toHaveLength(1);
    expect(l.problems[0].reason).toContain('cells');
    expect(l.problems[0].text).toContain('5.00');
  });

  it('reports an empty `mode` cell as a problem rather than defaulting it to `live` (review M2/ruling 5)', () => {
    const l = parseLedger(table('| 2026-09-12T08:00:00.000Z | cost | 1.00 |  | daemon | no mode | |'));
    expect(l.entries).toEqual([]);
    expect(l.problems).toHaveLength(1);
    expect(l.problems[0].reason).toContain('mode');
  });

  it('does not read a garbled currency-looking prefix as money (review M1/ruling 4)', () => {
    const l = parseLedger(table('| 2026-09-12T08:00:00.000Z | cost | abc 12.00 | live | daemon | garbled | |'));
    expect(l.entries).toEqual([]);
    expect(l.problems).toHaveLength(1);
    expect(l.problems[0].reason).toContain('abc 12.00');
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

  it('stamps `at` itself when the caller does not, and keeps the owner\'s currency (ruling 8: row and frontmatter both survive)', () => {
    vault.writeText(LEDGER_PATH, ledgerTemplate('GBP', '2026-09-01T00:00:00.000Z'), 'owner');
    const r = appendEntry(vault, { kind: 'revenue', cents: 1, mode: 'live', who: 'cso', why: 'x' }, 'cso');
    expect(Date.parse(r.entry.at)).toBeGreaterThan(0);
    expect(readLedger(vault).currency).toBe('GBP');
    const text = vault.readText(LEDGER_PATH);
    expect(text).toContain('opened:');
    expect(text).toContain('2026-09-01T00:00:00.000Z');   // the owner's frontmatter survived the append
    expect(text).toContain(ledgerRow(r.entry));            // and the new row actually reached the file
  });

  it('falls back to nowIso() when `at` is not a timestamp, rather than storing the garbage verbatim (review M3/ruling 6)', () => {
    const r = appendEntry(vault, { at: 'yesterday', kind: 'cost', cents: 100, mode: 'live', who: 'daemon', why: 'bad at' }, 'daemon');
    expect(r.entry.at).not.toBe('yesterday');
    expect(Number.isFinite(Date.parse(r.entry.at))).toBe(true);
    expect(readLedger(vault).problems).toEqual([]);
  });

  it('normalizes `ref` through cell() at construction, so a pipe or stray whitespace still dedupes (review I2/ruling 2)', () => {
    const a = appendEntry(vault, { kind: 'cost', cents: 100, mode: 'live', who: 'daemon', why: 'x', ref: ' job|1 ' }, 'daemon');
    expect(a.added).toBe(true);
    expect(a.entry.ref).toBe('job/1');   // stored form: the same `cell()` transform `ledgerRow` writes it through
    const b = appendEntry(vault, { kind: 'cost', cents: 100, mode: 'live', who: 'daemon', why: 'x', ref: 'job/1' }, 'daemon');
    expect(b.added).toBe(false);
    expect(readLedger(vault).entries).toHaveLength(1);
  });

  it('does not double-charge when the earlier same-ref row is itself unreadable (review M4/ruling 7)', () => {
    vault.writeText(LEDGER_PATH, ledgerTemplate() + '| 2026-09-12T08:00:00.000Z | cost | not-money | live | daemon | broken | dup-1 |\n', 'owner');
    const r = appendEntry(vault, { kind: 'cost', cents: 100, mode: 'live', who: 'daemon', why: 'retry', ref: 'dup-1' }, 'daemon');
    expect(r.added).toBe(false);
    const l = readLedger(vault);
    expect(l.entries).toEqual([]);        // the broken row still doesn't parse...
    expect(l.problems).toHaveLength(1);   // ...but no second row was appended behind its back
  });

  it('retries the append instead of losing a write that landed between its read and its write (review I1/ruling 1)', () => {
    appendEntry(vault, { at: '2026-09-12T08:00:00.000Z', kind: 'capital', cents: 1000, mode: 'live', who: 'owner', why: 'seed' }, 'owner');
    const realRead = vault.readTextOrNull.bind(vault);
    let calls = 0;
    const spy = vi.spyOn(vault, 'readTextOrNull').mockImplementation((rel: string) => {
      const text = realRead(rel);
      calls++;
      // On the first read inside appendEntry's loop, simulate an owner save landing right after we read:
      // write a second, concurrent row directly to disk (bypassing the vault API, like an Obsidian save would).
      if (rel === LEDGER_PATH && calls === 1 && text !== null) {
        writeFileSync(
          vault.abs(rel),
          text.replace(/\s+$/, '') + '\n| 2026-09-12T09:30:00.000Z | capital | 500.00 | live | owner | concurrent save |  |\n',
        );
      }
      return text;
    });
    const r = appendEntry(vault, { at: '2026-09-12T10:00:00.000Z', kind: 'cost', cents: 200, mode: 'live', who: 'daemon', why: 'after race' }, 'daemon');
    spy.mockRestore();
    expect(r.added).toBe(true);
    expect(calls).toBeGreaterThan(1);   // it actually retried, rather than happening to overlap harmlessly
    const entries = readLedger(vault).entries;
    expect(entries.map((e) => e.why)).toEqual(['seed', 'concurrent save', 'after race']);
  });
});
