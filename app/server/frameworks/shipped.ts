import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// What a team is, for telling a copy the founder never touched from one they changed: everything in the file except
// the bookkeeping the app writes into it by itself. The id is the folder's name, `shippedHash` records which shipped
// version a copy came from, and `version` and `scorecard` are what promoting an evals run bumps — a scored team is
// still the team that shipped, with the same briefs. `stage` is the shelf the panel shows it on: moving a team to
// another shelf changes nothing anybody on it reads.
const BOOKKEEPING = new Set(['id', 'shippedHash', 'version', 'scorecard', 'update', 'stage']);

// Keys in one order, so the same team written by a different hand, or with its fields shuffled, hashes the same.
const steady = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(steady);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, steady((value as Record<string, unknown>)[key])]));
  }
  return value;
};

export function contentHash(framework: Record<string, unknown>): string {
  const kept = Object.fromEntries(Object.entries(framework).filter(([key]) => !BOOKKEEPING.has(key)));
  return createHash('sha256').update(JSON.stringify(steady(kept))).digest('hex').slice(0, 16);
}

// Every version of every built-in team that has ever shipped, by id, as content hashes. A workspace copy whose content
// is one of these is a copy nobody changed, so it can be swapped for today's team without losing a word of anybody's.
// Written by `pnpm frameworks:ledger` from the repository's history; a test fails when a built-in changes without it.
export type Ledger = Record<string, string[]>;
export const LEDGER_FILE = 'shipped.json';
export const readLedger = async (from: string): Promise<Ledger> =>
  JSON.parse(await readFile(join(from, LEDGER_FILE), 'utf8').catch(() => '{}')) as Ledger;
