import { z } from 'zod';
import { defineTool } from '../registry.js';
import { appendEntry, readLedger, moneyReport, parseMoney, money, LEDGER_PATH, LedgerVetoedError } from '@cubicle/core';

/**
 * `ledger.record`: how the company writes in its own book.
 *
 * Two kinds, never three. **An agent may not record `capital`** — an agent that could fund itself could fund
 * itself out of the dormancy it was supposed to report, and the one honest signal the owner has about whether
 * this thing is worth paying for would be gone. Capital is a row the owner types.
 *
 * Bounded, too: a single entry over `MAX_AGENT_ENTRY_CENTS` is refused and sent to the owner as a proposal. The
 * book is append-only, so a wrong row cannot be quietly deleted — it has to be cancelled by a second row that
 * says it was wrong, in front of the owner. That is the right trade for small amounts and the wrong one for
 * large ones.
 */

/** The most one agent-written entry may be: above this the owner is asked instead. */
export const MAX_AGENT_ENTRY_CENTS = 100_000;

/** A `why` has to be a sentence someone could check. One word is not a reason. */
const MIN_WHY_CHARS = 12;

/**
 * The daemon's own key space. `accrueModelCosts` books each day's paid-model spend under `model-<date>` and
 * reads the book back to decide which days it has already charged, so one agent row sitting under that key
 * would make `appendEntry` answer "already there", the walk advance past that day and a real cost be absent
 * from the book for ever — the one failure spec §1 exists to prevent, reached through a documented format.
 * Refused by name here rather than defended by the namespacing below alone, so the agent is told why.
 */
const RESERVED_REF = /^model-/i;

/**
 * The idempotency key actually stored: the agent's ref **and the kind**.
 *
 * `appendEntry` dedups on `ref` alone, which is right for a book with one key — and too coarse for the caller
 * this tool describes. A job that records two real movements, a revenue and the cost of servicing it (the
 * ordinary shape of a sale), followed the instruction to pass the job id, and lost the second row to a handler
 * that cheerfully answered "already in the book". One row per kind per ref: a replay of either is still
 * idempotent, and neither can eat the other.
 */
const refKey = (ref: string, kind: string): string => (ref.trim() ? `${ref.trim()}:${kind}` : '');

export const ledgerRecord = defineTool({
  name: 'ledger.record',
  description: `Record one movement of money in ${LEDGER_PATH}: revenue the company took in, or a cost it paid. The book is append-only — to correct a mistake, record the opposite entry and say so in \`why\`. You cannot record capital; only the owner puts money in. Set \`mode: mock\` for anything simulated (a mock payment link, a mock service charge): it is reported separately and never counted as cash.`,
  schema: {
    // `capital` is listed and then refused in the handler, deliberately: a model that reaches for it gets a
    // sentence telling it who may add capital, instead of a zod enum error it cannot act on.
    kind: z.enum(['revenue', 'cost', 'capital']).describe('revenue = money came in; cost = money went out; capital is the owner\'s alone and is refused here'),
    amount: z.string().describe('a positive amount with at most two decimal places, e.g. "40.00". The currency is the ledger\'s own.'),
    mode: z.enum(['live', 'mock']).describe('live = real money really moved; mock = a simulation, never counted as cash'),
    why: z.string().describe('one sentence: what this was, and what it was for. An entry nobody can explain is an entry nobody can check.'),
    ref: z.string().default('').describe('an idempotency key — usually the job id — so a retried job does not record the same movement twice. One row per kind per ref: the same job may record a revenue and a cost with its id, and recording the same kind again under it changes nothing. Refs beginning "model-" belong to the daemon.'),
  },
  async handler({ kind, amount, mode, why, ref }, ctx) {
    if (kind === 'capital') {
      return { ok: false, text: `ledger.record cannot record capital: only the owner puts money into the company, by adding a row to ${LEDGER_PATH} themselves. If the company needs money, say so with proposal.create and let them decide.` };
    }
    const before = readLedger(ctx.vault);
    const cents = parseMoney(amount, before.currency);
    if (cents === null || cents <= 0) {
      return { ok: false, text: `"${amount}" is not an amount. Give a positive number with at most two decimal places, e.g. "40.00" — the kind carries the sign, so never write a negative, and never write zero.` };
    }
    if (cents > MAX_AGENT_ENTRY_CENTS) {
      return { ok: false, text: `${money(cents, before.currency)} is more than one entry may record (${money(MAX_AGENT_ENTRY_CENTS, before.currency)}). The book is append-only, so a wrong row this size cannot be quietly fixed: file it with proposal.create as a spend for the owner to approve instead.` };
    }
    if (why.trim().length < MIN_WHY_CHARS) {
      return { ok: false, text: `\`why\` has to be one sentence someone could check later — what this was and what it was for. "${why.trim()}" is not.` };
    }
    if (RESERVED_REF.test(ref.trim())) {
      return { ok: false, text: `"${ref.trim()}" is reserved: refs beginning "model-" belong to the daemon's daily model-cost accrual, and one row of yours under that key would make it skip a day's real spend for good. Use the job id, or leave ref empty.` };
    }
    let r;
    try {
      r = appendEntry(ctx.vault, { kind, cents, mode, who: ctx.roleId, why: why.trim(), ref: refKey(ref, kind) }, ctx.roleId);
    } catch (err) {
      if (err instanceof LedgerVetoedError) return { ok: false, text: err.message };
      throw err;
    }
    const after = moneyReport(readLedger(ctx.vault), ctx.now());
    if (!r.added) {
      return { ok: true, text: `already in the book: ${r.entry.kind} ${money(r.entry.cents, before.currency)} on ${r.entry.at.slice(0, 10)} (ref ${ref.trim()}, kind ${kind}). Nothing was recorded twice.`, data: { added: false, cash_cents: after.cashCents } };
    }
    const note = mode === 'mock' ? ' This is simulated, so it is not cash and does not change the runway.' : '';
    return {
      ok: true,
      text: `Recorded: ${kind} ${money(cents, after.currency)} (${mode}).${note} Cash is now ${money(after.cashCents, after.currency)}${after.runwayDays === null ? ', with nothing being spent' : `, ${after.runwayDays} days of runway`}.`,
      data: { added: true, cents, kind, mode, cash_cents: after.cashCents, runway_days: after.runwayDays },
    };
  },
});
