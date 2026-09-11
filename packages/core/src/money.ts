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

export function parseMoney(text: string): number | null {
  const t = String(text ?? '').trim().replace(/^[A-Za-z]{3}\s+/, '').replace(/^[$£€]\s*/, '').trim();
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
  /** An idempotency key (a job id, `model-<date>`) or ''. A second entry with the same non-empty ref is refused. */
  ref: z.string().default(''),
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

/**
 * The book as data. Rows before the header are ignored (the note is allowed to carry prose and other tables);
 * rows after it that do not parse become problems carrying their **file** line number, so the brief can point
 * the owner at the line to fix.
 */
export function parseLedger(md: string): Ledger {
  const note = parseNote(md);
  const declared = String(note.data.currency ?? '').trim().toUpperCase();
  const currency = CURRENCY_RE.test(declared) ? declared : DEFAULT_CURRENCY;
  const lines = note.body.split('\n');
  const offset = md.split('\n').length - lines.length;
  const entries: LedgerEntry[] = [];
  const problems: LedgerProblem[] = [];
  let seenHeader = false;
  for (let i = 0; i < lines.length; i++) {
    const c = cells(lines[i]);
    if (c.length < LEDGER_COLUMNS.length - 1) continue;
    if (!seenHeader) { seenHeader = isHeader(c); continue; }
    if (isSeparator(c)) continue;
    const problem = (reason: string) => problems.push({ line: offset + i + 1, text: lines[i].trim(), reason });
    const [at, kind, amount, mode, who, why, ref = ''] = c;
    const cents = parseMoney(amount);
    if (cents === null) { problem(`"${amount}" is not an amount (positive, at most two decimal places)`); continue; }
    if (!at || !Number.isFinite(Date.parse(at))) { problem(`at: "${at}" is not a timestamp`); continue; }
    const parsed = LedgerEntry.safeParse({ at, kind: kind.toLowerCase(), cents, mode: (mode || 'live').toLowerCase(), who, why, ref });
    if (!parsed.success) { problem(parsed.error.issues.map((iss) => `${iss.path.join('.') || 'row'}: ${iss.message}`).join('; ')); continue; }
    entries.push(parsed.data);
  }
  return { currency, entries, problems };
}

/** A cell can hold neither a pipe nor a newline without breaking the table; both become a space-safe stand-in. */
const cell = (s: string): string => s.replace(/\|/g, '/').replace(/\s*\r?\n\s*/g, ' ').trim();

export function ledgerRow(e: LedgerEntry): string {
  return `| ${e.at} | ${e.kind} | ${formatMoney(e.cents)} | ${e.mode} | ${cell(e.who)} | ${cell(e.why)} | ${cell(e.ref)} |`;
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

/**
 * Add one row. The only writer there is, and the reason the book can be trusted: it reads the note, splices one
 * line in after the last table row, and writes it back. Every other byte of the file — the owner's prose, their
 * own rows, their currency — is untouched.
 *
 * A non-empty `ref` is an idempotency key: the daily model-cost accrual and any job-derived entry pass one, so a
 * replayed cycle finds its own row instead of charging the company twice.
 */
export function appendEntry(vault: Vault, e: NewEntry, by: string): { entry: LedgerEntry; added: boolean } {
  const entry = LedgerEntry.parse({ ...e, at: e.at ?? nowIso(), ref: e.ref ?? '' });
  const md = vault.readTextOrNull(LEDGER_PATH) ?? ledgerTemplate();
  if (entry.ref) {
    const dup = parseLedger(md).entries.find((x) => x.ref === entry.ref);
    if (dup) return { entry: dup, added: false };
  }
  const lines = md.replace(/\s+$/, '').split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim().startsWith('|')) { at = i; break; }
  const row = ledgerRow(entry);
  const next = at >= 0
    ? [...lines.slice(0, at + 1), row, ...lines.slice(at + 1)]
    : [...lines, '', `| ${LEDGER_COLUMNS.join(' | ')} |`, `|${LEDGER_COLUMNS.map(() => '---').join('|')}|`, row];
  vault.writeText(LEDGER_PATH, next.join('\n') + '\n', by);
  return { entry, added: true };
}

// ---------- the CFO's split ----------

/** Where the heartbeat's own calls, the board, security and anyone with no division are charged. */
export const HOUSE = 'house';
/** No division is ever allocated less than this: a division that cannot hold one planning round is stopped, not budgeted. */
export const MIN_DIVISION_CALLS = 20;
/** Taken off the top for the house before the divisions split the rest. */
export const HOUSE_RESERVE_PCT = 0.25;

export interface DivisionWeight { id: string; people: number }

/**
 * Split a day's free calls between the divisions and the house.
 *
 * The house is reserved first, because the heartbeat, the gates and the board session are what keep the company
 * coherent and must not be starved by whichever division is busiest. What is left goes by headcount, with a
 * floor so a small division can still hold a planning round, and the remainder distributed largest-fraction
 * first so the allocation sums to the capacity **exactly** — a split that drifts by a call a day is a gauge
 * that slowly stops meaning anything.
 *
 * Deterministic: divisions are sorted by id and ties in the remainder are broken by id, so two calls with the
 * same input always return the same object.
 */
export function allocateQuota(capacity: number, divisions: DivisionWeight[], opts: { reservePct?: number; floor?: number } = {}): Record<string, number> {
  const cap = Math.max(0, Math.floor(capacity));
  const reservePct = opts.reservePct ?? HOUSE_RESERVE_PCT;
  const floor = opts.floor ?? MIN_DIVISION_CALLS;
  const ids = [...divisions].sort((a, b) => a.id.localeCompare(b.id));
  const out: Record<string, number> = { [HOUSE]: cap };
  for (const d of ids) out[d.id] = 0;
  if (cap === 0 || ids.length === 0) return out;

  const pool = cap - Math.ceil(cap * reservePct);
  // Too small to give every division something: the house keeps it all and every division runs on the cheap
  // tier, which is the floor and is effectively unlimited. Nothing stops.
  const base = pool >= floor * ids.length ? floor : 1;
  if (pool < base * ids.length) return out;

  const remaining = pool - base * ids.length;
  const totalPeople = ids.reduce((t, d) => t + Math.max(0, d.people), 0);
  const shares = ids.map((d) => {
    const exact = totalPeople > 0 ? (remaining * Math.max(0, d.people)) / totalPeople : remaining / ids.length;
    return { id: d.id, whole: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let given = shares.reduce((t, s) => t + s.whole, 0);
  const order = [...shares].sort((a, b) => b.frac - a.frac || a.id.localeCompare(b.id));
  for (let i = 0; given < remaining; i++, given++) order[i % order.length].whole += 1;
  for (const s of shares) out[s.id] = base + s.whole;
  out[HOUSE] = cap - ids.reduce((t, d) => t + out[d.id], 0);
  return out;
}
