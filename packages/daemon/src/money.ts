import {
  type Vault, type Org, type MoneyReport, type LedgerEntry, type DivisionWeight,
  readLedger, moneyReport, appendEntry, allocateQuota, runwayNote, money,
  HOUSE, LEDGER_PATH, RUNWAY_PATH,
  createJob, readJob, listJobs, listInbox, jobPath, idFromKey,
  officeHolder, teamOf, divisionOf, divisionTeams, subtreeRoles, createProposal, findInboxById, resultBlock,
  LedgerVetoedError, isNeverModifyPath, atomicWriteSync,
} from '@cubicle/core';
import { shadowCost, hasPrices, type ModelBudget, type ProvidersFile, type RecordedCall } from '@cubicle/router';
import { readFileSync, rmSync } from 'node:fs';

/**
 * The daemon's side of the money: everything deterministic, and not one model call anywhere in this file.
 *
 * Three jobs. It turns `config/providers.yaml` into a day's free-call capacity and splits it between the
 * divisions. It regenerates `Ledger/runway.md` from the book, folding in the one section the CFO writes. And it
 * notices when the company has spent what the owner gave it, tells them once, and notices again when they put
 * more in.
 *
 * Nothing here caches a money fact. Every figure is derived from `Ledger/ledger.md` and the event log on the
 * call that needs it, so losing the heartbeat's state file changes no number and silences no message. The one
 * thing this module does remember between cycles is which of its own complaints it has already made
 * (`LOCK_STATE_PATH`); deleting that file costs one repeated sentence per standing complaint and nothing at
 * all besides.
 *
 * One consequence of that, worth stating where it will be read: both halves of the division gauge are decided
 * by `config/providers.yaml` **as it stands now**, so editing a model mid-day changes what today's already
 * recorded calls on it count for. **Renaming** one leaves `quota` exactly where it was — the new id carries
 * the same `limits.rpd` — while its calls stop being counted, so the affected divisions get more headroom
 * than the day's pool really has. **Deleting** one moves both halves against each other: the capacity it
 * contributed goes too, and whether a division ends up ahead depends on how much of its day ran on that
 * model. Either way it corrects itself at the next UTC midnight, because the window only ever covers today.
 * The alternative — counting calls against an allowance the file no longer offers — rations a division for a
 * model it cannot use, which is the worse of the two.
 */

const DAY_MS = 86_400_000;

/**
 * The tiers the division quota counts. `cheap` is the floor a division drops to and `local` is free: budgeting
 * either would make "a division past its quota never stops" untrue, and they are also the two tiers that are
 * not actually scarce (14 400 cheap calls a day against 560 strong ones).
 */
export const BUDGETED_TIERS: readonly string[] = ['strong', 'medium'];

/**
 * Midnight **UTC** — one company-wide window, chosen deliberately *over* each provider's own `day_reset_tz`
 * (gemini declares `America/Los_Angeles`, so its real `rpd` day and this one are about seven hours apart).
 * A budget day that moved with whichever provider a call happened to land on would make the divisions'
 * gauges incomparable and the runway note's table meaningless. The providers' actual resets are tracked
 * where they matter — `router/quota.ts` counts each provider's day in its own zone — and this window only
 * rations how much of the free pool a division may spend before it drops to the cheap tier.
 */
export function dayStartIso(now: Date): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * The models one provider contributes to the free pool: enabled, at a scarce tier, and unpriced. A priced
 * model is excluded because paid capacity is not free capacity — and `drawsOnFreePool` excludes its calls
 * from the usage side for the same reason, so the two halves of `used / quota` always agree on the pool.
 */
function pooledModels(p: ProvidersFile['providers'][number]): ProvidersFile['providers'][number]['models'] {
  return p.models.filter((m) => m.enabled && BUDGETED_TIERS.includes(m.tier) && !m.price);
}

/**
 * Free calls a day at the scarce tiers, across enabled cloud providers.
 *
 * The decision is **per model**, never per provider. `rpd: 0` is `ModelLimits`' default and means *no declared
 * daily limit* — `quota.ts` guards on `if (L.rpd && …)`, `metrics.ts` renders `∞`, and the shipped file's own
 * header says "0 = unlimited/unknown" — so such a model is not summed as zero capacity, and it is not summed
 * as an invented one either: it contributes nothing, and `drawsOnFreePool` leaves its calls out of the spend
 * side to match. Its *siblings* are untouched. One model whose daily limit the owner has not looked up must
 * not delete the capacity of the four beside it that declare one, while their calls keep raising `used` —
 * that is the same asymmetry one level up.
 *
 * An account-wide `rpd` caps the sum of that provider's finite models (OpenRouter's four medium models declare
 * 50 each but the account allows 50 in total), and is itself the capacity when the provider's only budgeted
 * models are unlimited — there the account figure is the real ration, so those calls do draw on the pool.
 */
export function freeCallCapacity(cfg: ProvidersFile): number {
  let total = 0;
  for (const p of cfg.providers) {
    if (!p.enabled || p.privacy === 'local') continue;
    const pooled = pooledModels(p);
    if (!pooled.length) continue;
    const account = p.limits?.rpd ?? 0;
    const declared = pooled.reduce((t, m) => t + m.limits.rpd, 0);
    const unlimited = pooled.some((m) => !m.limits.rpd);
    if (account) { total += unlimited ? account : Math.min(account, declared); continue; }
    total += declared;
  }
  return total;
}

/**
 * Whether one recorded call drew on the pool `freeCallCapacity` measures — the question `divisionSpend` has
 * to answer the same way, model for model, or `used` and `quota` count different things and every division
 * demotes to the cheap tier sooner than it should.
 *
 * Without a providers file there is nothing to check against and the call counts, which is what this module
 * did before. With one, the answer is `pooledModels`' answer read back for a single model, so the two can
 * never drift: the call is in the pool when its provider is enabled and not local, and its model is enabled,
 * unpriced, at a **budgeted tier as the file describes it today**, and bounded by a daily limit of its own or
 * an account cap above it.
 *
 * The tier comes from the config and not from the recorded call, so re-tiering a model moves it on both sides
 * at once: demote a `strong` model to `cheap` and today's calls on it stop raising `used` in the same breath
 * as it stops raising `quota`. And a provider or model the file no longer describes counts on **neither**
 * side — it contributes no capacity, so counting its calls would ration a division against an allowance that
 * does not exist.
 */
export function drawsOnFreePool(cfg: ProvidersFile | null | undefined, provider: string, model: string): boolean {
  if (!cfg) return true;
  const p = cfg.providers.find((x) => x.id === provider);
  if (!p || !p.enabled || p.privacy === 'local') return false;
  const m = p.models.find((x) => x.id === model);
  if (!m || !m.enabled || m.price) return false;
  if (!BUDGETED_TIERS.includes(m.tier)) return false;
  return Boolean(m.limits.rpd || p.limits?.rpd);
}

/** `where` values only `warnOnce` ever writes, so no other failure can be mistaken for one of these notices. */
export const LOCKED_RUNWAY = 'money.runway.locked';
export const LOCKED_ACCRUAL = 'money.accrual.locked';
/** The owner's `prices_verified`/`verified` stamp is dated in the future — said once per distinct stamp value. */
export const STAMP_AHEAD = 'money.accrual.stamp';
/** Said once, if this module's own memory of what it has said cannot be written. */
export const NOTICES_UNWRITABLE = 'money.notices.unwritable';

/**
 * Everything this module has already said, so it does not say it again next cycle: `where` → the situation it
 * was said about. It is the **only** memory there is — there is no second store to fall out of step with — and
 * it is a cache under `.cubicle/`, not a note. Losing it costs one repeated notice per standing situation and
 * nothing else: no figure is derived from it, and a repeated sentence is the safe direction for a file whose
 * whole job is to stop a sentence being repeated.
 */
export const LOCK_STATE_PATH = '.cubicle/money-notices.json';

/**
 * Where the memory goes when `.cubicle/` cannot be written — a read-only mount, a permissions accident.
 * Per-vault and for this process only: the notices stay deduped for as long as the daemon runs, and a restart
 * costs exactly one repeat of each situation still standing at that moment. Keyed weakly so a test's vault is
 * collected with it.
 */
const inProcessNotices = new WeakMap<Vault, Record<string, string>>();

function noticeState(vault: Vault): Record<string, string> {
  const held = inProcessNotices.get(vault);
  if (held) return { ...held };
  try {
    const v: unknown = JSON.parse(readFileSync(vault.abs(LOCK_STATE_PATH), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch { return {}; }
}

function saveNoticeState(vault: Vault, state: Record<string, string>): void {
  if (inProcessNotices.has(vault)) { inProcessNotices.set(vault, state); return; }
  const abs = vault.abs(LOCK_STATE_PATH);
  try {
    // Nothing to remember is no file: a vault that has never had a notice held back should not acquire one,
    // and "this file exists" should keep meaning "something is being suppressed".
    if (Object.keys(state).length === 0) { rmSync(abs, { force: true }); return; }
    atomicWriteSync(abs, JSON.stringify(state, null, 2));   // creates `.cubicle/` itself
  } catch {
    inProcessNotices.set(vault, state);
    vault.events.emit({ type: 'daemon.warning', payload: {
      where: NOTICES_UNWRITABLE,
      path: LOCK_STATE_PATH,
      reason: `${LOCK_STATE_PATH} cannot be written, so what has already been said is remembered in this process only; every notice still standing is repeated once after a restart`,
    } });
  }
}

/** Forget a notice, so the next time the situation arises it is said again. */
function clearNotice(vault: Vault, where: string): void {
  const state = noticeState(vault);
  if (state[where] === undefined) return;   // nothing remembered; do not create a file to say so
  delete state[where];
  saveNoticeState(vault, state);
}

/**
 * The situation a lock notice is about: **this path is locked**, and nothing more.
 *
 * Semantic, not textual. Whether `Ledger/runway.md` is covered by the owner's `never_modify` list is a
 * yes-or-no question that `isNeverModifyPath` already answers, and everything else about the list is spelling:
 * which entry covers it, how many do, what order they are in, whether `Ledger/` is written `./Ledger/` or
 * `Ledger//`, whether a redundant second entry was tidied away, whether the daemon appended `Teams/` on
 * upgrade. None of that changes the answer, so none of it is news, and earlier keys that carried the entries
 * themselves said the same sentence again for every one of those edits.
 *
 * It is also not the file's own sha. `never_modify: [Ledger/]` exists precisely so the owner can keep their
 * own `Ledger/runway.md` by hand; editing it is the expected workflow, not an event.
 *
 * A key this stable is only half the mechanism. `clearNotice` is the other half: a cycle that finds the path
 * writable forgets the notice, so lock → unlock → lock again is two notices rather than one. It takes a cycle
 * to *observe* the gap — an unlock and a re-lock between two heartbeats is a gap nothing saw, and nothing is
 * said.
 */
export function lockSituation(rel: string): string {
  return `locked:${rel}`;
}

/**
 * Say something on the event log once per *situation* — not once a cycle, and not on a timer either.
 *
 * A heartbeat fires every six hours or every N completions, so an owner who locks `Ledger/` and leaves it
 * locked would otherwise collect two `daemon.warning` rows a cycle about a decision they made on purpose and
 * have not changed. Nothing dedupes `daemon.warning`, and a log full of the same row is a log nobody reads.
 *
 * The **situation** is the caller's, not this function's, and it is deliberately not the message text: the
 * lock notices key on whether the path is locked (`lockSituation`), the accrual's adds the day range so a lock
 * that outlives a day says so once a day with the new one, and the future-stamp notice keys on the stamp
 * string alone so the sentence may name today's clamp target without turning a standing typo into a row a day.
 * Split key from text, and each notice repeats when its own subject changes and at no other time.
 *
 * The `where` values belong to this function alone, never a step name another emitter shares — a
 * `money.runway` row logged when `writeRunway` *throws* must not be able to pass for "I already told them the
 * page is locked" and silence the notice for good.
 */
function warnOnce(vault: Vault, where: string, situation: string, extra: Record<string, unknown>): void {
  const state = noticeState(vault);
  if (state[where] === situation) return;
  vault.events.emit({ type: 'daemon.warning', payload: { where, ...extra } });
  state[where] = situation;
  saveNoticeState(vault, state);
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
 * Calls on the free pool since `since`, per division, read straight out of the event log. No new table and
 * no new column: `router.call` already carries the agent, the tier and the model, and the log survives a
 * restart, so the gauge cannot drift away from what actually happened.
 *
 * `cfg` is optional only because a caller without a providers file (a test, a daemon whose router failed to
 * start) should still get a tier-count rather than nothing. Every caller that has one passes it, and with it
 * the count is exactly the calls `freeCallCapacity` budgeted for — `drawsOnFreePool` answers both questions
 * from the same file, so a model the owner re-tiers, prices or switches off moves on both sides together.
 */
export function divisionSpend(vault: Vault, org: Org, since: string, cfg?: ProvidersFile | null): Record<string, number> {
  const known = new Set(divisionTeams(org).map((t) => t.id));
  const out: Record<string, number> = { [HOUSE]: 0 };
  for (const id of known) out[id] = 0;
  for (const e of vault.events.query({ types: ['router.call'], from: since })) {
    const p = e.payload as { tier?: unknown; provider?: unknown; model?: unknown };
    // With a providers file the file decides, tier included, so `used` and `quota` move together when the
    // owner re-tiers a model. Without one, the tier the call was recorded at is the only thing to go on.
    if (cfg) { if (!drawsOnFreePool(cfg, String(p.provider ?? ''), String(p.model ?? ''))) continue; }
    else if (!BUDGETED_TIERS.includes(String(p.tier ?? ''))) continue;
    const key = divisionOfRole(org, e.agent, known);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export interface BudgetRow { division: string; used: number; quota: number }

/** Every division's gauge for the bank screen and the runway note, divisions first and the house last. */
export function budgetRows(vault: Vault, org: Org, cfg: ProvidersFile, now: Date): BudgetRow[] {
  const quotas = divisionQuotas(cfg, org);
  const used = divisionSpend(vault, org, dayStartIso(now), cfg);
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
  return { used: divisionSpend(vault, org, dayStartIso(now), cfg)[key] ?? 0, quota: quotas[key] ?? 0 };
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

/**
 * Regenerate `Ledger/runway.md` from the book. Returns the report, so the caller does not read it twice.
 *
 * The owner's `never_modify` list covers this page too. `vault.writeText` would not stop it — `assertWritable`
 * returns immediately for the privileged `daemon` actor and never looks at that list — so the check is made
 * here, with core's own `isNeverModifyPath` rather than a second copy of the matching rules, and the note is
 * left exactly as the owner left it. The figures are still computed and still returned: the caller's brief
 * line, the dormancy check and the daily job all keep working on a company whose runway page is frozen. It is
 * a report, not the company.
 */
export function writeRunway(vault: Vault, org: Org, cfg: ProvidersFile, now: Date = new Date()): MoneyReport {
  const report = moneyReport(readLedger(vault), now);
  if (isNeverModifyPath(RUNWAY_PATH, vault.constitution().never_modify)) {
    warnOnce(vault, LOCKED_RUNWAY, lockSituation(RUNWAY_PATH), {
      path: RUNWAY_PATH,
      reason: `${RUNWAY_PATH} is on the owner's never_modify list, so it was not regenerated; the figures behind it are still computed every cycle`,
    });
    return report;
  }
  // Not locked: forget any notice about a lock that has been lifted, so putting it back is news again. It is
  // the *cycle observing the path is writable* that counts, not the write below — which may yet fail, and
  // whose failure is the safe direction anyway (the next locked cycle says the notice again).
  clearNotice(vault, LOCKED_RUNWAY);
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
 * How far back the **first** accrual looks when the book has no `model-<date>` row to continue from, and the
 * providers file carries no stamp saying when its prices were added. A fresh install has no history worth
 * charging, and an unbounded first walk would scan the whole event log.
 */
export const ACCRUAL_LOOKBACK_DAYS = 30;
/** The hard stop on a continued walk, so a book with an ancient accrual row cannot turn a cycle into a crawl. */
export const MAX_ACCRUAL_DAYS = 370;

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const nextDay = (date: string): string => dayOf(Date.parse(`${date}T00:00:00.000Z`) + DAY_MS);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Where the **first** accrual walk starts: the day the prices appeared, never a retroactive month.
 *
 * A free config never leaves a `model-<date>` row behind — there is nothing to charge — so the first run
 * after the owner adds a `price:` has nothing to continue from. Without this clamp it would walk
 * `ACCRUAL_LOOKBACK_DAYS` back and bill the company for calls the owner made believing they were free, which
 * is exactly the retroactive charge an append-only book is supposed to make impossible. `prices_verified` is
 * the stamp the owner sets beside the prices (`config/providers.yaml` documents it in the header comment);
 * `verified` is the file's own stamp and stands in when the more specific one is absent.
 *
 * A stamp in the **future** is clamped to yesterday and complained about. Left alone it would put the start of
 * the walk past its end, so the walk would never run, no `model-<date>` row would ever be written, and there
 * would be nothing to continue from next cycle either — a typo'd year would silently stop paid model cost ever
 * reaching the book. The book's rule is that an owner's typo surfaces as a complaint, never as money quietly
 * vanishing, so it says so on the event log and carries on.
 */
function firstAccrualDay(vault: Vault, cfg: ProvidersFile, now: Date): string {
  const lookback = dayOf(now.getTime() - ACCRUAL_LOOKBACK_DAYS * DAY_MS);
  const yesterday = dayOf(now.getTime() - DAY_MS);
  const stamp = String(cfg.prices_verified ?? cfg.verified ?? '').slice(0, 10);
  // A stamp that is fine again forgets the complaint about one that was not, so the same bad value coming
  // back — a revert, a restored backup, a bad merge — is said a second time rather than swallowed for ever.
  if (!DATE_RE.test(stamp) || stamp <= yesterday) { clearNotice(vault, STAMP_AHEAD); }
  if (!DATE_RE.test(stamp)) return lookback;
  if (stamp > yesterday) {
    // Once per distinct stamp value, not once a cycle and not once a day: this fires on every cycle for as
    // long as the typo stands (there is never a `model-<date>` row to continue from). The situation is the
    // **stamp** and nothing else — the sentence names today's clamp target, which slides at every UTC
    // midnight, and keying on that would turn one unchanged typo into a row a day.
    warnOnce(vault, STAMP_AHEAD, stamp, {
      stamp,
      reason: `the providers file's price stamp "${stamp}" is in the future; accruing model cost from ${yesterday} instead`,
    });
    return yesterday;
  }
  return stamp > lookback ? stamp : lookback;
}

/**
 * The owner's `never_modify` veto on the book, told apart from a real write failure. Matched by name as well
 * as by `instanceof`, so a duplicated module instance cannot turn their policy into a crash.
 */
const isVeto = (err: unknown): boolean => err instanceof LedgerVetoedError || (err as Error | null)?.name === 'LedgerVetoedError';

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
 * walk and a rebuilt event log all find the row already there instead of charging the company twice. The
 * **first** walk starts at `firstAccrualDay` — the day the prices were stamped — so adding a price today
 * cannot retroactively bill a month of calls the owner made believing they were free.
 *
 * On free tiers this writes **nothing** — a row of 0.00 every day would be noise dressed up as bookkeeping, and
 * the runway note already says in words that everything was free. A providers file with no `price:` anywhere
 * cannot produce a charge at all, so it returns before touching the log.
 *
 * And if the owner has put the book on their own `never_modify` list, this degrades to one warning rather than
 * throwing into the heartbeat: an owner who has locked their ledger has not asked the company to stop.
 */
export function accrueModelCosts(vault: Vault, cfg: ProvidersFile, now: Date = new Date()): LedgerEntry[] {
  // The book is writable: forget the lock notice, so putting the lock back is worth saying once more. This
  // runs whenever the step runs and needs no write of its own — an unlocked cycle with nothing to charge
  // writes nothing at all, and it must still count as having seen the lock go.
  if (!isNeverModifyPath(LEDGER_PATH, vault.constitution().never_modify)) clearNotice(vault, LOCKED_ACCRUAL);
  if (!hasPrices(cfg)) return [];
  const yesterday = dayOf(now.getTime() - DAY_MS);
  const floor = dayOf(now.getTime() - MAX_ACCRUAL_DAYS * DAY_MS);
  const last = accruedDays(vault).at(-1) ?? null;
  let day = last ? nextDay(last) : firstAccrualDay(vault, cfg, now);
  if (day < floor) day = floor;
  const out: LedgerEntry[] = [];
  for (; day <= yesterday; day = nextDay(day)) {
    const to = `${day}T23:59:59.999Z`;
    const cost = shadowCost(cfg, recordedCalls(vault, `${day}T00:00:00.000Z`, to));
    if (cost.cents <= 0) continue;
    let r: { entry: LedgerEntry; added: boolean };
    try {
      r = appendEntry(vault, {
        at: to, kind: 'cost', cents: cost.cents, mode: 'live', who: 'daemon',
        why: `${cost.paidCalls} model call${cost.paidCalls === 1 ? '' : 's'} on priced models, ${day}`,
        ref: `model-${day}`,
      }, 'daemon');
    } catch (err) {
      // The owner's own veto (Task 7): they have named the book in `never_modify`, and `appendEntry` refuses
      // even the privileged `daemon` actor. That is their decision to make, and it is not an error the company
      // should stop for — the walk gives up for this cycle, says so once on the event log, and the heartbeat
      // carries on with a book it simply may not add to. Anything else still throws: a disk that will not take
      // a write is a real failure and must not be swallowed as policy.
      if (!isVeto(err)) throw err;
      // The days named are recomputed every time this would fire, and the text is part of the dedupe key, so a
      // lock that outlives a day says so again with the new range instead of leaving a week-old date in the
      // log for an owner to read literally.
      const span = day === yesterday ? day : `${day} to ${yesterday}`;
      warnOnce(vault, LOCKED_ACCRUAL, `${lockSituation(LEDGER_PATH)}:${span}`, {
        path: LEDGER_PATH,
        reason: `${LEDGER_PATH} is on the owner's never_modify list, so model cost for ${span} was not recorded; nothing else is affected and the company keeps running`,
      });
      break;
    }
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

/** One time the company ran out: the entry that took cash to zero, and the one that lifted it back. */
export interface DormancyEpisode { start: string; end: string | null }

/**
 * Every dormancy the **book** records, oldest first, replayed in date order: `start` is the entry that took
 * cash to zero or below with the owner's capital already in, `end` the later entry that lifted it back above
 * zero, or null while the company is still stopped.
 *
 * The ledger is the authority on what happened, not `00 Inbox/`. The inbox says only what the owner has
 * already been *told*, and it is a folder they edit by hand: filing away a "Back to work" note must not be
 * able to make a past episode look open forever and silence every dormancy after it.
 *
 * `mode === 'live'` and the `capital`-sets-funded rule are `moneyReport`'s own, so a mock row cannot open an
 * episode here that `r.dormant` does not agree with, and a compensating `cost` row against capital nets out
 * the same way on both sides.
 */
export function dormancyEpisodes(vault: Vault): DormancyEpisode[] {
  const live = readLedger(vault).entries
    .filter((e) => e.mode === 'live')
    .sort((a, b) => a.at.localeCompare(b.at));
  const out: DormancyEpisode[] = [];
  let cash = 0;
  let funded = false;
  let open: DormancyEpisode | null = null;
  for (const e of live) {
    cash += e.kind === 'cost' ? -e.cents : e.cents;
    if (e.kind === 'capital') funded = true;
    if (cash > 0) { if (open) { open.end = e.at; open = null; } }
    else if (funded && !open) { open = { start: e.at, end: null }; out.push(open); }
  }
  return out;
}

/**
 * The open episode's start entry — the mark the dormancy message is keyed on — or `'none'` when the company
 * is not stopped.
 *
 * It is the *start* of the episode rather than "when money last moved" because `accrueModelCosts` books a
 * past-dated `live` cost row on the cycle after the day it charges: `lastLiveAt` therefore moves while nothing
 * new is being spent, which used to write a second "We have run out of money" and then a second "Back to
 * work". The start entry is far steadier, but it is **not** immovable: an accrual dated *before* the crossing
 * can take cash to zero a few hours earlier and shift it backwards. That is why nothing here trusts the mark
 * alone — `alreadyTold` compares against the episode, and the crash-repair path in `dormancyMessage` falls
 * back to any dormancy note this module wrote whose stamp never landed.
 */
export function dormancyMark(vault: Vault): string {
  const last = dormancyEpisodes(vault).at(-1);
  return last && last.end === null ? last.start : 'none';
}

/**
 * Whether the owner has already had a message of this kind about the episode that began at `start`.
 *
 * Compared as `mark >= start` rather than `mark === start`, because the start entry can shift backwards under
 * a past-dated accrual (above) while the episode itself is unchanged. Episodes do not overlap and a previous
 * one ended before this one began, so any stamped mark at or after this start belongs to this episode and
 * nothing else.
 */
function alreadyTold(vault: Vault, kind: 'dormant' | 'revived', start: string): boolean {
  return moneyNotes(vault, kind).some((n) => n.mark >= start);
}

/** The id prefix every note of a kind shares, so an orphan can be recognised without its stamp. */
const messageIdPrefix = (kind: 'dormant' | 'revived'): string => `${idFromKey('prop', `money:${kind}`)}_`;

/**
 * A dormancy message this module wrote **during this episode** whose second write — the stamp — never landed.
 *
 * Recognised by the id shape, which is the one thing a crash between the two writes cannot take away; without
 * it, a mark that shifted between the crash and the next cycle would leave the orphan unfindable and a second
 * "We have run out of money" would go to the owner.
 *
 * Bounded to the episode by `created`, which `createProposal` stamps on every note, because an unbounded match
 * is worse than the bug it fixes: an orphan left over from an episode the owner has already read about would
 * be taken as "already said" for the *next* one, and the company would never tell them it had run out a second
 * time. A note written while an episode was live always carries a `created` at or after that episode's start,
 * so "told late" never becomes "not told at all".
 *
 * `start` is always the **open** episode's start, which is the newest one there is — no episode begins after
 * it, so `created >= start` selects this episode and nothing else on its own. A second clause excluding notes
 * from a later episode would be unreachable code, and the one caller is right here.
 */
function orphanDormancy(vault: Vault, start: string): { path: string } | null {
  const prefix = messageIdPrefix('dormant');
  const n = listInbox(vault).find((x) =>
    x.data.id.startsWith(prefix)
    && (x.data as { money?: unknown }).money === undefined
    && x.data.created >= start);
  return n ? { path: n.path } : null;
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
 * The CEO's last message before the company stops. Written **once per episode** — one message when cash first
 * goes to zero after the owner funded the company, one "Back to work" when they answer it — and it answers the
 * two questions an owner will actually have: where did it go, and how do I start it again.
 *
 * Three guards, because a mark alone is not enough. The episode comes from the book (`dormancyEpisodes`), so a
 * hand-edited inbox cannot invent or hide one. `alreadyTold` asks whether any dormancy note carries a mark at
 * or after this episode's start, which stays true even when a past-dated accrual shifts the crossing entry
 * backwards. And a note this module wrote whose stamp was lost to a crash is found by its id shape — bounded
 * to this episode, so an old orphan can never stand in for a new silence — and repaired rather than written
 * again. Being told twice that the company has stopped is worse than being told late; being told **not at
 * all** is worse than either.
 */
export function dormancyMessage(vault: Vault, org: Org, r: MoneyReport, now: Date = new Date()): string | null {
  if (!r.dormant) return null;
  const episodes = dormancyEpisodes(vault);
  const open = episodes.at(-1);
  if (!open || open.end !== null) return null;
  const mark = open.start;
  if (alreadyTold(vault, 'dormant', mark)) return null;
  const id = moneyMessageId('dormant', mark);
  const already = findInboxById(vault, id) ?? orphanDormancy(vault, mark);
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
 * The other half: said once, when the dormancy the owner was told about has been answered with capital.
 *
 * Which dormancy is decided by the **book** — the newest episode with an `end` — and not by which inbox note
 * still looks unanswered. Filing away or deleting a "Back to work" note therefore costs at most one repeated
 * message about that episode; it can never make an old episode read as open and silence every dormancy after
 * it, which is what an inbox-only guard would do to a folder the owner edits by hand.
 */
export function revivalMessage(vault: Vault, org: Org, r: MoneyReport, now: Date = new Date()): string | null {
  if (r.dormant || r.cashCents <= 0) return null;
  const last = dormancyEpisodes(vault).at(-1);
  if (!last || last.end === null) return null;                   // never stopped, or still stopped
  const mark = last.start;
  if (!alreadyTold(vault, 'dormant', mark)) return null;         // never told them it stopped; nothing to answer
  if (alreadyTold(vault, 'revived', mark)) return null;
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
