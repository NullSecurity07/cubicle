import {
  type Vault, type Org, type MoneyReport, type LedgerEntry, type DivisionWeight,
  readLedger, moneyReport, appendEntry, allocateQuota, runwayNote, money,
  HOUSE, LEDGER_PATH, RUNWAY_PATH,
  createJob, readJob, listJobs, listInbox, jobPath, idFromKey,
  officeHolder, teamOf, divisionOf, divisionTeams, subtreeRoles, createProposal, findInboxById, resultBlock,
} from '@cubicle/core';
import { shadowCost, hasPrices, type ModelBudget, type ProvidersFile, type RecordedCall } from '@cubicle/router';

/**
 * The daemon's side of the money: everything deterministic, and not one model call anywhere in this file.
 *
 * Three jobs. It turns `config/providers.yaml` into a day's free-call capacity and splits it between the
 * divisions. It regenerates `Ledger/runway.md` from the book, folding in the one section the CFO writes. And it
 * notices when the company has spent what the owner gave it, tells them once, and notices again when they put
 * more in.
 *
 * Nothing here caches a money fact. Every figure is derived from `Ledger/ledger.md` and the event log on the
 * call that needs it, so losing the heartbeat's state file changes no number and silences no message.
 */

const DAY_MS = 86_400_000;

/**
 * The tiers the division quota counts. `cheap` is the floor a division drops to and `local` is free: budgeting
 * either would make "a division past its quota never stops" untrue, and they are also the two tiers that are
 * not actually scarce (14 400 cheap calls a day against 560 strong ones).
 */
export const BUDGETED_TIERS: readonly string[] = ['strong', 'medium'];

/** Midnight UTC — the window the quota is measured in, matching the providers' own `rpd`. */
export function dayStartIso(now: Date): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Free calls a day at the scarce tiers, across enabled cloud providers. A priced model contributes nothing —
 * paid capacity is not free capacity — and an account-wide `rpd` caps its own models' sum (OpenRouter's four
 * medium models declare 50 each but the account allows 50 in total).
 */
export function freeCallCapacity(cfg: ProvidersFile): number {
  let total = 0;
  for (const p of cfg.providers) {
    if (!p.enabled || p.privacy === 'local') continue;
    const perModel = p.models
      .filter((m) => m.enabled && BUDGETED_TIERS.includes(m.tier) && !m.price)
      .reduce((t, m) => t + m.limits.rpd, 0);
    if (perModel === 0) continue;
    total += p.limits?.rpd ? Math.min(p.limits.rpd, perModel) : perModel;
  }
  return total;
}

/** A division's weight is the people actually in it: a thirteen-desk division needs more calls than a three-desk one. */
export function divisionWeights(org: Org): DivisionWeight[] {
  return divisionTeams(org).map((t) => ({ id: t.id, people: subtreeRoles(org, t.id).filter((r) => org.roles[r]).length }));
}

/**
 * The day's allocation. Recomputed, never cached: it is a pure function of the capacity and the roster, both of
 * which change only when the owner edits a file, so a cache would buy nothing and could go stale.
 */
export function divisionQuotas(cfg: ProvidersFile, org: Org): Record<string, number> {
  return allocateQuota(freeCallCapacity(cfg), divisionWeights(org));
}

/** Which division a role's calls are charged to. Anything that does not resolve is the house's. */
export function divisionOfRole(org: Org, role: string | null | undefined, known: ReadonlySet<string>): string {
  if (!role) return HOUSE;
  const div = divisionOf(org, teamOf(org, role)?.id);
  return div && known.has(div) ? div : HOUSE;
}

/**
 * Calls at the scarce tiers since `since`, per division, read straight out of the event log. No new table and
 * no new column: `router.call` already carries the agent and the tier, and the log survives a restart, so the
 * gauge cannot drift away from what actually happened.
 */
export function divisionSpend(vault: Vault, org: Org, since: string): Record<string, number> {
  const known = new Set(divisionTeams(org).map((t) => t.id));
  const out: Record<string, number> = { [HOUSE]: 0 };
  for (const id of known) out[id] = 0;
  for (const e of vault.events.query({ types: ['router.call'], from: since })) {
    if (!BUDGETED_TIERS.includes(String((e.payload as { tier?: unknown }).tier ?? ''))) continue;
    const key = divisionOfRole(org, e.agent, known);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export interface BudgetRow { division: string; used: number; quota: number }

/** Every division's gauge for the bank screen and the runway note, divisions first and the house last. */
export function budgetRows(vault: Vault, org: Org, cfg: ProvidersFile, now: Date): BudgetRow[] {
  const quotas = divisionQuotas(cfg, org);
  const used = divisionSpend(vault, org, dayStartIso(now));
  return Object.keys(quotas)
    .sort((a, b) => (a === HOUSE ? 1 : b === HOUSE ? -1 : a.localeCompare(b)))
    .map((division) => ({ division, used: used[division] ?? 0, quota: quotas[division] ?? 0 }));
}

/**
 * The budget one role's calls run against. Read once per job by the harness, not per call: demoting a job's
 * tier halfway through a piece of work makes the output incoherent and the event log unreadable.
 *
 * The return shape is the router's `ModelBudget` (`{ used, quota }`), which is what `budgetedTier` reads.
 */
export function budgetForRole(vault: Vault, org: Org, cfg: ProvidersFile, role: string, now: Date): ModelBudget {
  const quotas = divisionQuotas(cfg, org);
  const known = new Set(Object.keys(quotas).filter((k) => k !== HOUSE));
  const key = divisionOfRole(org, role, known);
  return { used: divisionSpend(vault, org, dayStartIso(now))[key] ?? 0, quota: quotas[key] ?? 0 };
}

/** `router.call` events in a window, in the shape `shadowCost` prices. */
export function recordedCalls(vault: Vault, from: string, to?: string): RecordedCall[] {
  return vault.events.query({ types: ['router.call'], from, to }).map((e) => {
    const p = e.payload as { provider?: unknown; model?: unknown; tokens?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    return {
      provider: String(p.provider ?? ''), model: String(p.model ?? ''),
      prompt_tokens: Number(p.tokens?.prompt_tokens ?? 0), completion_tokens: Number(p.tokens?.completion_tokens ?? 0),
    };
  });
}

// ---------- the daily runway job ----------

export function runwayJobId(date: string): string { return idFromKey('job', `runway-${date}`); }

/**
 * The CFO's brief. Every figure is **in the goal**, because the job's one output is an opinion and a job that
 * has to derive a number first is a job that will eventually derive the wrong one.
 */
export function runwayGoal(r: MoneyReport): string {
  return [
    `Read the company's position and say what you make of it. The numbers are below and in ${RUNWAY_PATH}; they are already computed, so do not recalculate anything and do not invent a figure that is not here.`,
    '',
    `- Cash: ${money(r.cashCents, r.currency)}`,
    `- Burn: ${money(r.burnCentsPerDay, r.currency)} a day (${money(r.windowOutCents, r.currency)} over ${r.windowDays} day${r.windowDays === 1 ? '' : 's'})`,
    `- Runway: ${r.runwayDays === null ? 'not spending — nothing has cost the company anything' : `${r.runwayDays} day${r.runwayDays === 1 ? '' : 's'}`}`,
    r.mockRevenueCents > 0 ? `- Simulated revenue: ${money(r.mockRevenueCents, r.currency)} — not cash, nobody paid it` : '',
    r.problems.length ? `- ${r.problems.length} row(s) in ${LEDGER_PATH} do not parse; say so` : '',
    '',
    `Do: (1) \`vault.read\` ${RUNWAY_PATH} for the model quota per division and what a paid tier would have cost; (2) \`vault.read\` ${LEDGER_PATH} if you need the detail behind a figure; (3) finish with **at most five lines**, each one about a number above and what you would do about it.`,
    '',
    'Your summary is the only part of the runway page a person writes — it is folded in verbatim under "What the CFO makes of it". Say the thing the owner would want to know and nothing else; do not restate a figure as if you had calculated it, and do not propose a spend nobody asked for.',
  ].filter(Boolean).join('\n');
}

/**
 * One runway job a calendar day, whatever the cycle count — the day floor `maybeEnqueueIntelligence` uses, for
 * the same reason: the heartbeat fires every 6 h or every N completions, and four cheap-tier jobs a day
 * restating arithmetic that has not changed is a waste of the free pool.
 */
export function enqueueRunway(vault: Vault, org: Org, now: Date = new Date()): string | null {
  const date = now.toISOString().slice(0, 10);
  const id = runwayJobId(date);
  if (vault.exists(jobPath(id))) return null;
  const finance = officeHolder(org, 'finance');
  if (!org.roles[finance]) return null;
  const r = moneyReport(readLedger(vault), now);
  return createJob(vault, {
    id, type: 'finance.runway', title: `Runway: ${date}`,
    assigned: finance, owner_role: finance, for: officeHolder(org, 'chief_executive'),
    team: teamOf(org, finance)?.id, priority: 3, model_tier: 'cheap',
    goal: runwayGoal(r),
    done_when: `A summary of at most five lines, each about a figure already in ${RUNWAY_PATH}. It becomes the note's "What the CFO makes of it" section verbatim.`,
  }, 'daemon');
}

/**
 * The CFO's own words, from the newest finished runway job's Result summary. This is the **only** part of the
 * runway note an agent contributes, and it arrives through the finish contract rather than through a write, so
 * no model can put a number of its own on that page or clobber the figures when the note is regenerated.
 */
export function runwayCommentary(vault: Vault): string {
  const last = listJobs(vault)
    .filter((j) => j.type === 'finance.runway' && j.status === 'done')
    .sort((a, b) => a.updated.localeCompare(b.updated))
    .at(-1);
  if (!last) return '';
  // `resultBlock` reads the **last** heading-anchored `## Result` fence, so the empty one `createJob` writes
  // into every new job body cannot be mistaken for the finished one, and no text the goal happens to contain
  // can forge a summary on to the owner's bank page.
  const summary = resultBlock(readJob(vault, last.id)?.body ?? '').summary;
  return typeof summary === 'string' ? summary.trim().split('\n').slice(0, 5).join('\n') : '';
}

/** Regenerate `Ledger/runway.md` from the book. Returns the report, so the caller does not read it twice. */
export function writeRunway(vault: Vault, org: Org, cfg: ProvidersFile, now: Date = new Date()): MoneyReport {
  const report = moneyReport(readLedger(vault), now);
  const calls = recordedCalls(vault, dayStartIso(now));
  const shadow = shadowCost(cfg, calls);
  vault.writeText(RUNWAY_PATH, runwayNote(report, {
    calls: calls.length, paidCalls: shadow.paidCalls, shadowCents: shadow.cents, priced: hasPrices(cfg),
    quotas: budgetRows(vault, org, cfg, now), commentary: runwayCommentary(vault), generatedAt: now.toISOString(),
  }), 'daemon', { generated: true });
  return report;
}

// ---------- what the models cost ----------

/**
 * How far back the **first** accrual looks when the book has no `model-<date>` row to continue from. A fresh
 * install has no history worth charging, and an unbounded first walk would scan the whole event log.
 */
export const ACCRUAL_LOOKBACK_DAYS = 30;
/** The hard stop on a continued walk, so a book with an ancient accrual row cannot turn a cycle into a crawl. */
export const MAX_ACCRUAL_DAYS = 370;

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const nextDay = (date: string): string => dayOf(Date.parse(`${date}T00:00:00.000Z`) + DAY_MS);

/** The date every `model-<date>` accrual row in the book is for, oldest first. */
function accruedDays(vault: Vault): string[] {
  return readLedger(vault).entries
    .map((e) => /^model-(\d{4}-\d{2}-\d{2})$/.exec(e.ref)?.[1])
    .filter((d): d is string => typeof d === 'string')
    .sort();
}

/**
 * Every uncharged calendar day's paid-model spend, one `cost` row each, oldest first.
 *
 * It **walks the days** rather than charging only yesterday: a daemon that was off for a week owes the company
 * a row for each of those days, and a book whose whole point is that money cannot vanish must not lose six of
 * them to a restart. The walk starts the day after the newest `model-<date>` row in the book, so it continues
 * from where the last run stopped no matter how long ago that was, and it stops at yesterday — today is not
 * over, and charging a part-day would make the same day's second charge a duplicate.
 *
 * Each row's `ref` is its own date, so `appendEntry` refuses a second one: a replayed cycle, an overlapping
 * walk and a rebuilt event log all find the row already there instead of charging the company twice.
 *
 * On free tiers this writes **nothing** — a row of 0.00 every day would be noise dressed up as bookkeeping, and
 * the runway note already says in words that everything was free. A providers file with no `price:` anywhere
 * cannot produce a charge at all, so it returns before touching the log.
 */
export function accrueModelCosts(vault: Vault, cfg: ProvidersFile, now: Date = new Date()): LedgerEntry[] {
  if (!hasPrices(cfg)) return [];
  const yesterday = dayOf(now.getTime() - DAY_MS);
  const floor = dayOf(now.getTime() - MAX_ACCRUAL_DAYS * DAY_MS);
  const last = accruedDays(vault).at(-1) ?? null;
  let day = last ? nextDay(last) : dayOf(now.getTime() - ACCRUAL_LOOKBACK_DAYS * DAY_MS);
  if (day < floor) day = floor;
  const out: LedgerEntry[] = [];
  for (; day <= yesterday; day = nextDay(day)) {
    const to = `${day}T23:59:59.999Z`;
    const cost = shadowCost(cfg, recordedCalls(vault, `${day}T00:00:00.000Z`, to));
    if (cost.cents <= 0) continue;
    const r = appendEntry(vault, {
      at: to, kind: 'cost', cents: cost.cents, mode: 'live', who: 'daemon',
      why: `${cost.paidCalls} model call${cost.paidCalls === 1 ? '' : 's'} on priced models, ${day}`,
      ref: `model-${day}`,
    }, 'daemon');
    if (r.added) out.push(r.entry);
  }
  return out;
}

/**
 * The newest row `accrueModelCosts` wrote, or null when there was nothing to charge. The heartbeat reports one
 * figure per cycle; the full list is there for anyone who needs every day the walk caught up on.
 */
export function accrueModelCost(vault: Vault, cfg: ProvidersFile, now: Date = new Date()): LedgerEntry | null {
  return accrueModelCosts(vault, cfg, now).at(-1) ?? null;
}

// ---------- the two messages ----------

export function moneyMessageId(kind: 'dormant' | 'revived', mark: string): string {
  return idFromKey('prop', `money:${kind}:${mark}`);
}

/** Inbox notes this module stamped, by kind. `money` and `mark` ride on the note's frontmatter (looseObject). */
function moneyNotes(vault: Vault, kind: 'dormant' | 'revived'): { id: string; mark: string }[] {
  return listInbox(vault)
    .filter((n) => (n.data as { money?: unknown }).money === kind)
    .map((n) => ({ id: n.data.id, mark: String((n.data as { mark?: unknown }).mark ?? '') }));
}

/**
 * `createProposal` builds the note from a fixed field set, so the two extra fields go on in a second write —
 * and a crash between the two must not be able to silence the revival. Every path that finds the note by its
 * deterministic id re-stamps it first: the id says the message was sent, the frontmatter says which dormancy
 * it was about, and a note that has the one without the other is repaired rather than left to strand the
 * company in a dormancy it can never announce its way out of.
 */
function stamp(vault: Vault, rel: string, kind: 'dormant' | 'revived', mark: string): void {
  const note = vault.readNoteOrNull(rel);
  const data = (note?.data ?? {}) as { money?: unknown; mark?: unknown };
  if (data.money === kind && String(data.mark ?? '') === mark) return;
  vault.updateNote(rel, (n) => ({ data: { ...n.data, money: kind, mark }, body: n.body }), 'daemon');
}

/**
 * The CEO's last message before the company stops. Written once per dormancy — keyed on when real money last
 * moved, which cannot change while nothing is being spent — and it answers the two questions an owner will
 * actually have: where did it go, and how do I start it again.
 */
export function dormancyMessage(vault: Vault, org: Org, r: MoneyReport, now: Date = new Date()): string | null {
  if (!r.dormant) return null;
  const mark = r.lastLiveAt ?? 'none';
  const id = moneyMessageId('dormant', mark);
  const already = findInboxById(vault, id);
  if (already) { stamp(vault, already.path, 'dormant', mark); return null; }
  const ceo = officeHolder(org, 'chief_executive');
  const { path: rel } = createProposal(vault, {
    id, kind: 'message', from: ceo, to: 'owner',
    title: 'We have run out of money',
    body: [
      `Cash is ${money(r.cashCents, r.currency)}, so I have stopped the company. Nothing is queued, nobody is working, and no model call is being made — only the heartbeat is still running, so that I notice when this changes.`,
      '',
      `You put in ${money(r.inCents, r.currency)} and we spent ${money(r.outCents, r.currency)} of it. ${LEDGER_PATH} has every row, with who recorded it and why.`,
      r.mockRevenueCents > 0 ? `\nWe also recorded ${money(r.mockRevenueCents, r.currency)} of simulated revenue. It is not money — nobody paid it — and it has never counted towards cash.` : '',
      '',
      `**To start us again**, add a row to \`${LEDGER_PATH}\`:`,
      '',
      '```',
      `| ${now.toISOString()} | capital | 100.00 | live | owner | Topping the company up | |`,
      '```',
      '',
      'I will pick it up on the next tick and tell you we are back. Nothing else is needed, and nothing needs approving.',
    ].filter(Boolean).join('\n'),
  }, ceo);
  stamp(vault, rel, 'dormant', mark);
  return id;
}

/**
 * The other half: said once, when a dormancy the owner was told about has been answered with capital. Keyed on
 * the same mark, so it is the reply to *that* message rather than a fresh announcement every cycle.
 */
export function revivalMessage(vault: Vault, org: Org, r: MoneyReport, now: Date = new Date()): string | null {
  if (r.dormant || r.cashCents <= 0) return null;
  const revived = new Set(moneyNotes(vault, 'revived').map((n) => n.mark));
  const open = moneyNotes(vault, 'dormant').map((n) => n.mark).filter((m) => !revived.has(m));
  if (!open.length) return null;
  const mark = open[open.length - 1];
  const id = moneyMessageId('revived', mark);
  const already = findInboxById(vault, id);
  if (already) { stamp(vault, already.path, 'revived', mark); return null; }
  const ceo = officeHolder(org, 'chief_executive');
  const { path: rel } = createProposal(vault, {
    id, kind: 'message', from: ceo, to: 'owner',
    title: 'Back to work',
    body: [
      `Thank you — cash is ${money(r.cashCents, r.currency)} and the company is running again. The divisions plan on the next cycle.`,
      '',
      r.burnCentsPerDay > 0
        ? `At ${money(r.burnCentsPerDay, r.currency)} a day that is ${r.runwayDays} day${r.runwayDays === 1 ? '' : 's'}. I will say something well before it runs low.`
        : 'Nothing is costing us anything at the moment — every model we use is on a free tier — so this should last until something changes.',
    ].join('\n'),
  }, ceo);
  stamp(vault, rel, 'revived', mark);
  return id;
}
