import { join } from 'node:path';
import { formatValue, isDay, keyOf } from '../../shared/metrics.ts';
import { newMessageId, type Attention, type Stage } from '../../shared/model.ts';
import { bare, companyLine, isPlanDoc, SHARED_RECORD, parsePlan, PARTNER_CHANNEL, planStepLine, type Bet, type BetVerdict, type MorningNote, type PlanStep } from '../../shared/partner.ts';
import { clockOffset, localDay, now as clockNow } from '../clock.ts';
import { writeAtomic } from '../fsx.ts';
import type { Deps, Installed, Slice } from '../install.ts';
import { leadsFor } from '../leads/store.ts';
import { askedInstead, betDue, betsAttention, betsBook, briefMetrics, CARD_NAMES, cardOf, briefReading, briefRow, cannotLose, checkLine, closedLine, metricChoices, missingMetric, readMetric, type BetsBook, type BriefRow } from '../partner/bets.ts';
import { companyDocOf, ensureCompany, placeOf, sectionText, syncDecisions, writeBets } from '../partner/company.ts';
import { hub } from '../events.ts';
import { saysSomething } from '../missions.ts';
import { FAKE_MORNING, MOST_TRIES, morningDue, morningInputs, morningMessage, writeMorning, type MorningSources } from '../partner/morning.ts';
import { addPlan, boardFor, boardForPlan, NO_BOARD, planAttention, stepsFrom } from '../partner/plans.ts';
import { asksWhatNext, holdSynthesis, standingFacts } from '../partner/synthesis.ts';
import { asksVerdict, callShape, holdCall, PUSHBACK_LINE, pushesBack, thresholdOf, type KillSignal, type PartnerCall } from '../partner/call.ts';
import { breakEvenFix, changedLine, economicsBlock, figuresFix, sameMetric, stateOf, workingTools, type EconomicsState, type Reading } from '../partner/economics.ts';
import { chaseLine, keptPromiseLine, promiseLine, promisesAttention, promisesBook, promisesIn } from '../partner/promises.ts';
import { gatherSince, metricsOnDisk, sinceHeadline } from '../partner/since.ts';
import { partnerState, type PartnerStateBook } from '../partner/state.ts';
import { createReviews, granted } from '../partner/review.ts';
import { FAKE_REFRESH, holdStop, keepCall, loosens, readRefresh, refreshAsk, refreshDue, refreshOpening, refreshText, staleOf } from '../partner/refresh.ts';
import { crossedRefusal, killAskIn, killMovedLine, pastLine } from '../partner/kill.ts';
import { goalsIn } from '../partner/goal.ts';
import { correctionLines, correctionsIn, fixesLine, inputFixesIn, keepCorrections, keepFixes, unitFix, unitsFix } from '../partner/corrections.ts';
import { markClaims } from '../tools/evidence.ts';
import { holdDocClaims } from '../draftclaim.ts';
import { createWatch, fakeWatchReply, leadTwins, watchBudget, type Budget } from '../partner/watch.ts';
import { guardUnasked } from '../partner/unasked.ts';
import { draftId, gmailLink } from '../../shared/maildraft.ts';
import { leadAddresses, noAddress } from '../tools/outward.ts';
import { ruledOutLine, saidNoFor } from '../partner/saidno.ts';
import { staleNeeds, standingBlock, standingParts, stillWaiting, teamVerdict, verdictLines, type StandingParts } from '../partner/standing.ts';
import { companyFacts, keepFacts, keptLine, runwayFix } from '../partner/keep.ts';
import { CUSTOMER_LINE, customerReply, forCustomers } from '../partner/audience.ts';
import { wired } from '../prompt.ts';
import type { ModelMessage } from '../prompt.ts';
import { complete, fakeClient, promptSize } from '../providers.ts';
import { markVerdict, partnerRoute } from '../partner/route.ts';
import { withSystem, type Handler } from '../seams.ts';
import { newId, patchStageVia } from '../slice-kit.ts';
import { speaker, text, type Tool } from '../tools/registry.ts';

// The partner: one person who holds the whole company rather than one part of it, and the things that make that
// true. The Company document is the shared record every person reads; decisions land in it as they are made. Once a
// day the partner looks at the company unasked and leaves a morning note in Needs you, first in Today's five.
// Nothing here runs while the app is closed.

// The founder's partner, if one is on the stage: the first person marked so.
export const partnerOf = (stage: Stage) => stage.rooms.find((room) => room.partner);

export const PARTNER_TOOLS = ['close_bet'];
export const BOARD_TOOLS = ['propose_tasks'];
const VERDICTS: BetVerdict[] = ['worked', 'did-not'];

// A person puts a bet to the founder; only the partner (or the founder, from Needs you) says how one went, and only
// once its day has come. The number is read in code either way.
export function betTools(book: BetsBook, workspace: string, changed: () => Promise<void>, now: () => number = clockNow): Tool[] {
  return [
    {
      name: 'propose_bet', perTurn: 2,
      description: 'Put a bet on record for the founder to take: something the company does, what it should move, by how much and by when. '
        + 'It waits in Needs you; it is only on record once the founder takes it. Measure it by a number the app can read: '
        + 'a Metrics card number (its key or name), "leads", "leads:<stage>" such as "leads:replied", or "survey" (answers). '
        + 'Name it after what the founder\'s ask counts: "50 newsletter signups" is measured by "signups" on a Metrics card, never by leads. '
        + 'When it says a card or a row is missing, tell the founder exactly which card and row to add.',
      parameters: { type: 'object', properties: {
        what: { type: 'string', description: 'What the company does, in a few words' },
        hypothesis: { type: 'string', description: 'What should happen because of it, and why' },
        metric: { type: 'string', description: 'What it is measured by, as above' },
        target: { type: 'number', description: 'The value that metric should reach: above where it stands now (below, for a number that is better lower), so the bet can lose' },
        check_date: { type: 'string', description: 'YYYY-MM-DD, the day to look' },
      }, required: ['what', 'hypothesis', 'metric', 'target', 'check_date'] },
      async run(args, context) {
        const today = localDay(now());
        const checkDate = text(args, 'check_date', 10).trim();
        if (!isDay(checkDate)) throw new Error('"check_date" is a day, written YYYY-MM-DD');
        if (checkDate < today) throw new Error(`"check_date" is before today (${today})`);
        const target = typeof args.target === 'string' ? Number(args.target.replace(/[,$€£%\s]/g, '')) : Number(args.target);
        if (!Number.isFinite(target)) throw new Error('"target" must be a number');
        const metric = text(args, 'metric', 80).trim();
        // Held to what the founder's ask counts, before anything else is said about the pick.
        const instead = await askedInstead(workspace, context.stage, metric, context.query ?? '', target);
        if (instead) throw new Error(instead);
        const choices = await metricChoices(workspace, context.stage);
        let reading = await readMetric(workspace, context.stage, metric);
        // No card holds it, but the Company brief's Numbers do: the bet is offered with that row, and taking it adds the card.
        let brief: BriefRow | null = null;
        if (!choices.some((one) => one.toLowerCase() === metric.toLowerCase()) && reading.value === null) {
          brief = cardOf(metric) === CARD_NAMES.metrics ? await briefNumber(context.stage, context.store, metric) : null;
          if (!brief) throw new Error(missingMetric(context.stage, metric, choices));
          reading = briefReading(brief);
        }
        // A target the number already meets is no bet, unless the ask is to hold it: refused with the number as it stands.
        const lose = cannotLose(metric, target, reading, `${context.query ?? ''} ${text(args, 'what', 160)}`);
        if (lose) throw new Error(lose);
        const me = speaker(context);
        const bet = await book.propose({ what: bare(text(args, 'what', 160)), hypothesis: typeof args.hypothesis === 'string' ? args.hypothesis.replace(/\s+/g, ' ').trim().slice(0, 400) : '', metric, target, checkDate, ...(me ? { proposedBy: me.name, roomId: me.id } : {}), ...(brief ? { brief } : {}) });
        await changed();
        const wiredTo = partnerOf(context.stage)?.name ?? me?.name ?? 'your partner';
        const adds = brief ? ` No Metrics card holds "${metric}" yet: taking the bet adds one from the Company brief (${brief.label} ${formatValue(brief.value, brief.unit)}), wired to ${wiredTo}.` : '';
        return { text: `Proposed the bet "${bet.what}" (${bet.metric} to ${bet.target} by ${bet.checkDate}). It waits in Needs you; it is not on record until the founder takes it.${adds}` };
      },
    },
    {
      name: 'close_bet', perTurn: 2,
      description: 'Say how a bet on record went, on or after its check day. The number is read for you from its card; you say whether it worked and why in a line.',
      parameters: { type: 'object', properties: {
        bet: { type: 'string', description: 'What the bet was, as the Company document lists it' },
        verdict: { type: 'string', enum: VERDICTS },
        note: { type: 'string', description: 'One line on why' },
      }, required: ['bet', 'verdict'] },
      async run(args, context) {
        if (!speaker(context)?.partner) throw new Error('only the founder or the partner closes a bet');
        const wanted = text(args, 'bet', 200).trim().toLowerCase();
        const open = (await book.list()).filter((one) => one.status === 'open');
        const bet = open.find((one) => one.id === wanted || one.what.toLowerCase() === wanted) ?? open.find((one) => one.what.toLowerCase().includes(wanted));
        if (!bet) throw new Error(`no open bet is called "${args.bet}". Open: ${open.map((one) => `"${one.what}"`).join(', ') || 'none'}`);
        if (!betDue(bet, localDay(now()))) throw new Error(`"${bet.what}" is checked on ${bet.checkDate}; it cannot be closed before then`);
        const verdict = VERDICTS.includes(args.verdict as BetVerdict) ? args.verdict as BetVerdict : null;
        if (!verdict) throw new Error('"verdict" is "worked" or "did-not"');
        const reading = await readMetric(workspace, context.stage, bet.metric);
        const closed = await book.close(bet.id, { verdict, value: reading.value, note: typeof args.note === 'string' ? args.note.replace(/\s+/g, ' ').trim().slice(0, 300) : '', by: speaker(context)!.name });
        await changed();
        return { text: `${closedLine(closed)} (${reading.said}.)` };
      },
    },
  ];
}

// The Company brief's Numbers row a metric names, when no card holds it.
async function briefNumber(stage: Stage, store: { readDoc(id: string): Promise<string> }, metric: string): Promise<BriefRow | null> {
  const company = companyDocOf(stage);
  if (!company) return null;
  return briefRow(sectionText(await store.readDoc(company.id).catch(() => ''), 'Numbers'), metric);
}

// The founder took a bet whose number only the brief held: a Metrics card with that row and the bet's target on it,
// wired to the partner (or whoever proposed it), so the check day has a number to read. Named by the metric's key, so two quick yeses make one card.
export async function metricsFromBrief(workspace: string, store: Pick<Deps['store'], 'patchStage'>, row: BriefRow, roomId: string | undefined, now: number, target?: { value: number; by: string }): Promise<string> {
  const id = `metrics-${keyOf(row.label)}`;
  await writeAtomic(join(workspace, 'metrics', `${id}.json`), JSON.stringify(briefMetrics(row, localDay(now), now, target), null, 2), { mkdir: true });
  await store.patchStage((draft) => {
    if (!(draft.cards ?? []).some((card) => card.id === id)) draft.cards = [...(draft.cards ?? []), { id, kind: 'metrics', title: 'Numbers', ...placeOf(draft), w: 380, h: 440 }];
    // A card of that key already there (left from before, or the other yes) is wired, never wired twice.
    if (roomId && draft.rooms.some((room) => room.id === roomId) && !draft.wires.some((wire) => wire.from === roomId && wire.to === id)) draft.wires.push({ id: `${roomId}-${id}`, from: roomId, fromHandle: 'r', to: id, toHandle: 'l' });
  });
  return id;
}

// A plan's steps put to the founder as one question. Only steps never offered from that doc go in: after a yes, an
// edit that adds one step offers that one step, so a second yes never puts the old ones on the board twice. A
// proposal from the same doc that is still waiting takes the new steps in beside its own.
export async function offerPlan(state: PartnerStateBook, input: { who: string; roomId: string; title: string; steps: PlanStep[]; docId?: string }, now: number): Promise<boolean> {
  return state.change((held) => {
    const docId = input.docId;
    const before = docId && Array.isArray(held.offered?.[docId]) ? new Set(held.offered![docId]) : new Set<string>();
    const fresh = input.steps.filter((step) => !before.has(planStepLine(step)));
    // A new plan is worth a question from two steps; a plan already answered, from one new step.
    if (!fresh.length || (!before.size && fresh.length < 2)) return false;
    const waiting = docId ? held.plans.find((one) => one.docId === docId) : undefined;
    held.plans = [...held.plans.filter((one) => one !== waiting), { id: newId('plan-'), at: now, ...input, steps: [...(waiting?.steps ?? []), ...fresh] }];
    if (docId) held.offered = { ...held.offered, [docId]: [...before, ...fresh.map(planStepLine)] };
    return true;
  });
}

export function planTools(state: PartnerStateBook, changed: () => Promise<void>, now: () => number = clockNow): Tool[] {
  return [{
    name: 'propose_tasks', perTurn: 2,
    description: 'Offer the founder the steps of a plan as tasks for the board, one step per line; a day at the front of a line ("Day 1: …", "Mon 5 Oct: …") is kept. '
      + 'It waits in Needs you as one question; nothing is on the board until the founder says yes.',
    parameters: { type: 'object', properties: {
      title: { type: 'string', description: 'The plan, in a few words' },
      steps: { type: 'array', items: { type: 'string' }, description: 'Two or more steps, one line each' },
    }, required: ['title', 'steps'] },
    async run(args, context) {
      const steps = stepsFrom(Array.isArray(args.steps) ? args.steps.filter((one): one is string => typeof one === 'string') : []);
      if (steps.length < 2) throw new Error('give two or more steps, one line each');
      const me = speaker(context);
      await offerPlan(state, { who: me?.name ?? 'Someone', roomId: context.roomId, title: text(args, 'title', 120).replace(/\s+/g, ' ').trim(), steps }, now());
      await changed();
      return { text: `Offered ${steps.length} tasks to the founder. They wait in Needs you; nothing is on the board until the founder says yes.` };
    },
  }];
}

// What a test hands in instead of the clock and the model.
// `watchAsk` stands in for the model on the watch's unasked turns; `budget` for the daily budget of them; `phrase` for
// the small model that words a partner review. The watch, the review and the verdict refresh share the budget handed in.
type Asked = { text: string; provider?: string; model?: string };
export type PartnerOptions = { now?: () => number; ask?: (messages: ModelMessage[]) => Promise<string | Asked>; watchAsk?: (messages: ModelMessage[]) => Promise<Asked>; budget?: Budget; phrase?: (prompt: string) => Promise<string | null> };

export function createPartner(options: PartnerOptions = {}) {
  const now = options.now ?? clockNow;
  return async function install(deps: Deps): Promise<Installed> {
    const state = partnerState(deps.workspace);
    // The document is made at start on a real run. A fake run leaves the stage as the browser tests expect it unless
    // it is asked to (STAGE_PARTNER=1), or until a partner is added.
    const makeAtStart = !deps.fake || process.env.STAGE_PARTNER === '1';
    // Every write the app makes into the document is said to the window, so an open card reads it again.
    const changed = (docId: string) => hub.say(PARTNER_CHANNEL, { docChanged: docId });
    // The document, the first time only: made or adopted once and recorded, never made again on a later start.
    const adopt = async (id?: string) => {
      const made = await ensureCompany(deps.store, id, changed);
      await state.change((held) => { held.companyId = made.id; });
      return made;
    };
    // A verdict kept from before a restart still reserves the next hour's pushback.
    await state.read().then((held) => { if (held.call?.roomId && typeof held.call.at === 'number') markVerdict(held.call.roomId, held.call.at); }).catch(() => {});
    if (makeAtStart && !(await state.read()).companyId) await adopt().catch((error: Error) => console.error(`partner: ${error.message}`));
    // The document as it is now: the recorded one if it is still on the stage (renamed or not), nothing once the
    // founder took it away, and a pinned company doc by its title only while nothing has been recorded.
    const companyNow = async (stage?: Stage) => {
      const on = stage ?? await deps.store.loadStage();
      const { companyId } = await state.read();
      return companyId ? companyDocOf(on, companyId) : companyDocOf(on);
    };
    // The brief's Numbers worked out with calc (server/partner/economics.ts), or nothing when they do not hold enough.
    // A unit the founder put right in chat ("50 print jobs a month, not 50 paying hosts") is the one it is said in.
    const fixesNow = async () => unitFix((await state.read().catch(() => null))?.corrections ?? []);
    // Journey 16: the one picture of the numbers (server/partner/economics.ts): the brief's inputs, the founder's
    // corrections over them and the latest Metrics readings, every derived figure worked again on each read.
    const readingsNow = async (stage: Stage): Promise<Reading[]> => (await Promise.all((stage.cards ?? []).filter((card) => card.kind === 'metrics').map(async (card) => (await metricsOnDisk(deps.workspace, card.id).catch(() => []))
      .flatMap((metric) => { const last = [...metric.points].sort((a, b) => a.at.localeCompare(b.at)).at(-1); return last && Number.isFinite(last.value) ? [{ label: metric.label, value: last.value, day: last.at }] : []; })))).flat();
    const stateFrom = async (stage: Stage, company: string): Promise<EconomicsState> => {
      const held = await state.read().catch(() => null);
      return stateOf(sectionText(company, 'Numbers'), { fixes: held?.fixes ?? [], readings: await readingsNow(stage).catch(() => []), unitFixes: unitFix(held?.corrections ?? []) });
    };
    const stateNow = async (stage?: Stage): Promise<EconomicsState | null> => {
      const on = stage ?? await deps.store.loadStage();
      const doc = await companyNow(on);
      return doc ? stateFrom(on, await deps.store.readDoc(doc.id).catch(() => '')) : null;
    };
    const economicsNow = async (stage?: Stage) => (await stateNow(stage))?.economics() ?? null;
    // A kill signal's number as it stands now: the latest Metrics reading of its row, else the one state's paying count,
    // else the brief's row.
    const readingOf = async (stage: Stage, signal: KillSignal): Promise<{ value: number; said: string } | null> => {
      const said = thresholdOf(signal.what);
      if (!said) return null;
      const reading = (await readingsNow(stage).catch(() => [])).filter((one) => sameMetric(one.label, said.metric)).sort((a, b) => a.day.localeCompare(b.day)).at(-1);
      if (reading) return { value: reading.value, said: `${reading.label} is ${reading.value} (Metrics, ${reading.day})` };
      const economics = await stateNow(stage).catch(() => null);
      const paying = economics?.inputs.paying;
      if (paying && sameMetric(paying.label, said.metric)) return { value: paying.value, said: `${paying.label} is ${paying.value} (${paying.source === 'founder' ? 'your word' : 'Company brief'})` };
      return null;
    };
    // A kill signal set or moved: kept as the one check, raised at once when the number is already past its line.
    const keepSignal = async (old: KillSignal | undefined, fresh: KillSignal, roomId: string, stage: Stage) => {
      const reading = await readingOf(stage, fresh).catch(() => null);
      const line = thresholdOf(fresh.what);
      const crossed = !!reading && !!line && pastLine(reading.value, line.value, line.below);
      await promises.add({ what: fresh.what, due: fresh.by, roomId, check: true, ...(crossed ? { raised: `${reading!.said}, already past the line.` } : {}) });
      await deps.attention.refresh().catch(() => {});
      return killMovedLine(old, fresh, reading);
    };
    // Only what was decided is kept, with the inputs it was made on: never a figure worked from them.
    const keptCall = (call: PartnerCall, at: number, day: string, roomId: string, economics: EconomicsState | null, signalBy?: 'founder' | 'partner') => {
      const { working: _working, ...decided } = call;
      return { ...decided, at, day, roomId, ...(economics ? { snapshot: economics.snapshot() } : {}), ...(call.signal && signalBy ? { signalBy } : {}) };
    };
    // A kill line the founder set is theirs (journey 16: the refresh moved the founder's "below 12" to "below 7"). The
    // partner may only propose moving it, as a decision in Needs you; the line stands until the founder chooses.
    // `unasked`: a refresh, which never proposes loosening the founder's line to get away from a trend (journey 18:
    // "Shall it move to below 6?" as paying fell from 9 to 8 toward the founder's 7).
    const protectSignal = async (held: { signal?: KillSignal; signalBy?: 'founder' | 'partner' } | undefined, fresh: PartnerCall, roomId: string, who: string, unasked = false): Promise<{ call: PartnerCall; line?: string }> => {
      if (held?.signalBy !== 'founder' || !held.signal || !fresh.signal || (fresh.signal.what === held.signal.what && fresh.signal.by === held.signal.by)) return { call: fresh };
      if (unasked && loosens(held.signal, fresh.signal, thresholdOf)) return { call: { ...fresh, signal: held.signal } };
      const decision = await deps.decisions.propose({
        title: `Move your kill line from "${held.signal.what}" to "${fresh.signal.what}"?`,
        context: `You set the kill signal "${held.signal.what}" by ${held.signal.by}. The numbers moved since, and ${who} would move it to "${fresh.signal.what}" by ${fresh.signal.by}. It stays yours until you choose.`,
        options: [`Move it to "${fresh.signal.what}" by ${fresh.signal.by}`, `Keep "${held.signal.what}" by ${held.signal.by}`],
        proposedBy: who,
      });
      await state.change((draft) => { draft.killProposal = { decisionId: decision.id, signal: fresh.signal!, roomId }; });
      await deps.attention.refresh().catch(() => {});
      return { call: { ...fresh, signal: held.signal }, line: `Your kill line stays "${held.signal.what}" by ${held.signal.by}: you set it. Shall it move to "${fresh.signal.what}" by ${fresh.signal.by}? It waits in Needs you as your decision.` };
    };
    // What the founder said in the partner's room lately, their own words only.
    const founderWords = async (roomId: string) => (await deps.store.readChat(roomId).catch(() => [])).slice(-30).filter((one) => one.role === 'user' && !one.from).map((one) => one.text ?? '');
    // The founder challenging the verdict standing in this room is held to the verdict's four lines too, so a kill
    // signal changed under pushback replaces the check (server/partner/call.ts).
    const pushedBack = async (roomId: string, query: string) => !asksVerdict(query) && pushesBack(query) && (await state.read()).call?.roomId === roomId;
    // The morning turn spends a model call every day, so a fake run (the browser tests) only takes one when asked:
    // STAGE_PARTNER_MORNING=1, or the founder's own "morning note".
    // A check run that moved the clock (server/clock-offset.ts) wants the next day's note too: it is living that day.
    const morningOnTick = () => !deps.fake || process.env.STAGE_PARTNER_MORNING === '1' || clockOffset() !== 0;
    const book = betsBook(deps.workspace, now);
    const bets = (): Promise<Bet[]> => book.list();
    const promises = promisesBook(deps.workspace, now);
    // The review and the verdict refresh spend from the app's one budget for unasked work (usage.ts).
    const budget: Budget = options.budget ?? deps.unasked;
    // A bet changed: the Company document's Bets section is written again from the ledger, and Needs you is told.
    const betsChanged = async () => {
      standing = null;
      const doc = await companyNow();
      if (doc) await writeBets(deps.store, doc.id, await book.list(), changed);
      await deps.attention.refresh().catch(() => {});
    };

    // Decided decisions go into the Company document, each once.
    let syncing: Promise<void> | null = null;
    const sync = () => (syncing ??= (async () => {
      try {
        const doc = await companyNow();
        if (!doc) return;
        const list = await deps.decisions.list();
        await state.change(async (held) => { Object.assign(held, await syncDecisions(deps.store, doc.id, list, held, changed, now())); });
      } finally { syncing = null; }
    })());
    // The founder chose on a proposed move of their kill line: moved only when they said so.
    const killChosen = async () => {
      const { killProposal } = await state.read();
      if (!killProposal) return;
      const decision = (await deps.decisions.list()).find((one) => one.id === killProposal.decisionId);
      if (decision && decision.status !== 'decided') return;
      await state.change((draft) => { delete draft.killProposal; });
      if (!decision || !/^Move it\b/.test(decision.chosen ?? '')) return;
      const held = (await state.read()).call;
      const old = held?.signal;
      await state.change((draft) => { if (draft.call) draft.call = { ...draft.call, signal: killProposal.signal, signalBy: 'founder' }; });
      const line = await keepSignal(old, killProposal.signal, killProposal.roomId, await deps.store.loadStage());
      await deps.store.appendChat(killProposal.roomId, { id: newMessageId(), role: 'assistant', text: `*${line}*`, at: now() });
      standing = null;
    };
    const offDecisions = deps.decisions.onChange(() => { standing = null; void sync().catch(() => {}); void killChosen().catch((error: Error) => console.error(`partner kill: ${error.message}`)); });

    // A partner on the stage owns the Company document: with none recorded yet it is made or adopted, and each
    // partner is wired to it once. A wire the founder takes away later stays away; so does a document they removed.
    async function keepCompany() {
      const stage = await deps.store.loadStage();
      const partner = partnerOf(stage);
      if (!partner) return;
      const held = await state.read();
      const id = held.companyId ? companyDocOf(stage, held.companyId)?.id : (await adopt()).id;
      if (!id || held.wired?.includes(partner.id)) return;
      await patchStageVia(deps.store, (draft) => {
        if (draft.wires.some((wire) => (wire.from === partner.id && wire.to === id) || (wire.to === partner.id && wire.from === id))) return;
        draft.wires.push({ id: `${partner.id}-${id}`, from: partner.id, fromHandle: 'r', to: id, toHandle: 'l' });
      });
      await state.change((draft) => { draft.wired = [...(draft.wired ?? []), partner.id]; });
    }

    // ------------------------------------------------------------ the morning turn

    // One quiet turn of the partner's: nothing is shown while it is written, so a stream that breaks part way goes
    // straight to the next model. `reserved`: the partner-only model may answer it.
    const quietTurn = (reserved: boolean, unasked = false) => async (messages: ModelMessage[]): Promise<Asked> => {
      const { order } = partnerRoute(deps.clients, deps.usage, { promptChars: promptSize(messages), tools: false, reserved, unasked });
      const reply = await complete(messages, { onToken: () => {}, onRestart: () => {} }, order, ({ client, error }) => deps.usage.failed(client.name, error), (client) => deps.usage.admit(client.name));
      if (!reply.reported) deps.usage.record(reply.client.name, reply.usage, reply.quota);
      return { text: reply.text, provider: reply.client.name, model: reply.client.model };
    };
    // The morning note is one of the partner-only model's reserved turns.
    const ask = options.ask ?? (deps.fake ? async (messages: ModelMessage[]) => ({ text: /Make the call again/.test(String(messages.at(-1)?.content ?? '')) ? FAKE_REFRESH : FAKE_MORNING, provider: fakeClient.name, model: fakeClient.model }) : quietTurn(true));

    // The watch (server/partner/watch.ts): a number trending to the kill line, a lead who replied, a watched page that
    // changed and a promise two days late each wake the partner for one unasked turn that ends in something ready to
    // run. Never on the partner-only model, and three a day out of the day's shared budget for unasked work. A fake run (the browser checks) looks only when asked
    // (POST /api/partner/watch) or with STAGE_PARTNER_WATCH=1.
    const watchOnTick = !deps.fake || process.env.STAGE_PARTNER_WATCH === '1';
    const watch = createWatch({
      workspace: deps.workspace, now, busy: deps.busy, budget: options.budget ?? watchBudget(deps.unasked),
      stage: () => deps.store.loadStage(), attention: () => deps.attention.list(), promises: () => promises.list(), bets: () => book.list(),
      leads: (id) => leadsFor(deps.workspace).list(id), promptFor: (on, roomId) => deps.promptFor(on, roomId, [], true),
      sources: async (on) => { const doc = await companyNow(on); return doc ? [await deps.store.readDoc(doc.id).catch(() => '')] : []; },
      ask: options.watchAsk ?? (deps.fake ? async (messages) => ({ text: fakeWatchReply(messages), provider: fakeClient.name, model: fakeClient.model }) : quietTurn(false, true)),
      changed: () => deps.attention.refresh(), notify: deps.notify, economics: () => stateNow(),
      acts: {
        // Drafted the way draft_email drafts, and only to an address still on a Leads card.
        async email(draft, proposal) {
          const known = (await leadAddresses(deps.workspace)(await deps.store.loadStage())).map((one) => one.toLowerCase());
          if (!known.includes(draft.to.toLowerCase())) throw new Error(`${noAddress(draft.to)}: it is no longer on a Leads card`);
          await deps.attention.raise({ id: draftId(draft), kind: 'mail-draft', title: `Email to ${draft.to} ready to send`, detail: draft.subject, url: gmailLink(draft), at: now(), who: proposal.who, roomId: proposal.roomId });
        },
        async task(draft, proposal) {
          const stage = await deps.store.loadStage();
          const boardId = boardFor(stage, proposal.roomId) ?? await boardForPlan(deps.store, proposal.roomId);
          await deps.boards.add(boardId, { title: draft.title, detail: `${proposal.who} proposed this unasked: ${proposal.why}.${proposal.number ? `\n${proposal.number}` : ''}`, column: 'todo', due: draft.due });
        },
        async decision(draft, proposal) {
          await deps.decisions.record({ title: draft.title, chosen: draft.title, why: `${proposal.who} proposed it unasked: ${proposal.why}.${proposal.number ? ` ${proposal.number}` : ''}` });
        },
        async drop(draft) { await promises.close(draft.promiseId, false).catch((error: Error) => { if (!/already closed/.test(error.message)) throw error; }); standing = null; },
      },
    });

    // A review is worded on the usual partner order, never the reserved model; a fake run keeps the worked-out line.
    // Held to the facts it was given like every unasked output: a sentence that promises, counts or quotes what they do not
    // say is taken out, and with nothing left the worked-out line stands (server/partner/unasked.ts).
    const phrase = options.phrase ?? (deps.fake ? undefined : async (prompt: string) => guardUnasked((await quietTurn(false)([{ role: 'user', content: prompt }])).text, [prompt]).text || null);
    // A colleague's finished doc write is reviewed by the partner on the next tick (server/partner/review.ts).
    const reviews = createReviews({
      workspace: deps.workspace, attention: deps.attention, busy: deps.busy, now, budget, phrase, notify: deps.notify,
      // A review line in a colleague's room is the partner's review, not an ask: the window labels it so.
      store: { loadStage: () => deps.store.loadStage(), readDoc: (id) => deps.store.readDoc(id), appendChat: (roomId, message) => deps.store.appendChat(roomId, { ...message, note: 'review' }) },
      company: async (stage) => { const doc = await companyNow(stage); return doc ? { id: doc.id, text: await deps.store.readDoc(doc.id).catch(() => '') } : null; },
      economics: (stage) => stateNow(stage),
    });
    const offReviews = deps.seams.on('turn:after', reviews.heard);

    // Today's note, written now if it is due (or asked for), else the one already written, else null.
    let writing: Promise<(MorningNote & { unchanged?: true }) | null> | null = null;
    // Everything the partner reads across the rooms, as it stands now: the morning note and the standing facts both
    // read from this.
    const sourcesFor = (stage: Stage, partnerId: string, company: string): MorningSources => ({
      workspace: deps.workspace, stage, partnerId, now: now(), bets, company, economics: () => stateFrom(stage, company),
      decisions: () => deps.decisions.list(), boards: (id) => deps.boards.list(id), leads: (id) => leadsFor(deps.workspace).list(id),
      chat: (roomId) => deps.store.readChat(roomId), doc: (id) => deps.store.readDoc(id),
      promises: () => promises.list(), metrics: (id) => metricsOnDisk(deps.workspace, id),
    });
    // The standing facts, gathered once and kept until the next tick or until something they read changes (a bet, a
    // decision, a write by a tool). What waits in Needs you is read fresh every turn.
    let standing: Promise<StandingParts> | null = null;
    async function partsFor(stage: Stage, partnerId: string): Promise<StandingParts> {
      if (!standing) {
        const doc = await companyNow(stage);
        const gathering = standingParts(sourcesFor(stage, partnerId, doc ? await deps.store.readDoc(doc.id).catch(() => '') : ''));
        standing = gathering;
        gathering.catch(() => { if (standing === gathering) standing = null; });
      }
      // The founder's open promises are read fresh too: one closed a moment ago is gone from the next turn.
      // So is what the founder said no to: a no given a moment ago is in the very next turn.
      // So is the partner's own verdict: one refreshed or changed under pushback a moment ago is the one said.
      const [parts, promised, declined, held, economics] = await Promise.all([standing, promises.list().catch(() => []), saidNoFor(deps.workspace).lines().catch(() => []), state.read().catch(() => null), stateNow(stage).catch(() => null)]);
      // A verdict made on inputs that changed since is said to be stale, with what changed (journey 16).
      const stale = staleOf(held?.call, economics);
      const call = [...verdictLines(held?.call), ...(stale.length && held?.call?.decision ? [`That verdict is stale: made on numbers that changed since (${stale.map((one) => changedLine(one, economics?.currency ?? '')).join('; ')}). Work from the numbers now, never from the figures said then.`] : [])];
      return { ...parts, promised: promised.filter((one) => one.status === 'open').map(promiseLine), declined, call, corrected: [...(economics?.founderLines() ?? []), ...correctionLines(held?.corrections ?? [])] };
    }
    async function standingFor(stage: Stage, partnerId: string) {
      // Bets are read from the ledger, never from Needs you rows: a row can outlive the take by a refresh.
      // A ledger that cannot be read filters nothing: every row stays rather than every bet going quiet.
      const [parts, waiting, ledger] = await Promise.all([partsFor(stage, partnerId), deps.attention.list().catch(() => []), book.list().catch(() => null)]);
      return standingBlock(parts, ledger ? stillWaiting(waiting, ledger) : waiting);
    }

    // What the note is read from, as it stands now.
    async function inputsNow(stage: Stage, partnerId: string) {
      const doc = await companyNow(stage);
      const chats = Object.fromEntries(await Promise.all(stage.rooms.map(async (room) => [room.id, await deps.store.readChat(room.id).catch(() => [])] as const)));
      const company = doc ? await deps.store.readDoc(doc.id) : '';
      return { company, key: morningInputs({ stage, partnerId, decisions: await deps.decisions.list(), bets: await book.list(), company, chats }) };
    }

    // Today's note: written on the tick when it is due, or when the founder asks. Asked again the same day, it is
    // written again only when something it reads has changed since; otherwise the one there stands, marked unchanged.
    const morning = (asked: boolean) => (writing ??= (async (): Promise<(MorningNote & { unchanged?: true }) | null> => {
      try {
        const at = now();
        const today = localDay(at);
        const held = await state.read();
        if (!asked && held.morning?.day === today) return held.morning;
        if (!asked && (!morningOnTick() || !morningDue(held, at))) return null;
        const stage = await deps.store.loadStage();
        const partner = partnerOf(stage);
        // Never beside a turn of their own: the note would land in the middle of what they are saying.
        if (!partner || deps.busy.has(partner.id)) return null;
        const inputs = await inputsNow(stage, partner.id);
        if (held.morning?.day === today && held.morning.inputs === inputs.key) return { ...held.morning, unchanged: true };
        const count = held.tries?.day === today ? held.tries.count : 0;
        await state.change((draft) => { draft.tries = { day: today, count: count + 1, last: at }; });
        const written = await writeMorning({
          // The founder's own ask, or the day's last try, gets a note even when it is still at fault.
          name: partner.name, ask, last: asked || count + 1 >= MOST_TRIES,
          promptFor: (on, roomId) => deps.promptFor(on, roomId, [], true),
          sources: { ...sourcesFor(stage, partner.id, inputs.company), now: at },
        }).catch((error: Error) => { console.error(`partner morning: ${error.message}`); return null; });
        if (!written) return null;
        const note = { ...written, inputs: inputs.key };
        await state.change((draft) => { draft.morning = note; if (draft.morningDone === today) delete draft.morningDone; });
        await deps.store.appendChat(partner.id, { id: newMessageId(), role: 'assistant', text: morningMessage(note), at: note.at, ...(note.provider ? { provider: note.provider } : {}), ...(note.model ? { model: note.model } : {}) });
        await deps.attention.refresh().catch(() => {});
        deps.notify?.(`Morning note from ${partner.name}`, sinceHeadline(note.since) ?? note.things[0] ?? 'No moves today.');
        return note;
      } finally { writing = null; }
    })());

    // A lead's reply the partner already answered unasked is one row, not two.
    deps.attention.settle(async (rows) => leadTwins(rows));

    // What waits for the founder: today's note until they say they have read it.
    deps.attention.source(async (): Promise<Attention[]> => {
      const held = await state.read();
      const note = held.morning;
      const found: Attention[] = [];
      if (note && note.day === localDay(now()) && held.morningDone !== note.day) {
        // What changed since yesterday leads, when something did; else the first move is the title. The moves, the
        // risk and the question follow in the row itself.
        const head = sinceHeadline(note.since);
        const rest = (head ? note.things : note.things.slice(1)).map((thing, index) => `${index + (head ? 1 : 2)}. ${thing}`).join(' ');
        found.push({ id: `morning-note:${note.day}`, kind: 'morning-note', title: `Morning note: ${head ?? note.things[0] ?? 'no moves today'}`, detail: [rest, note.risk.trim() ? `Risk: ${note.risk}` : '', note.question.trim() ? `Question: ${note.question}` : ''].filter(Boolean).join(' '), at: note.at, who: note.who, roomId: note.roomId });
      }
      const stage = await deps.store.loadStage();
      const verdict = await teamVerdict(stage, (id) => deps.store.readDoc(id)).catch(() => null);
      return [...found, ...await watch.rows(), ...await reviews.rows(), ...planAttention(held.plans), ...await betsAttention(await book.list(), stage, deps.workspace, localDay(now()), verdict), ...promisesAttention(await promises.list(), localDay(now()))];
    });
    // A person wrote a doc that is a plan (by its title or its first heading): its day-by-day steps are offered as tasks.
    const afterTool: Handler<'tool:after'> = async (payload, next) => {
      const { event, roomId } = payload;
      const effect = event.effect;
      // Whatever a tool changed may be a standing fact: they are gathered again for the next turn.
      if (event.ok && effect) standing = null;
      if (event.ok && (effect?.kind === 'doc-created' || effect?.kind === 'doc-changed')) {
        try {
          const stage = await deps.store.loadStage();
          const title = stage.docs.find((doc) => doc.id === effect.id)?.title ?? (effect.kind === 'doc-created' ? effect.title : '');
          const body = await deps.store.readDoc(effect.id);
          const who = stage.rooms.find((one) => one.id === roomId);
          if (who && effect.id !== (await companyNow(stage))?.id && isPlanDoc(title, body) && await offerPlan(state, { who: who.name, roomId, title, steps: parsePlan(body), docId: effect.id }, now())) await deps.attention.refresh();
        } catch (error) { console.error(`partner plan: ${(error as Error).message}`); }
      }
      return next(payload);
    };
    const offSeam = deps.seams.on('tool:after', afterTool);
    // The prompt finds the company document by its title. One the founder renamed is still the company's (it is
    // found here by the id recorded for it), so the line saying it is the shared record is added here instead.
    // The partner's turn carries the standing facts at the end of the system prompt, where the morning note's facts
    // come from, so the verdict the note leads with is in every answer too.
    // The inputs the founder put right in each room's last turn, for the line under its reply.
    const fixedNow = new Map<string, { query: string; line: string }>();
    async function takeFixes(stage: Stage, roomId: string, query: string) {
      const doc = await companyNow(stage);
      if (!doc) return;
      const economics = await stateFrom(stage, await deps.store.readDoc(doc.id).catch(() => ''));
      const fresh = inputFixesIn(query, economics, localDay(now()));
      if (!fresh.length) { fixedNow.delete(roomId); return; }
      const held = await state.change((draft) => { draft.fixes = keepFixes(draft.fixes ?? [], fresh); return draft.call; });
      standing = null;
      const stale = held?.decision ? ` My verdict of ${held.day} was made on the numbers before, so it is stale: ${asksVerdict(query) || pushesBack(query) ? 'it is made again here' : 'I make it again on the next look'}.` : '';
      fixedNow.set(roomId, { query, line: `${fixesLine(fresh, economics.currency ?? '').replace(/\*$/, '')}${stale}*` });
    }
    const beforeTurn: Handler<'turn:before'> = async (payload, next) => {
      const system = payload.messages[0];
      if (system?.role !== 'system') return next(payload);
      const stage = await deps.store.loadStage();
      let out = payload;
      if (!system.content.includes(SHARED_RECORD)) {
        const { companyId } = await state.read();
        const doc = companyId ? companyDocOf(stage, companyId) : undefined;
        if (doc?.pinned) out = withSystem(out, companyLine(doc.title));
      }
      if (stage.rooms.some((one) => one.id === payload.roomId && one.partner)) {
        // The founder's word on an input ("11 pay", "€59 is per week") is kept before the turn, so this very turn, its
        // standing facts and its working already stand on it (journey 16).
        await takeFixes(stage, payload.roomId, payload.query).catch((error: Error) => console.error(`partner numbers: ${error.message}`));
        const block = await standingFor(stage, payload.roomId).catch((error: Error) => { console.error(`partner standing facts: ${error.message}`); return ''; });
        out = withSystem(out, block);
        // Written for customers: said before it is written, and held to it after (the reply seam below).
        if (forCustomers(payload.query)) out = withSystem(out, CUSTOMER_LINE);
        // A verdict on the company comes in four lines, held to them after (the reply seam below). The brief's numbers
        // are worked out with calc first (break-even, runway), so the call is made with them in view.
        const pushed = await pushedBack(payload.roomId, payload.query).catch(() => false);
        if (asksVerdict(payload.query) || pushed) {
          const economics = await economicsNow(stage).catch(() => null);
          if (pushed) out = withSystem(out, PUSHBACK_LINE);
          const brief = await companyNow(stage).then((doc) => (doc ? deps.store.readDoc(doc.id) : '')).catch(() => '');
          out = withSystem(out, callShape(localDay(now()), !!economics, goalsIn(brief, localDay(now()))));
          if (economics) out = withSystem(out, economicsBlock(economics));
        }
      }
      return next(out);
    };
    const offTurn = deps.seams.on('turn:before', beforeTurn);

    // The founder told the partner where the company stands (a price, the cash, the burn, the users, what it does):
    // it goes into the Company document's own section, with a receipt under the reply. Never with the wire taken away.
    // Then a runway rounded toward the better side is put right against the Company numbers.
    const onReply: Handler<'turn:reply'> = async (payload, next) => {
      const stage = await deps.store.loadStage();
      const me = stage.rooms.find((one) => one.id === payload.roomId && one.partner);
      if (!me || payload.reply.stopped || !payload.reply.text.trim()) return next(payload);
      // What the founder put right is kept before anything is worked out, so this very reply is held to it.
      const corrected = correctionsIn(payload.query);
      if (corrected.length) {
        await state.change((draft) => { draft.corrections = keepCorrections(draft.corrections ?? [], corrected, localDay(now())); }).catch(() => {});
        standing = null;
      }
      const fixes = await fixesNow();
      // "What now" is answered across the rooms: held to the standing facts in code, asked once more if it names too
      // few of them (server/partner/synthesis.ts).
      if (asksWhatNext(payload.query)) {
        const facts = standingFacts(await partsFor(stage, me.id).catch(() => null) ?? { verdicts: [], numbers: '', open: [], planned: [], flagCounts: [], decided: [], learned: [] });
        const held = await holdSynthesis(payload.query, payload.reply, payload.again, facts, payload.lookedAgain);
        if (held !== payload.reply) payload = { ...payload, reply: held, lookedAgain: payload.lookedAgain || held.text !== payload.reply.text };
      }
      // A verdict on the company commits: the call, the reason on record, a kill signal with its day, the first move.
      // A part missing is asked for once; the kill signal waits in Needs you for its day (server/partner/call.ts).
      let checkLine = '';
      const pushed = await pushedBack(me.id, payload.query).catch(() => false);
      if (asksVerdict(payload.query) || pushed) {
        try {
          const before = (await state.read()).call;
          const today = localDay(now());
          const doc = await companyNow(stage);
          const [company, block, chat] = await Promise.all([
            doc ? deps.store.readDoc(doc.id).catch(() => '') : '', standingFor(stage, me.id).catch(() => ''),
            deps.store.readChat(me.id).catch(() => []),
          ]);
          const evidence = [company, block, payload.query, ...chat.slice(-30).map((one) => one.text ?? ''), ...payload.reply.tools.map((tool) => tool.result ?? '')].join('\n');
          const said = [company, payload.query, ...chat.slice(-30).filter((one) => one.role === 'user' && !one.from).map((one) => one.text ?? ''), ...payload.reply.tools.filter((tool) => tool.ok !== false).map((tool) => tool.result ?? '')];
          const numbersState = company ? await stateFrom(stage, company) : null;
          const economics = numbersState?.economics() ?? null;
          const { reply, call: made, askedAgain } = await holdCall(payload.query, payload.reply, payload.again, today, evidence, said, economics, company ? sectionText(company, 'Numbers') : '', pushed, goalsIn(company, today));
          // No stop for a company that is not running out, unless the founder's own words asked for it (refresh.ts).
          const stopHeld = made ? holdStop(made, numbersState, [payload.query, ...await founderWords(me.id)], before?.decision) : null;
          const unprotected = stopHeld?.call ?? made;
          // The founder naming the kill line in their own ask makes it theirs; else a line they set stays theirs.
          const labels = [...sectionText(company, 'Numbers').split('\n').flatMap((line) => { const found = /^\s*[-*]\s+([^:]{1,40}):\s*[$€£]?\s?\d/.exec(line); return found ? [found[1].trim()] : []; })];
          const named = unprotected?.signal ? killAskIn(payload.query, { today, labels, signal: before?.signal, loose: true }) : null;
          const theirs = !!named && thresholdOf(unprotected!.signal!.what)?.value === named.line;
          const guarded = unprotected && !theirs ? await protectSignal(before, unprotected, me.id, me.name) : { call: unprotected, line: undefined as string | undefined };
          const call = guarded.call;
          const signalBy: 'founder' | 'partner' = theirs || (guarded.line && before?.signalBy === 'founder') || (call?.signal && before?.signalBy === 'founder' && before.signal?.what === call.signal.what && before.signal.by === call.signal.by) ? 'founder' : 'partner';
          if (call) {
            let said = reply.text;
            if (stopHeld?.note) {
              said = said.replace(/^My call: \*\*stop\*\*\./m, `My call: **${call.decision}**.`);
              if (!call.move) said = said.replace(/^This week: .*\n?/m, '');
              said = `${said.replace(/\s+$/, '')}\n\n${stopHeld.note}`;
            }
            // The working rides with the turn as the calc tool's own results, so the guard and the founder see where
            // each figure in the reason came from.
            const worked = economics ? workingTools(economics, (index) => `calc-brief-${now()}-${index}`) : [];
            payload = { ...payload, reply: { ...reply, text: said, tools: [...worked, ...reply.tools] }, lookedAgain: payload.lookedAgain || askedAgain };
            const at = now();
            await state.change((held) => { held.call = keptCall(call, at, today, me.id, numbersState, signalBy); });
            // The founder's pushback in the next hour is answered on the partner-only model too.
            markVerdict(me.id, at);
            if (call.signal) {
              // A new kill signal takes the old one's place as the one check, and the founder is told which went, and
              // whether the number already sits past the new line.
              const moved = before?.signal && (before.signal.what !== call.signal.what || before.signal.by !== call.signal.by);
              const line = await keepSignal(moved ? before!.signal : undefined, call.signal, me.id, stage);
              checkLine = moved || /already past|right on the line/.test(line) ? `*${line}*` : `*Kept as a check: it comes to Needs you on ${call.signal.by}.*`;
            }
            if (guarded.line) checkLine = `*${guarded.line}*`;
          }
        } catch (error) { console.error(`partner verdict: ${(error as Error).message}`); }
      }
      const facts = companyFacts(payload.query);
      let text = payload.reply.text;
      let receipt = '';
      let wroteBrief = false;
      try {
        const doc = await companyNow(stage);
        let company = doc ? await deps.store.readDoc(doc.id) : '';
        if (doc && (facts.numbers.length || facts.idea || facts.customer || facts.denied?.length)) {
          const kept = keepFacts(company, facts, localDay(now()));
          let line = '';
          if (kept.kept.length && wired(stage, me.id, [doc.id]).length) {
            wroteBrief = true;
            await deps.store.writeDoc(doc.id, kept.text);
            changed(doc.id);
            standing = null;
            company = kept.text;
            line = keptLine(kept.kept);
          } else if (kept.kept.length) line = `*Not kept: the "${doc.title}" document is not wired to ${me.name}, so ${kept.kept.join(', ')} are not in it. Wire it to ${me.name} to keep it current.*`;
          if (line) receipt = line;
        }
        const numbers = `${sectionText(company, 'Numbers')}\n${payload.query}`;
        // What customers will read carries no source tags, placeholders or company money, and is not called ready while it does.
        if (forCustomers(payload.query)) text = customerReply(text, numbers);
        // Runway and break-even come from calc on the brief's numbers, never from the model (server/partner/economics.ts).
        // A claim to have written a document with no write behind it this turn is put right (server/draftclaim.ts).
        if (doc) text = holdDocClaims(text, payload.reply.tools, { title: doc.title, wrote: wroteBrief });
        const numbersNow = await stateFrom(stage, company);
        text = breakEvenFix(unitsFix(runwayFix(figuresFix(text, numbersNow.economics()), numbers), fixes), numbersNow);
        // The inputs the founder put right this turn, said under the reply.
        const fixed = fixedNow.get(me.id);
        if (fixed?.query === payload.query) { receipt = receipt ? `${receipt}\n\n${fixed.line}` : fixed.line; fixedNow.delete(me.id); }
        // Sent to Needs you with nothing waiting there: said under the reply.
        const rows = await deps.attention.list().catch(() => []);
        const ledger = await book.list().catch(() => null);
        text = staleNeeds(text, ledger ? stillWaiting(rows, ledger) : rows);
        if (receipt) text = `${text.replace(/\s+$/, '')}\n\n${receipt}`;
        if (checkLine) text = `${text.replace(/\s+$/, '')}\n\n${checkLine}`;
      } catch (error) { console.error(`partner keep: ${(error as Error).message}`); }
      return next(text === payload.reply.text ? payload : { ...payload, reply: { ...payload.reply, text } });
    };
    const offReply = deps.seams.on('turn:reply', onReply);

    // The founder said they would do something, in any room: it is kept as a dated promise, with a line under the
    // reply saying so. A reply the founder stopped keeps nothing.
    const onPromise: Handler<'turn:reply'> = async (payload, next) => {
      if (payload.reply.stopped) return next(payload);
      const kept = [];
      // A promises book that cannot be read (not a damaged file, which is rescued: a folder in its place, no access)
      // costs the receipt line, never the reply.
      try {
        for (const said of promisesIn(payload.query, now())) if (await promises.add({ ...said, roomId: payload.roomId })) kept.push(said);
      } catch (error) {
        console.log(`the partner could not keep a promise: ${(error as Error).message}`);
        return next(payload);
      }
      if (!kept.length) return next(payload);
      await deps.attention.refresh().catch(() => {});
      return next({ ...payload, reply: { ...payload.reply, text: `${payload.reply.text.replace(/\s+$/, '')}\n\n${keptPromiseLine(kept)}` } });
    };
    const offPromise = deps.seams.on('turn:reply', onPromise);

    // A promise a day late is asked about once in the partner's room, and said to the founder once. Never beside a
    // turn of the partner's own.
    async function chasePromises() {
      const today = localDay(now());
      const late = (await promises.list()).filter((one) => one.status === 'open' && !one.check && one.due < today && !one.chased);
      if (!late.length) return;
      const partner = partnerOf(await deps.store.loadStage());
      if (partner && deps.busy.has(partner.id)) return;
      for (const one of late) {
        if (!await promises.chased(one.id)) continue;
        if (partner) await deps.store.appendChat(partner.id, { id: newMessageId(), role: 'assistant', text: chaseLine(one), at: now() });
      }
      await deps.attention.refresh().catch(() => {});
      deps.notify?.('A promise is late', late[0].what);
    }

    // A bet whose day has come is posted once in the partner's room with its number read from the card, and said to
    // the founder once; which ones were posted is kept, so a restart does not post them again. Never beside a turn of
    // the partner's own: it waits for the next tick.
    async function checkBets() {
      const today = localDay(now());
      const posted = new Set((await state.read()).betChecks ?? []);
      const fresh = (await book.list()).filter((bet) => betDue(bet, today) && !posted.has(bet.id));
      if (!fresh.length) return;
      const stage = await deps.store.loadStage();
      const partner = partnerOf(stage);
      if (partner && deps.busy.has(partner.id)) return;
      if (partner) {
        for (const bet of fresh) {
          const reading = await readMetric(deps.workspace, stage, bet.metric);
          await deps.store.appendChat(partner.id, { id: newMessageId(), role: 'assistant', text: checkLine(bet, reading), at: now() });
        }
      }
      await state.change((draft) => { draft.betChecks = [...(draft.betChecks ?? []), ...fresh.map((bet) => bet.id)].slice(-200); });
      await deps.attention.refresh().catch(() => {});
      deps.notify?.('A bet is due for a check', fresh[0].what);
    }

    // The partner's verdict made again, unasked, when the brief's economics moved more than a tenth since the call or a
    // week passed (server/partner/refresh.ts). One try a day, from the day's budget, on the reserved model; never beside
    // a turn of the partner's own. A new kill signal takes the old one's place as the check.
    async function refreshVerdict() {
      if (!morningOnTick()) return;
      const held = await state.read();
      if (!held.call) return;
      const today = localDay(now());
      const stage = await deps.store.loadStage();
      const partner = partnerOf(stage);
      if (!partner || deps.busy.has(partner.id)) return;
      const doc = await companyNow(stage);
      const company = doc ? await deps.store.readDoc(doc.id).catch(() => '') : '';
      // The one picture of the numbers: the call is due a look only when an input it was made on changed (stale), the
      // brief's goal day passed, or a week went by (server/partner/refresh.ts).
      const numbers = doc ? await stateFrom(stage, company) : null;
      // One try a day on the same numbers; a brief edit after it is looked at on the next tick (journey 18: a price
      // edit at 18:00 waited for the next morning).
      const seen = JSON.stringify(numbers?.snapshot() ?? {});
      if (held.refreshTried === today && held.refreshSeen === seen) return;
      const economics = numbers?.economics() ?? null;
      const goal = goalsIn(company, today)[0];
      const due = refreshDue(held.call, numbers, today, { goal, ...(held.crossing ? { crossing: held.crossing } : {}) });
      // A reading that crossed a line once waits for a second reading or a second day; one that crossed none clears it.
      if (due?.wait) {
        if (JSON.stringify(due.wait) !== JSON.stringify(held.crossing)) await state.change((draft) => { draft.crossing = due.wait; });
        return;
      }
      if (!due) {
        if (held.crossing) await state.change((draft) => { delete draft.crossing; });
        return;
      }
      const taken = await granted(budget, 'verdict refresh');
      if (!taken.ok) return;
      await state.change((draft) => { draft.refreshTried = today; draft.refreshSeen = seen; delete draft.crossing; });
      const opening = refreshOpening(held.call, numbers, due.changed);
      const messages: ModelMessage[] = [...await deps.promptFor(stage, partner.id, [], true), { role: 'user', content: refreshAsk(held.call, opening, economics, today, { ...due, goal }) }];
      // No model answered: the turn never ran, so it goes back to the day's budget, and tomorrow tries again.
      const answered = await ask(messages).catch((error: Error) => { taken.release(); throw error; });
      const reply = typeof answered === 'string' ? { text: answered } as { text: string; provider?: string; model?: string } : answered;
      const fresh = readRefresh(reply, today, `${company}\n${opening}`, economics, sectionText(company, 'Numbers'), goalsIn(company, today));
      if (!fresh) return;
      // A new call with no kill signal of its own keeps the one standing.
      const fresher = { ...fresh, ...(!fresh.signal && held.call.signal ? { signal: held.call.signal } : {}) };
      const marked = fresher.why ? { ...fresher, why: markClaims(fresher.why, [company, ...(fresher.working ?? [])]) } : fresher;
      // No stop and no wind-down for a company that is cash-positive or has more than six months, unless the founder's
      // own words asked for it (journey 16: "plan an orderly wind-down" at 11 paying against a break-even of 8).
      // The call changes only when the numbers crossed a line it stands on; a move the founder can see in a trend row
      // is not a new call (journey 18).
      const kept = keepCall(held.call, marked, numbers, due.why);
      const stopHeld = holdStop(kept.call, numbers, await founderWords(partner.id), held.call.decision);
      // The week's move is held to what the founder ruled out (journey 15: "Contact 40 more makers" minutes after "no
      // cold outreach"): one set against a standing no is dropped, and the refresh says which no it kept to.
      const ruled = stopHeld.call.move ? await saidNoFor(deps.workspace).ruledOut(stopHeld.call.move).catch(() => undefined) : undefined;
      const unguarded = ruled ? { ...stopHeld.call, move: undefined } : stopHeld.call;
      const guarded = await protectSignal(held.call, unguarded, partner.id, partner.name, true);
      const call = guarded.call;
      const at = now();
      // A kill line that moves is never silent: old → new, and a number already past the new line raises the check now.
      const moves = call.signal && (call.signal.what !== held.call.signal?.what || call.signal.by !== held.call.signal?.by);
      const killLine = moves && call.signal ? await keepSignal(held.call.signal, call.signal, partner.id, stage) : '';
      const body = breakEvenFix(figuresFix(refreshText(opening, held.call.decision, call), economics), numbers);
      const text = `${body}${kept.note ? `\n\n${kept.note}` : ''}${stopHeld.note ? `\n\n${stopHeld.note}` : ''}${killLine ? `\n\n*${killLine}*` : ''}${guarded.line ? `\n\n*${guarded.line}*` : ''}${ruled ? `\n\n*${ruledOutLine(ruled)}, so the move "${stopHeld.call.move}" was dropped.*` : ''}`;
      await deps.store.appendChat(partner.id, { id: newMessageId(), role: 'assistant', text, at, ...(reply.provider ? { provider: reply.provider } : {}), ...(reply.model ? { model: reply.model } : {}) });
      await state.change((draft) => { draft.call = keptCall(call, at, today, partner.id, numbers, guarded.line || (held.call!.signalBy === 'founder' && !killLine) ? 'founder' : 'partner'); });
      markVerdict(partner.id, at);
      standing = null;
      await deps.attention.refresh().catch(() => {});
      deps.notify?.(`${partner.name} looked at the verdict again`, text.split('\n')[0]);
    }

    // Journey 16: "replace the kill signal with fewer than 9 paying subscribers" is the founder's word, read in code and
    // kept at once with one line (server/partner/kill.ts): no model, no bet, no card asked for.
    const onAnswer: Handler<'turn:answer'> = async (payload, next) => {
      try {
        const stage = await deps.store.loadStage();
        const me = stage.rooms.find((one) => one.id === payload.roomId && one.partner);
        if (!me || payload.answer) return next(payload);
        const held = await state.read();
        const doc = await companyNow(stage);
        const company = doc ? await deps.store.readDoc(doc.id).catch(() => '') : '';
        const today = localDay(now());
        const labels = [
          ...sectionText(company, 'Numbers').split('\n').flatMap((line) => { const found = /^\s*[-*]\s+([^:]{1,40}):\s*[$€£]?\s?\d/.exec(line); return found ? [found[1].trim()] : []; }),
          ...(await readingsNow(stage).catch(() => [])).map((one) => one.label),
        ];
        const chat = await deps.store.readChat(me.id).catch(() => []);
        const lastSaid = [...chat].reverse().find((one) => one.role === 'assistant')?.text;
        const goal = goalsIn(company, today)[0];
        const asked = killAskIn(payload.query, { today, labels, signal: held.call?.signal, lastSaid, goalDay: goal?.by });
        if (!asked) return next(payload);
        const old = held.call?.signal;
        if (old && old.what === asked.signal.what && old.by === asked.signal.by) return next({ ...payload, answer: `The kill signal is already "${old.what}" by ${old.by}: nothing to change.` });
        // A line crossed already is refused, as the partner's own is, with the line that would be taken.
        const refused = crossedRefusal(asked.signal, await readingOf(stage, asked.signal).catch(() => null));
        if (refused) return next({ ...payload, answer: refused });
        const at = now();
        // The partner's proposal to move the line the founder just replaced is answered by this: it leaves Needs you.
        const proposal = held.killProposal;
        if (proposal && (await deps.decisions.list().catch(() => [])).some((one) => one.id === proposal.decisionId && one.status === 'proposed')) await deps.decisions.remove(proposal.decisionId).catch(() => {});
        await state.change((draft) => { draft.call = { ...(draft.call ?? { day: today, roomId: me.id, at }), signal: asked.signal, signalBy: 'founder' }; delete draft.killProposal; });
        const line = await keepSignal(old, asked.signal, me.id, stage);
        standing = null;
        return next({ ...payload, answer: line });
      } catch (error) {
        console.error(`partner kill signal: ${(error as Error).message}`);
        return next(payload);
      }
    };
    const offAnswer = deps.seams.on('turn:answer', onAnswer);

    return {
      tools: [...betTools(book, deps.workspace, betsChanged, now), ...planTools(state, async () => { await deps.attention.refresh().catch(() => {}); }, now)],
      // Closing a bet is the partner's alone; offering tasks needs a board on the stage.
      offer(tools, stage, roomId) {
        const partner = stage.rooms.find((one) => one.id === roomId)?.partner;
        const board = (stage.cards ?? []).some((card) => card.kind === 'board');
        return tools.filter((tool) => (partner || !PARTNER_TOOLS.includes(tool.name)) && (board || !BOARD_TOOLS.includes(tool.name)));
      },
      async tick() {
        // The standing facts are gathered again at most once a tick.
        standing = null;
        // The day a partner first shows up is noted, so their first note is the next morning's.
        const arrived = partnerOf(await deps.store.loadStage());
        if (arrived && !(await state.read()).partnerSince) await state.change((draft) => { draft.partnerSince = localDay(now()); });
        await keepCompany();
        await sync();
        await checkBets();
        await chasePromises();
        await morning(false);
        if (watchOnTick) await watch.look();
        // ---- the partner's unasked judgement: colleagues' docs reviewed, the verdict refreshed (partner/review.ts,
        // partner/refresh.ts). Their own ticks, called here; nothing else of the watch's triggers lives here.
        await reviews.tick(partnerOf(await deps.store.loadStage())).catch((error: Error) => console.error(`partner review: ${error.message}`));
        await refreshVerdict().catch((error: Error) => console.error(`partner refresh: ${error.message}`));
      },
      async route(req, res, path) {
        if (!path.startsWith('/api/partner')) return false;
        const method = req.method ?? 'GET';
        try {
          if (path === '/api/partner' && method === 'GET') {
            const stage = await deps.store.loadStage();
            const partner = partnerOf(stage);
            const held = await state.read();
            deps.json(res, 200, { partner: partner ? { roomId: partner.id, name: partner.name } : null, companyId: (await companyNow(stage))?.id ?? null, morning: held.morning ?? null, bets: await bets() });
            return true;
          }
          // The window put a partner and a Company doc down: the doc is given its sections, and its id handed back.
          // Asked for outright ("add partner"), it is made again even after the founder removed it.
          if (path === '/api/partner/company' && method === 'POST') {
            const sent = await deps.body(req);
            const made = await adopt(typeof sent?.id === 'string' ? sent.id : undefined);
            deps.json(res, 200, { ...made, hasIdea: saysSomething(await deps.store.readDoc(made.id)) });
            return true;
          }
          // "Morning note" from the command bar: today's, written now if there is none yet.
          if (path === '/api/partner/morning' && method === 'POST') {
            if (!partnerOf(await deps.store.loadStage())) { deps.json(res, 409, { error: 'Add your partner first: type "add partner".' }); return true; }
            const note = await morning(true);
            if (!note) { deps.json(res, 503, { error: 'Your partner could not write the note just now. Try again in a minute.' }); return true; }
            deps.json(res, 200, note);
            return true;
          }
          const bet = /^\/api\/partner\/bets\/(bet-[a-z0-9-]{1,40})(\/close)?$/.exec(path);
          if (bet && method === 'POST') {
            const sent = await deps.body(req);
            if (!bet[2]) {
              const taking = sent?.accept === true ? (await book.list()).find((one) => one.id === bet[1] && one.status === 'proposed') : undefined;
              const stage = await deps.store.loadStage();
              if (taking?.brief && (await readMetric(deps.workspace, stage, taking.metric)).value === null) {
                // The brief as it stands now, in case the founder changed the number since the bet was put.
                const row = await briefNumber(stage, deps.store, taking.metric).catch(() => null) ?? taking.brief as BriefRow;
                await metricsFromBrief(deps.workspace, deps.store, row, partnerOf(stage)?.id ?? taking.roomId, now(), { value: taking.target, by: taking.checkDate });
              }
              // Declined: kept as a no, so the same bet is not put to the founder again as if it were new.
              const leaving = sent?.accept === true ? undefined : (await book.list()).find((one) => one.id === bet[1] && one.status === 'proposed');
              await book.answer(bet[1], sent?.accept === true);
              if (leaving) await saidNoFor(deps.workspace).record({ tool: 'propose_bet', subject: leaving.what, ...(leaving.proposedBy ? { who: leaving.proposedBy } : {}), ...(typeof sent?.reason === 'string' ? { reason: sent.reason } : {}) }).catch(() => {});
              await betsChanged(); deps.json(res, 200, { ok: true }); return true;
            }
            const verdict = VERDICTS.includes(sent?.verdict) ? sent.verdict as BetVerdict : null;
            if (!verdict) { deps.json(res, 400, { error: 'say whether it worked' }); return true; }
            const held = (await book.list()).find((one) => one.id === bet[1]);
            if (!held) { deps.json(res, 404, { error: 'there is no bet by that name' }); return true; }
            const reading = await readMetric(deps.workspace, await deps.store.loadStage(), held.metric);
            const closed = await book.close(held.id, { verdict, value: reading.value, note: typeof sent?.note === 'string' ? sent.note.slice(0, 300) : '', by: 'Founder' });
            await betsChanged();
            deps.json(res, 200, closed);
            return true;
          }
          // The founder answers a review flag from Needs you: Fix hands the window the ask to send in the colleague's
          // room, Ignore lets it go. The row goes either way.
          const reviewed = /^\/api\/partner\/reviews\/([A-Za-z0-9_-]{1,120})$/.exec(path);
          if (reviewed && method === 'POST') {
            const sent = await deps.body(req);
            const found = await reviews.answer(reviewed[1]);
            if (!found) { deps.json(res, 404, { error: 'that review is no longer waiting' }); return true; }
            await deps.attention.refresh();
            deps.json(res, 200, sent?.fix === true ? { ok: true, roomId: found.roomId, ask: found.ask } : { ok: true });
            return true;
          }
          // The watch, looked at now: what it raised and what waits for tomorrow's budget.
          if (path === '/api/partner/watch' && method === 'POST') { deps.json(res, 200, await watch.look()); return true; }
          if (path === '/api/partner/watch' && method === 'GET') { const held = await watch.read(); deps.json(res, 200, { proposals: held.proposals, waiting: held.waiting }); return true; }
          // A move the partner proposed unasked: Run does its ready thing, Don't lets it go.
          const proposed = /^\/api\/partner\/proposals\/([a-z]+-[a-z0-9]+-\d+)$/.exec(path);
          if (proposed && method === 'POST') {
            const sent = await deps.body(req);
            deps.json(res, 200, await watch.answer(proposed[1], sent?.run === true));
            return true;
          }
          // The founder closes a promise from Needs you: done, or dropped.
          const promised = /^\/api\/partner\/promises\/(promise-[a-z0-9-]{1,40})$/.exec(path);
          if (promised && method === 'POST') {
            const sent = await deps.body(req);
            const closed = await promises.close(promised[1], sent?.done !== false);
            standing = null;
            await deps.attention.refresh();
            deps.json(res, 200, closed);
            return true;
          }
          const plan = /^\/api\/partner\/plans\/(plan-[a-z0-9-]{1,40})$/.exec(path);
          if (plan && method === 'POST') {
            const sent = await deps.body(req);
            const held = (await state.read()).plans.find((one) => one.id === plan[1]);
            if (!held) { deps.json(res, 404, { error: 'that plan is no longer waiting' }); return true; }
            const accept = sent?.accept === true;
            // No board yet: said plainly, and the plan waits, unless the founder asked for a board to be made for it.
            if (accept && !boardFor(await deps.store.loadStage(), held.roomId)) {
              if (sent?.makeBoard !== true) { deps.json(res, 409, { error: NO_BOARD, noBoard: true }); return true; }
              await boardForPlan(deps.store, held.roomId);
            }
            const made = accept ? await addPlan(deps.boards, await deps.store.loadStage(), held) : null;
            if (!accept) await saidNoFor(deps.workspace).record({ tool: 'propose_tasks', subject: held.title, who: held.who, ...(typeof sent?.reason === 'string' ? { reason: sent.reason } : {}) }).catch(() => {});
            await state.change((draft) => { draft.plans = draft.plans.filter((one) => one.id !== held.id); });
            standing = null;
            await deps.attention.refresh();
            deps.json(res, 200, { ok: true, ...(made ?? {}) });
            return true;
          }
          if (path === '/api/partner/morning/done' && method === 'POST') {
            await state.change((draft) => { if (draft.morning) draft.morningDone = draft.morning.day; });
            await deps.attention.refresh();
            deps.json(res, 200, { ok: true });
            return true;
          }
        } catch (error) { deps.json(res, 400, { error: (error as Error).message }); return true; }
        return false;
      },
      async close() {
        offDecisions();
        offSeam();
        offTurn(); offAnswer();
        offReply();
        offPromise();
        offReviews();
        await reviews.settled();
        await syncing?.catch(() => {});
        await writing?.catch(() => {});
        await state.settled();
        await book.settled();
        await promises.settled();
        await watch.settled();
      },
    };
  };
}

export default { name: 'partner', install: createPartner() } satisfies Slice;
