import { z } from 'zod';
import type { Vault } from './vault.js';
import { Timestamp } from './schemas.js';
import { parseNote, stringifyNote } from './frontmatter.js';
import { nowIso } from './fs.js';

/**
 * Money: the company's book, and the arithmetic over it.
 *
 * Three kinds of row — the owner puts `capital` in, `revenue` comes in, `cost` goes out — and one rule that
 * makes the rest safe: **the book is append-only**. Nothing here rewrites a row. A correction is a compensating
 * entry, which is what a ledger is for; an entry the parser cannot read is kept in the file and reported, so an
 * owner's typo shows up as a complaint in the brief rather than as money quietly vanishing.
 *
 * Every amount is an integer number of minor units (cents, pence). `parseMoney` reads the digits either side of
 * the decimal point as strings and never multiplies a float by 100 — `parseFloat('0.29') * 100` is
 * 28.999999999999996, and a book that loses a penny a day is a book nobody trusts.
 */

export const LEDGER_DIR = 'Ledger';
export const LEDGER_PATH = `${LEDGER_DIR}/ledger.md`;
export const RUNWAY_PATH = `${LEDGER_DIR}/runway.md`;

/** ISO 4217, three letters. One currency per company: a multi-currency book needs rates, and rates need a source. */
export const DEFAULT_CURRENCY = 'USD';
export const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * A positive decimal with at most two places, optionally with thousands separators and a leading currency
 * marker the owner may have typed. Anything else — three decimal places, a negative, scientific notation, a
 * trailing point — returns null and becomes a reported problem, never a guess.
 */
const MONEY_RE = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;
/** 12 digits of major units is ~1e14 minor units, comfortably inside Number.MAX_SAFE_INTEGER. */
const MAX_MAJOR_DIGITS = 12;

/** Escape a string for use inside a RegExp literal. */
const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The handful of currencies this company can plausibly hold cash in. Adding one is a one-line change. */
const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', GBP: '£', EUR: '€', INR: '₹' };

/**
 * `currency` is the ledger's own declared code (defaulting to `DEFAULT_CURRENCY` for a standalone call) — only
 * *that* code, and *that* code's own symbol, are stripped as markers. Any other leading letters or a different
 * currency's symbol are left in place and fail to parse, so a garbled cell (`"abc 12.00"`) or a wrong-currency
 * one (`"$12.00"` in a GBP ledger) is reported as unreadable rather than silently read as money.
 */
export function parseMoney(text: string, currency: string = DEFAULT_CURRENCY): number | null {
  const codeRe = new RegExp(`^${reEscape(currency)}\\s+`, 'i');
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
  const symbolRe = symbol ? new RegExp(`^${reEscape(symbol)}\\s*`) : null;
  let t = String(text ?? '').trim().replace(codeRe, '');
  if (symbolRe) t = t.replace(symbolRe, '');
  t = t.trim();
  const m = MONEY_RE.exec(t);
  if (!m) return null;
  const major = m[1].replace(/,/g, '');
  if (major.length > MAX_MAJOR_DIGITS) return null;
  return Number(major) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** Minor units back to the two-place decimal the book stores. Negative is allowed here: cash can go under. */
export function formatMoney(cents: number): string {
  const n = Math.trunc(cents);
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** `USD 250.00`. The code, never a symbol: `$` means at least five different currencies. */
export function money(cents: number, currency: string = DEFAULT_CURRENCY): string {
  return `${currency} ${formatMoney(cents)}`;
}

/** `capital` is the owner putting money in; `revenue` comes in; `cost` goes out. The kind carries the sign. */
export const ENTRY_KINDS = ['capital', 'revenue', 'cost'] as const;
export const EntryKind = z.enum(ENTRY_KINDS);
export type EntryKind = z.infer<typeof EntryKind>;

/**
 * Whether the money really moved. `mock` is a simulation — a mock sale, a mock service charge — and it never
 * reaches cash. The heartbeat already refuses to let a mock deploy read as a real one (`mockedServicesRow`);
 * this is the same rule with a currency sign on it, where getting it wrong would produce a runway from money
 * nobody paid.
 */
export const ENTRY_MODES = ['live', 'mock'] as const;
export const EntryMode = z.enum(ENTRY_MODES);
export type EntryMode = z.infer<typeof EntryMode>;

export const LedgerEntry = z.object({
  at: Timestamp,
  kind: EntryKind,
  /** Always positive, in minor units. */
  cents: z.number().int().min(0),
  mode: EntryMode,
  /** `owner`, or the role id that recorded it. */
  who: z.string().min(1),
  /** One sentence. An entry nobody can explain is an entry nobody can check. */
  why: z.string().min(1),
  /**
   * An idempotency key (a job id, `model-<date>`) or ''. A second entry with the same non-empty ref is refused.
   * Refs are ids, not prose: unlike `who`/`why`, a `|` or a newline is refused here rather than silently mapped
   * to a space-safe stand-in — two different ids must never collide into the same stored string.
   */
  ref: z.string().default('').refine((v) => !/[|\r\n]/.test(v), { message: 'ref must not contain "|" or a newline — refs are ids, not prose' }),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export type NewEntry = Omit<LedgerEntry, 'at' | 'ref'> & { at?: string; ref?: string };

export const LEDGER_COLUMNS = ['at', 'kind', 'amount', 'mode', 'who', 'why', 'ref'] as const;

export interface LedgerProblem { line: number; text: string; reason: string }
export interface Ledger { currency: string; entries: LedgerEntry[]; problems: LedgerProblem[] }

/** A markdown table row's cells, or [] for a line that is not one. */
function cells(line: string): string[] {
  const t = line.trim();
  if (!t.startsWith('|')) return [];
  return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

const isSeparator = (c: string[]): boolean => c.every((x) => /^:?-{3,}:?$/.test(x));
const isHeader = (c: string[]): boolean => c[0]?.toLowerCase() === LEDGER_COLUMNS[0] && c[1]?.toLowerCase() === LEDGER_COLUMNS[1];

/** A cell can hold neither a pipe nor a newline without breaking the table; both become a space-safe stand-in. */
const cell = (s: string): string => s.replace(/\|/g, '/').replace(/\s*\r?\n\s*/g, ' ').trim();

/** The ledger's declared currency (from frontmatter), or `DEFAULT_CURRENCY` when absent or not a real code. */
function resolveCurrency(data: Record<string, unknown>): string {
  const declared = String(data.currency ?? '').trim().toUpperCase();
  return CURRENCY_RE.test(declared) ? declared : DEFAULT_CURRENCY;
}

/**
 * The rows of the *first* markdown table after the header — real table boundaries: a blank (or otherwise
 * non-`|`) line ends it, and anything after that belongs to a different table or to prose and is left alone
 * (a note may carry its own tables below the book, spec §1 and the doc comment on `parseLedger` both promise
 * that). Yields every row's raw cells except the separator; a too-short row is still yielded (so the caller can
 * report it) as long as it is still inside this first table.
 */
function tableRows(md: string): { line: string; index: number; cells: string[] }[] {
  const note = parseNote(md);
  const lines = note.body.split('\n');
  const out: { line: string; index: number; cells: string[] }[] = [];
  let seenHeader = false;
  let tableEnded = false;
  for (let i = 0; i < lines.length; i++) {
    const c = cells(lines[i]);
    if (!seenHeader) {
      if (c.length < LEDGER_COLUMNS.length - 1) continue; // pre-header prose or an unrelated table
      seenHeader = isHeader(c);
      continue;
    }
    if (tableEnded) continue; // a second table (or prose) below the ledger's own — not ours to read
    if (c.length === 0) { tableEnded = true; continue; } // blank line: the ledger table itself is over
    if (isSeparator(c)) continue;
    out.push({ line: lines[i], index: i, cells: c });
  }
  return out;
}

/**
 * The book as data. Rows before the header, and any table other than the first one found after it, are ignored
 * (the note is allowed to carry prose and its own other tables — above the header, or below the ledger table
 * once a blank line has ended it). Within that first table, a row that does not parse becomes a problem
 * carrying its **file** line number, so the brief can point the owner at the line to fix; a row too short to be
 * a table row at all (fewer than `LEDGER_COLUMNS.length - 1`, i.e. missing more than just the optional `ref`
 * column) is reported the same way rather than silently skipped — the owner-edited-it-down-to-nothing case
 * spec §1 requires kept and complained about.
 */
export function parseLedger(md: string): Ledger {
  const note = parseNote(md);
  const currency = resolveCurrency(note.data as Record<string, unknown>);
  const offset = md.split('\n').length - note.body.split('\n').length;
  const entries: LedgerEntry[] = [];
  const problems: LedgerProblem[] = [];
  for (const { line, index, cells: c } of tableRows(md)) {
    const problem = (reason: string) => problems.push({ line: offset + index + 1, text: line.trim(), reason });
    if (c.length < LEDGER_COLUMNS.length - 1) { problem(`row has ${c.length} cells, expected at least ${LEDGER_COLUMNS.length - 1}`); continue; }
    const [at, kind, amount, mode, who, why, ref = ''] = c;
    const cents = parseMoney(amount, currency);
    if (cents === null) { problem(`"${amount}" is not an amount (positive, at most two decimal places)`); continue; }
    if (!at || !Number.isFinite(Date.parse(at))) { problem(`at: "${at}" is not a timestamp`); continue; }
    const parsed = LedgerEntry.safeParse({ at, kind: kind.toLowerCase(), cents, mode: mode.toLowerCase(), who, why, ref: ref.trim() });
    if (!parsed.success) { problem(parsed.error.issues.map((iss) => `${iss.path.join('.') || 'row'}: ${iss.message}`).join('; ')); continue; }
    entries.push(parsed.data);
  }
  return { currency, entries, problems };
}

/**
 * The row already in the book under `ref`, whether it parses cleanly or not — so `appendEntry`'s dedup can
 * always answer "what's already there" instead of fabricating a value or handing back the caller's own
 * unwritten entry (M4/N3). A row that parses is returned as parsed; a row that carries the same `ref` cell but
 * fails validation elsewhere (a bad `kind`, an unreadable amount) is reconstructed best-effort from its raw
 * cells — never written anywhere, only ever reported back to the caller.
 */
function findByRef(md: string, ref: string): LedgerEntry | null {
  const currency = resolveCurrency(parseNote(md).data as Record<string, unknown>);
  for (const { cells: c } of tableRows(md)) {
    if (c.length < LEDGER_COLUMNS.length - 1) continue; // too short to carry a ref at all
    const [at, kind, amount, mode, who, why, rawRef = ''] = c;
    if (rawRef.trim() !== ref) continue;
    const cents = parseMoney(amount, currency);
    const parsed = LedgerEntry.safeParse({ at, kind: kind.toLowerCase(), cents: cents ?? 0, mode: mode.toLowerCase(), who, why, ref: rawRef.trim() });
    if (parsed.success) return parsed.data;
    return { at, kind: kind as EntryKind, cents: cents ?? 0, mode: mode as EntryMode, who, why, ref: rawRef.trim() } as LedgerEntry;
  }
  return null;
}

export function ledgerRow(e: LedgerEntry): string {
  return `| ${e.at} | ${e.kind} | ${formatMoney(e.cents)} | ${e.mode} | ${cell(e.who)} | ${cell(e.why)} | ${e.ref} |`;
}

/**
 * The index within `lines` (the *whole* file, frontmatter included — the same array `appendEntry` is about to
 * splice) of the last line of the ledger's own first table, or -1 if there is no table yet. Mirrors
 * `tableRows`'s header/blank-line boundary so a new row is always spliced into the ledger table itself, even
 * when the note carries a second table underneath it (N1) — never onto the end of whatever table happens to be
 * last in the file.
 */
function lastLedgerTableLineIndex(lines: string[]): number {
  let seenHeader = false;
  let tableEnded = false;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const c = cells(lines[i]);
    if (!seenHeader) {
      if (c.length < LEDGER_COLUMNS.length - 1) continue;
      seenHeader = isHeader(c);
      continue;
    }
    if (tableEnded) continue;
    if (c.length === 0) { tableEnded = true; continue; }
    last = i;
  }
  return last;
}

export function ledgerTemplate(currency: string = DEFAULT_CURRENCY, opened: string = nowIso()): string {
  return stringifyNote({ currency, opened }, [
    '# Ledger',
    '',
    'Every movement of money, one row per entry, oldest first.',
    '',
    '**Append only.** Nothing ever edits a row that is already here — a mistake is corrected with a second row',
    'that cancels it out, so the history stays true. `capital` is money you put in; `revenue` is money coming in;',
    '`cost` is money going out. `mode: mock` means a simulation, and it never counts as cash.',
    '',
    `| ${LEDGER_COLUMNS.join(' | ')} |`,
    `|${LEDGER_COLUMNS.map(() => '---').join('|')}|`,
    '',
  ].join('\n'));
}

export function readLedger(vault: Vault): Ledger {
  const md = vault.readTextOrNull(LEDGER_PATH);
  return md === null ? { currency: DEFAULT_CURRENCY, entries: [], problems: [] } : parseLedger(md);
}

/** Bounded retries for the compare-and-write race in `appendEntry`; an append commutes, so a retry never loses work. */
const MAX_APPEND_ATTEMPTS = 5;

/**
 * Add one row. The only writer there is, and the reason the book can be trusted: it reads the note, splices one
 * line in after the last table row, and writes it back. Every other byte of the file — the owner's prose, their
 * own rows, their currency — is untouched.
 *
 * A non-empty `ref` is an idempotency key: the daily model-cost accrual and any job-derived entry pass one, so a
 * replayed cycle finds its own row instead of charging the company twice. It is trimmed at construction, and
 * `LedgerEntry` itself refuses a `ref` containing `|` or a newline (refs are ids, not prose — unlike `who`/`why`,
 * which keep the space-safe `cell()` replacement) — so the value compared against the file and the value stored
 * in it are always the same string, and two different ids can never collide into one.
 *
 * Compare-and-write, the same hazard `updateNote` guards against: the ledger is the most owner-edited file in the
 * vault (the owner types `capital` rows into it directly), so a save landing between this function's read and its
 * write must not be clobbered. `vault.currentSha` is checked immediately before the write; on a change it re-reads
 * and re-splices on the fresh copy — an append commutes, so retrying never loses the concurrent write — bounded to
 * `MAX_APPEND_ATTEMPTS` attempts before giving up loudly rather than silently dropping either side.
 */
export function appendEntry(vault: Vault, e: NewEntry, by: string): { entry: LedgerEntry; added: boolean } {
  const at = e.at !== undefined && Number.isFinite(Date.parse(e.at)) ? e.at : nowIso();
  const entry = LedgerEntry.parse({ ...e, at, ref: (e.ref ?? '').trim() });

  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    const before = vault.currentSha(LEDGER_PATH);
    const md = vault.readTextOrNull(LEDGER_PATH) ?? ledgerTemplate();

    if (entry.ref) {
      const dup = findByRef(md, entry.ref);
      if (dup) return { entry: dup, added: false };
    }

    const lines = md.replace(/\s+$/, '').split('\n');
    const insertAt = lastLedgerTableLineIndex(lines);
    const row = ledgerRow(entry);
    const next = insertAt >= 0
      ? [...lines.slice(0, insertAt + 1), row, ...lines.slice(insertAt + 1)]
      : [...lines, '', `| ${LEDGER_COLUMNS.join(' | ')} |`, `|${LEDGER_COLUMNS.map(() => '---').join('|')}|`, row];

    if (vault.currentSha(LEDGER_PATH) !== before) {
      vault.events.emit({ type: 'daemon.warning', payload: { path: LEDGER_PATH, reason: 'note changed during update; retrying the append on the fresh copy' } });
      continue;
    }
    vault.writeText(LEDGER_PATH, next.join('\n') + '\n', by);
    return { entry, added: true };
  }
  throw new Error(`appendEntry: ${LEDGER_PATH} changed under us ${MAX_APPEND_ATTEMPTS} times in a row; giving up`);
}
