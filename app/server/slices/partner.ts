import { isDay } from '../../shared/metrics.ts';
import { newMessageId, type Attention, type Stage } from '../../shared/model.ts';
import { bare, companyLine, isPlanDoc, SHARED_RECORD, parsePlan, PARTNER_CHANNEL, planStepLine, type Bet, type BetVerdict, type MorningNote, type PlanStep } from '../../shared/partner.ts';
import { localDay } from '../clock.ts';
import type { Deps, Installed, Slice } from '../install.ts';
import { leadsFor } from '../leads/store.ts';
import { askedInstead, betDue, betsAttention, betsBook, cannotLose, closedLine, metricChoices, missingMetric, readMetric, type BetsBook } from '../partner/bets.ts';
import { companyDocOf, ensureCompany, syncDecisions, writeBets } from '../partner/company.ts';
import { hub } from '../events.ts';
import { saysSomething } from '../missions.ts';
import { FAKE_MORNING, MOST_TRIES, morningDue, morningInputs, morningMessage, writeMorning, type MorningSources } from '../partner/morning.ts';
import { addPlan, boardFor, boardForPlan, NO_BOARD, planAttention, stepsFrom } from '../partner/plans.ts';
import { partnerState, type PartnerStateBook } from '../partner/state.ts';
import { standingBlock, standingParts, type StandingParts } from '../partner/standing.ts';
import { companyFacts, keepFacts, keptLine } from '../partner/keep.ts';
import { wired } from '../prompt.ts';
import type { ModelMessage } from '../prompt.ts';
import { complete, fakeClient, promptSize } from '../providers.ts';
import { partnerRoute } from '../partner/route.ts';
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
export function betTools(book: BetsBook, workspace: string, changed: () => Promise<void>, now: () => number = Date.now): Tool[] {
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
        if (!choices.some((one) => one.toLowerCase() === metric.toLowerCase()) && (await readMetric(workspace, context.stage, metric)).value === null) {
          throw new Error(missingMetric(context.stage, metric, choices));
        }
        // A target the number already meets is no bet: it is refused with the number as it stands.
        const lose = cannotLose(metric, target, await readMetric(workspace, context.stage, metric));
        if (lose) throw new Error(lose);
        const me = speaker(context);
        const bet = await book.propose({ what: bare(text(args, 'what', 160)), hypothesis: typeof args.hypothesis === 'string' ? args.hypothesis.replace(/\s+/g, ' ').trim().slice(0, 400) : '', metric, target, checkDate, ...(me ? { proposedBy: me.name, roomId: me.id } : {}) });
        await changed();
        return { text: `Proposed the bet "${bet.what}" (${bet.metric} to ${bet.target} by ${bet.checkDate}). It waits in Needs you; it is not on record until the founder takes it.` };
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

export function planTools(state: PartnerStateBook, changed: () => Promise<void>, now: () => number = Date.now): Tool[] {
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
export type PartnerOptions = { now?: () => number; ask?: (messages: ModelMessage[]) => Promise<string | { text: string; provider?: string; model?: string }> };

export function createPartner(options: PartnerOptions = {}) {
  const now = options.now ?? Date.now;
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
    if (makeAtStart && !(await state.read()).companyId) await adopt().catch((error: Error) => console.error(`partner: ${error.message}`));
    // The document as it is now: the recorded one if it is still on the stage (renamed or not), nothing once the
    // founder took it away, and a pinned company doc by its title only while nothing has been recorded.
    const companyNow = async (stage?: Stage) => {
      const on = stage ?? await deps.store.loadStage();
      const { companyId } = await state.read();
      return companyId ? companyDocOf(on, companyId) : companyDocOf(on);
    };
    // The morning turn spends a model call every day, so a fake run (the browser tests) only takes one when asked:
    // STAGE_PARTNER_MORNING=1, or the founder's own "morning note".
    const morningOnTick = !deps.fake || process.env.STAGE_PARTNER_MORNING === '1';
    const book = betsBook(deps.workspace, now);
    const bets = (): Promise<Bet[]> => book.list();
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
    const offDecisions = deps.decisions.onChange(() => { standing = null; void sync().catch(() => {}); });

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

    const ask = options.ask ?? (deps.fake ? async () => ({ text: FAKE_MORNING, provider: fakeClient.name, model: fakeClient.model }) : async (messages: ModelMessage[]) => {
      const { order } = partnerRoute(deps.clients, deps.usage, { promptChars: promptSize(messages), tools: false });
      // Nothing is shown while the note is written, so a stream that breaks part way goes straight to the next model.
      const reply = await complete(messages, { onToken: () => {}, onRestart: () => {} }, order, ({ client, error }) => deps.usage.failed(client.name, error), (client) => deps.usage.admit(client.name));
      if (!reply.reported) deps.usage.record(reply.client.name, reply.usage, reply.quota);
      return { text: reply.text, provider: reply.client.name, model: reply.client.model };
    });

    // Today's note, written now if it is due (or asked for), else the one already written, else null.
    let writing: Promise<(MorningNote & { unchanged?: true }) | null> | null = null;
    // Everything the partner reads across the rooms, as it stands now: the morning note and the standing facts both
    // read from this.
    const sourcesFor = (stage: Stage, partnerId: string, company: string): MorningSources => ({
      workspace: deps.workspace, stage, partnerId, now: now(), bets, company,
      decisions: () => deps.decisions.list(), boards: (id) => deps.boards.list(id), leads: (id) => leadsFor(deps.workspace).list(id),
      chat: (roomId) => deps.store.readChat(roomId), doc: (id) => deps.store.readDoc(id),
    });
    // The standing facts, gathered once and kept until the next tick or until something they read changes (a bet, a
    // decision, a write by a tool). What waits in Needs you is read fresh every turn.
    let standing: Promise<StandingParts> | null = null;
    async function standingFor(stage: Stage, partnerId: string) {
      if (!standing) {
        const doc = await companyNow(stage);
        const gathering = standingParts(sourcesFor(stage, partnerId, doc ? await deps.store.readDoc(doc.id).catch(() => '') : ''));
        standing = gathering;
        gathering.catch(() => { if (standing === gathering) standing = null; });
      }
      const [parts, waiting] = await Promise.all([standing, deps.attention.list().catch(() => [])]);
      return standingBlock(parts, waiting);
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
        if (!asked && (!morningOnTick || !morningDue(held, at))) return null;
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
        deps.notify?.(`Morning note from ${partner.name}`, note.things[0]);
        return note;
      } finally { writing = null; }
    })());

    // What waits for the founder: today's note until they say they have read it.
    deps.attention.source(async (): Promise<Attention[]> => {
      const held = await state.read();
      const note = held.morning;
      const found: Attention[] = [];
      if (note && note.day === localDay(now()) && held.morningDone !== note.day) {
        // The first move is the title; the other moves, the risk and the question follow in the row itself.
        const rest = note.things.slice(1).map((thing, index) => `${index + 2}. ${thing}`).join(' ');
        found.push({ id: `morning-note:${note.day}`, kind: 'morning-note', title: `Morning note: ${note.things[0]}`, detail: `${rest ? `${rest} ` : ''}Risk: ${note.risk} Question: ${note.question}`, at: note.at, who: note.who, roomId: note.roomId });
      }
      return [...found, ...planAttention(held.plans), ...await betsAttention(await book.list(), await deps.store.loadStage(), deps.workspace, localDay(now()))];
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
        const block = await standingFor(stage, payload.roomId).catch((error: Error) => { console.error(`partner standing facts: ${error.message}`); return ''; });
        out = withSystem(out, block);
      }
      return next(out);
    };
    const offTurn = deps.seams.on('turn:before', beforeTurn);

    // The founder told the partner where the company stands (a price, the cash, the burn, the users, what it does):
    // it goes into the Company document's own section, with a receipt under the reply. Never with the wire taken away.
    const onReply: Handler<'turn:reply'> = async (payload, next) => {
      const stage = await deps.store.loadStage();
      const me = stage.rooms.find((one) => one.id === payload.roomId && one.partner);
      const facts = companyFacts(payload.query);
      if (!me || payload.reply.stopped || (!facts.numbers.length && !facts.idea && !facts.customer)) return next(payload);
      let line = '';
      try {
        const doc = await companyNow(stage);
        if (doc) {
          const before = await deps.store.readDoc(doc.id);
          const kept = keepFacts(before, facts, localDay(now()));
          if (kept.kept.length && wired(stage, me.id, [doc.id]).length) {
            await deps.store.writeDoc(doc.id, kept.text);
            changed(doc.id);
            standing = null;
            line = keptLine(kept.kept);
          } else if (kept.kept.length) line = `*Not kept: the "${doc.title}" document is not wired to ${me.name}, so ${kept.kept.join(', ')} are not in it. Wire it to ${me.name} to keep it current.*`;
        }
      } catch (error) { console.error(`partner keep: ${(error as Error).message}`); }
      return next(line ? { ...payload, reply: { ...payload.reply, text: `${payload.reply.text.replace(/\s+$/, '')}\n\n${line}` } } : payload);
    };
    const offReply = deps.seams.on('turn:reply', onReply);

    // Which bets were due at the last look, so a bet whose day has just come is said once, not every half minute.
    let due: Set<string> | null = null;
    async function checkBets() {
      const today = localDay(now());
      const list = (await book.list()).filter((bet) => betDue(bet, today));
      const fresh = due ? list.filter((bet) => !due!.has(bet.id)) : [];
      due = new Set(list.map((bet) => bet.id));
      if (!fresh.length) return;
      await deps.attention.refresh().catch(() => {});
      deps.notify?.('A bet is due for a check', fresh[0].what);
    }

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
        await morning(false);
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
            if (!bet[2]) { await book.answer(bet[1], sent?.accept === true); await betsChanged(); deps.json(res, 200, { ok: true }); return true; }
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
        offTurn();
        offReply();
        await syncing?.catch(() => {});
        await writing?.catch(() => {});
        await state.settled();
        await book.settled();
      },
    };
  };
}

export default { name: 'partner', install: createPartner() } satisfies Slice;
