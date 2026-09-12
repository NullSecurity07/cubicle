import { z } from 'zod';
import type { Vault } from './vault.js';
import { Timestamp } from './schemas.js';
import { parseNote, stringifyNote } from './frontmatter.js';
import { nowIso } from './fs.js';
import { isNeverModifyPath } from './guard.js';

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
export interface Ledger {
  currency: string;
  entries: LedgerEntry[];
  problems: LedgerProblem[];
  /**
   * The book is not there at all. `vault-template/` ships one and `migrateOrg` copies `Ledger/` into an existing
   * vault, so this means the owner has deleted it — and then `currency` below is `DEFAULT_CURRENCY` because
   * something has to be, not because anyone declared it. Carried through `moneyReport` so the runway note can say
   * as much instead of presenting a borrowed currency as the company's own.
   */
  missing?: boolean;
}

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
  // No book: an empty position in the default currency, flagged as undeclared. Nothing here creates the file —
  // the first `appendEntry` does, and until then the company has no currency of its own.
  return md === null ? { currency: DEFAULT_CURRENCY, entries: [], problems: [], missing: true } : parseLedger(md);
}

/** Bounded retries for the compare-and-write race in `appendEntry`; an append commutes, so a retry never loses work. */
const MAX_APPEND_ATTEMPTS = 5;

/**
 * The `where` on the retry warning. Every other `daemon.warning` in the repo carries one, and `docs/events.md`
 * documents the type as "where, message" — a row without it is a row nothing can filter or explain.
 */
export const LEDGER_APPEND_RETRY = 'ledger.append_retry';

/** Thrown by `appendEntry` when the owner's own `never_modify` names the book — see its doc comment. */
export class LedgerVetoedError extends Error {
  constructor() {
    super(`${LEDGER_PATH} is on the owner's own never_modify list; refusing to write it even as the privileged actor appendEntry otherwise always uses`);
    this.name = 'LedgerVetoedError';
  }
}

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
 *
 * `Ledger/` is owner-owned (`OWNER_OWNED_PREFIXES`, guard.ts), so `vault.write`/`vault.append` refuse it outright
 * for every agent — but the book still has to accept a row from whichever role `ledger.record` ran as (`cfo`,
 * `cso`, …), and none of those are the privileged actors (`daemon`, `owner`, `system`, `init`) that
 * `assertWritable` lets through. Rather than go around `vault.writeText` (which would lose the compare-and-write
 * above and the `vault.wrote` event other code relies on), the actual write below always goes through as
 * `'daemon'` — the same actor the daemon's own writes use — regardless of who called `appendEntry`. Nothing
 * about who really asked is lost: every caller already puts that in the entry itself (`e.who`, the row's `who`
 * column, the record that matters for the book); `'daemon'` here is only ever the vault layer's write
 * provenance for *this one file*. (The parameter this used to thread through as `by` is `_by`, kept only so
 * every existing call site still compiles; nothing here reads it — see below for the owner's real veto.)
 *
 * A privileged actor makes `assertWritable` return without even looking at the owner's `never_modify` list, so
 * fixing the actor to `'daemon'` would otherwise silently overrule an owner who lists `Ledger/ledger.md` (or a
 * `Ledger/` entry) there on purpose. `appendEntry` checks that list itself, before ever touching the file, and
 * throws rather than write — the one veto `'daemon'` cannot bypass, because this function asks first.
 */
export function appendEntry(vault: Vault, e: NewEntry, _by: string): { entry: LedgerEntry; added: boolean } {
  if (isNeverModifyPath(LEDGER_PATH, vault.constitution().never_modify)) {
    throw new LedgerVetoedError();
  }
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
      vault.events.emit({ type: 'daemon.warning', payload: { where: LEDGER_APPEND_RETRY, path: LEDGER_PATH, reason: 'note changed during update; retrying the append on the fresh copy' } });
      continue;
    }
    // Written as the privileged actor: `Ledger/` is owner-owned (see the doc comment above), and the role
    // `ledger.record` ran as never is. `e.who` (already in `entry`) is the row's own record of who asked.
    vault.writeText(LEDGER_PATH, next.join('\n') + '\n', 'daemon');
    return { entry, added: true };
  }
  throw new Error(`appendEntry: ${LEDGER_PATH} changed under us ${MAX_APPEND_ATTEMPTS} times in a row; giving up`);
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


// ---------- the report ----------

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
  /** `Ledger/ledger.md` is not there, so `currency` is a default and not the company's declared one. */
  bookMissing: boolean;
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
  // The window's denominator is how long the company has actually been *spending real money* for — a mock
  // row (a simulated sale, dated whenever a demo happened to be run) must never stretch it out and flatter burn.
  const firstLiveMs = liveTimes.length ? Math.min(...liveTimes) : null;
  const ageDays = firstLiveMs === null ? 1 : Math.ceil((now.getTime() - firstLiveMs) / DAY_MS);
  const windowDays = Math.max(1, Math.min(BURN_WINDOW_DAYS, ageDays));
  // A real spend never rounds down to a burn of 0 — that would report "not spending" for a company that is.
  const burnCentsPerDay = windowOutCents > 0 ? Math.max(1, Math.round(windowOutCents / windowDays)) : 0;
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
    bookMissing: ledger.missing === true,
  };
}

const days = (n: number): string => `${n} day${n === 1 ? '' : 's'}`;

/** The one money line the brief carries. One line, every cycle, whether or not anything happened. */
export function moneyLine(r: MoneyReport): string {
  const runway = r.runwayDays === null ? 'not spending (nothing has cost anything yet)' : `runway ${days(r.runwayDays)}`;
  const mock = r.mockRevenueCents > 0 ? `; ${money(r.mockRevenueCents, r.currency)} of simulated revenue, which is not cash` : '';
  return `Money: ${money(r.cashCents, r.currency)} cash, ${money(r.burnCentsPerDay, r.currency)} a day burn, ${runway}${mock}${r.dormant ? ' — the company is dormant' : ''}`;
}

/**
 * The brief's "What needs you" rows, and only when something does. A money section that speaks every cycle is
 * a money section the owner stops reading, so three things earn a row and nothing else: the company has stopped,
 * the runway is short, or the book has a line nobody can read.
 */
export function moneyNeedsYou(r: MoneyReport): string[] {
  const out: string[] = [];
  if (r.dormant) {
    out.push(`- The company has spent the money you put in (${money(r.cashCents, r.currency)}) and is dormant: only the heartbeat runs. Add a \`capital\` row to \`${LEDGER_PATH}\` to bring it back`);
  } else if (r.runwayDays !== null && r.runwayDays <= RUNWAY_WARN_DAYS) {
    out.push(`- Runway is ${days(r.runwayDays)} at ${money(r.burnCentsPerDay, r.currency)} a day — add capital in \`${LEDGER_PATH}\` or cut what is costing money`);
  }
  if (r.problems.length) {
    out.push(`- ${r.problems.length} row${r.problems.length === 1 ? '' : 's'} in \`${LEDGER_PATH}\` cannot be read (line${r.problems.length === 1 ? '' : 's'} ${r.problems.map((p) => p.line).join(', ')}): ${r.problems[0].reason}`);
  }
  return out;
}

/** The one section of the runway note an agent contributes: the CFO's job summary, folded in by the daemon. */
export const RUNWAY_COMMENTARY = '## What the CFO makes of it';

export interface RunwayInputs {
  /** Model calls in the window the note covers. */
  calls: number;
  paidCalls: number;
  /** What those calls would have cost on the prices in `config/providers.yaml`. Never a ledger entry. */
  shadowCents: number;
  /** Whether any model anywhere carries a `price:` at all. */
  priced: boolean;
  quotas: { division: string; used: number; quota: number }[];
  commentary?: string;
  /**
   * The day the commentary was written — the `finance.runway` job's `updated` date. The note is regenerated on
   * every heartbeat (four a day) while the job runs once a day, so for most of a day the page carries today's
   * cash above yesterday's opinion of it, and after a weekend outage a week-old one. Dated where it is not
   * today's, so the owner can tell an old read from a fresh one.
   */
  commentaryDate?: string;
  generatedAt?: string;
}

/**
 * `Ledger/runway.md`. Every figure on this page is arithmetic over the book; no model writes a number here,
 * because a hallucinated runway on the owner's bank screen is the one failure this whole sub-project exists to
 * prevent. The CFO's opinion arrives as the `finance.runway` job's summary and is folded into one named section.
 */
export function runwayNote(r: MoneyReport, o: RunwayInputs): string {
  const runway = r.runwayDays === null
    ? '**Runway:** not spending. Nothing has cost the company anything yet, so there is nothing to run out of.'
    : `**Runway:** ${days(r.runwayDays)} at today's burn.`;
  const shadow = o.shadowCents > 0
    ? `${o.paidCalls} of ${o.calls} model call${o.calls === 1 ? '' : 's'} today were on a priced model: ${money(o.shadowCents, r.currency)}.`
    : o.priced
      ? `All ${o.calls} model call${o.calls === 1 ? '' : 's'} today were on free tiers, so they cost nothing.`
      : `All ${o.calls} model call${o.calls === 1 ? '' : 's'} today were on free tiers. No model in \`config/providers.yaml\` carries a \`price:\`, so there is nothing to compare against — add one to see what a paid tier would have cost.`;
  const lines: string[] = [
    '# Runway', '',
    '_Generated by the daemon. Every figure here is arithmetic over `Ledger/ledger.md`; nothing was written by a model. Edit nothing — it is overwritten._', '',
    `**Cash:** ${money(r.cashCents, r.currency)}`, '',
    `**Burn:** ${money(r.burnCentsPerDay, r.currency)} a day (${money(r.windowOutCents, r.currency)} over ${days(r.windowDays)})`, '',
    runway, '',
  ];
  if (r.bookMissing) {
    lines.push(`\`${LEDGER_PATH}\` is not there, so the company has **no declared currency** — the figures above are in ${r.currency} because something has to be shown, not because anyone chose it. Create the book (or let \`ledger.record\` create it) and its frontmatter decides.`, '');
  }
  if (r.dormant) lines.push(`**The company is dormant.** It has spent the capital it was given. Only the heartbeat runs until a \`capital\` row is added to \`${LEDGER_PATH}\`.`, '');
  if (r.mockRevenueCents > 0) lines.push(`Simulated revenue so far: ${money(r.mockRevenueCents, r.currency)}. It is **not** cash and is not counted above — nobody paid it.`, '');
  lines.push('## What a paid tier would have cost', '', shadow, '');
  lines.push('## Model quota per division', '',
    'Free-tier calls each division may make at the strong and medium tiers today. Past its quota a division drops to the cheapest tier; it never stops.', '',
    ...(o.quotas.length
      ? ['| division | calls today | quota |', '|---|---|---|', ...o.quotas.map((q) => `| ${q.division} | ${q.used} | ${q.quota} |`)]
      : ['_Nothing allocated: no team holds a planning round yet._']),
    '');
  lines.push('## Rows that do not parse', '',
    ...(r.problems.length
      ? r.problems.map((p) => `- line ${p.line}: ${p.reason} — \`${p.text.slice(0, 120)}\``)
      : ['_Every row in the ledger parses._']),
    '');
  // The CFO's own words, and — when they are not from today — the day they were written. The figures above are
  // always this minute's; saying nothing would let a week-old opinion read as a comment on them.
  const commentary = (o.commentary ?? '').trim();
  const today = (o.generatedAt ?? nowIso()).slice(0, 10);
  const said = (o.commentaryDate ?? '').slice(0, 10);
  lines.push(RUNWAY_COMMENTARY, '');
  if (commentary && said && said !== today) lines.push(`_From the CFO's ${said} read; the figures above are current._`, '');
  lines.push(commentary || '_The CFO has not commented yet. The daily `finance.runway` job writes this._', '');
  return stringifyNote({
    generated: o.generatedAt ?? nowIso(),
    currency: r.currency,
    cash_cents: r.cashCents,
    burn_cents_per_day: r.burnCentsPerDay,
    runway_days: r.runwayDays,
    dormant: r.dormant,
    entries: r.entries,
    problems: r.problems.length,
  }, lines.join('\n'));
}
