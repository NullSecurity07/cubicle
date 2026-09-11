import { z } from 'zod';
import type { Vault } from './vault.js';
import { Timestamp } from './schemas.js';
import { parseNote, stringifyNote } from './frontmatter.js';
import { nowIso, atomicWriteSync } from './fs.js';

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
/**
 * `appendEntry` writes straight to disk with `atomicWriteSync` and does its own `recordWritten` /
 * `vault.wrote`, the same shape `writeCiRecord` (ci.ts) uses — deliberately going around
 * `vault.writeText`'s owner-owned guard rather than through it.
 *
 * `Ledger/` is owner-owned (`OWNER_OWNED_PREFIXES`, guard.ts), so that `vault.write`/`vault.append` refuse it
 * outright for every agent. But the book still has to accept a row from whichever role `ledger.record` ran as
 * (`cfo`, `cso`, …), and none of those are the privileged actors (`daemon`, `owner`, `system`, `init`) that
 * `assertWritable` lets through. `appendEntry` is the sanctioned exception — the *only* function, reached
 * through `ledger.record` or the daemon's own accrual, that may put a row in `Ledger/ledger.md` — exactly the
 * property `writeCiRecord` gives `.cubicle-ci/`: the general write API refuses the path, and one trusted
 * function that enforces its own rules (append-only, the idempotency key, and here the tool's cap and reason
 * check) is what is allowed to write it anyway.
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
  const next = (at >= 0
    ? [...lines.slice(0, at + 1), row, ...lines.slice(at + 1)]
    : [...lines, '', `| ${LEDGER_COLUMNS.join(' | ')} |`, `|${LEDGER_COLUMNS.map(() => '---').join('|')}|`, row]
  ).join('\n') + '\n';
  const sha = atomicWriteSync(vault.abs(LEDGER_PATH), next);
  vault.recordWritten(LEDGER_PATH, sha, by, next);
  vault.events.emit({ type: 'vault.wrote', agent: by, payload: { path: LEDGER_PATH, sha, by } });
  return { entry, added: true };
}

// ---------- the report (Task 2 stand-in) ----------
//
// `moneyReport` is Task 2's (impl-M2, commit fc2b4a2 on sp4, under review as rev-M2 — not yet merged onto this
// branch). `ledger.record` needs it to say what the company's cash position is after an entry, so this block is
// carried here verbatim from Task 2's brief pending the merge, the same way Task 2 itself carried a stand-in
// for Task 1's names before Task 1 merged. The coordinator should drop this whole section in favour of Task 2's
// own (larger) version — which also adds `moneyLine`, `moneyNeedsYou`, `runwayNote` and the runway note writer —
// when reconciling the two branches, rather than keep both.

/** How far back burn looks. Long enough to smooth a lumpy month, short enough to notice a new subscription. */
export const BURN_WINDOW_DAYS = 30;
/** Below this many days of runway the brief asks the owner for a decision. */
export const RUNWAY_WARN_DAYS = 14;

const DAY_MS = 86_400_000;

export interface MoneyReport {
  currency: string;
  /** live capital + live revenue − live cost. Can be negative; a book is allowed to tell bad news. */
  cashCents: number;
  burnCentsPerDay: number;
  /** null when nothing is being spent: "not spending", never "infinite" and never a number. */
  runwayDays: number | null;
  inCents: number;
  outCents: number;
  windowOutCents: number;
  windowDays: number;
  mockRevenueCents: number;
  mockCostCents: number;
  /** The owner has put money in at least once. Without this, dormancy would fire on every fresh install. */
  funded: boolean;
  dormant: boolean;
  firstAt: string | null;
  lastAt: string | null;
  /** When real money last moved — the mark the dormancy message is keyed on. */
  lastLiveAt: string | null;
  entries: number;
  problems: LedgerProblem[];
}

/**
 * The company's position, all in minor units.
 *
 * Two rules carry the weight. **Only `live` entries reach cash** — a simulated sale is reported beside the
 * figures and never inside them, because a runway computed from money nobody paid is worse than no runway.
 * And **dormancy needs a `capital` entry as well as an empty till**: an unfunded company has zero cash and must
 * still run, since running free is the whole point of this system.
 *
 * Burn divides the window's spend by the time the company has actually existed for, capped at the window. A
 * company one day old that spent 3.00 yesterday burns 3.00 a day, not 0.10 — the flattering answer is the one
 * that lets a company walk off a cliff.
 */
export function moneyReport(ledger: Ledger, now: Date = new Date()): MoneyReport {
  const live = ledger.entries.filter((e) => e.mode === 'live');
  const sum = (list: LedgerEntry[], kind: EntryKind) => list.reduce((t, e) => (e.kind === kind ? t + e.cents : t), 0);
  const mock = ledger.entries.filter((e) => e.mode === 'mock');
  const inCents = sum(live, 'capital') + sum(live, 'revenue');
  const outCents = sum(live, 'cost');
  const cashCents = inCents - outCents;
  const times = ledger.entries.map((e) => Date.parse(e.at)).filter((t) => Number.isFinite(t));
  const firstMs = times.length ? Math.min(...times) : null;
  const lastMs = times.length ? Math.max(...times) : null;
  const liveTimes = live.map((e) => Date.parse(e.at)).filter((t) => Number.isFinite(t));
  const windowFrom = now.getTime() - BURN_WINDOW_DAYS * DAY_MS;
  const windowOutCents = live.reduce((t, e) => (e.kind === 'cost' && Date.parse(e.at) >= windowFrom ? t + e.cents : t), 0);
  const ageDays = firstMs === null ? 1 : Math.ceil((now.getTime() - firstMs) / DAY_MS);
  const windowDays = Math.max(1, Math.min(BURN_WINDOW_DAYS, ageDays));
  const burnCentsPerDay = Math.round(windowOutCents / windowDays);
  const funded = live.some((e) => e.kind === 'capital');
  return {
    currency: ledger.currency,
    cashCents, burnCentsPerDay,
    runwayDays: burnCentsPerDay > 0 ? Math.max(0, Math.floor(cashCents / burnCentsPerDay)) : null,
    inCents, outCents, windowOutCents, windowDays,
    mockRevenueCents: sum(mock, 'revenue'), mockCostCents: sum(mock, 'cost'),
    funded, dormant: funded && cashCents <= 0,
    firstAt: firstMs === null ? null : new Date(firstMs).toISOString(),
    lastAt: lastMs === null ? null : new Date(lastMs).toISOString(),
    lastLiveAt: liveTimes.length ? new Date(Math.max(...liveTimes)).toISOString() : null,
    entries: ledger.entries.length,
    problems: ledger.problems,
  };
}
