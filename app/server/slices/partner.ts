import { newMessageId, type Attention, type Stage } from '../../shared/model.ts';
import type { Bet, MorningNote } from '../../shared/partner.ts';
import { localDay } from '../clock.ts';
import type { Deps, Installed, Slice } from '../install.ts';
import { leadsFor } from '../leads/store.ts';
import { companyDocOf, ensureCompany, syncDecisions } from '../partner/company.ts';
import { FAKE_MORNING, morningDue, morningMessage, writeMorning } from '../partner/morning.ts';
import { partnerState } from '../partner/state.ts';
import type { ModelMessage } from '../prompt.ts';
import { complete, promptSize } from '../providers.ts';
import { route as routeModels } from '../router.ts';
import { patchStageVia } from '../slice-kit.ts';

// The partner: one person who holds the whole company rather than one part of it, and the things that make that
// true. The Company document is the shared record every person reads; decisions land in it as they are made. Once a
// day the partner looks at the company unasked and leaves a morning note in Needs you, first in Today's five.
// Nothing here runs while the app is closed.

// The founder's partner, if one is on the stage: the first person marked so.
export const partnerOf = (stage: Stage) => stage.rooms.find((room) => room.partner);

// What a test hands in instead of the clock and the model.
export type PartnerOptions = { now?: () => number; ask?: (messages: ModelMessage[]) => Promise<string> };

export function createPartner(options: PartnerOptions = {}) {
  const now = options.now ?? Date.now;
  return async function install(deps: Deps): Promise<Installed> {
    const state = partnerState(deps.workspace);
    // The document is made at start on a real run. A fake run leaves the stage as the browser tests expect it unless
    // it is asked to (STAGE_PARTNER=1), or until a partner is added.
    const makeAtStart = !deps.fake || process.env.STAGE_PARTNER === '1';
    if (makeAtStart) await ensureCompany(deps.store).catch((error: Error) => console.error(`partner: ${error.message}`));
    // The morning turn spends a model call every day, so a fake run (the browser tests) only takes one when asked:
    // STAGE_PARTNER_MORNING=1, or the founder's own "morning note".
    const morningOnTick = !deps.fake || process.env.STAGE_PARTNER_MORNING === '1';
    const bets = async (): Promise<Bet[]> => [];

    // Decided decisions go into the Company document, each once.
    let syncing: Promise<void> | null = null;
    const sync = () => (syncing ??= (async () => {
      try {
        const doc = companyDocOf(await deps.store.loadStage());
        if (!doc) return;
        const list = await deps.decisions.list();
        await state.change(async (held) => { held.decided = await syncDecisions(deps.store, doc.id, list, held.decided); });
      } finally { syncing = null; }
    })());
    const offDecisions = deps.decisions.onChange(() => { void sync().catch(() => {}); });

    // A partner on the stage owns the Company document: it is made if missing and wired to them, so they can write it.
    async function keepCompany() {
      const stage = await deps.store.loadStage();
      const partner = partnerOf(stage);
      if (!partner) return;
      const { id } = await ensureCompany(deps.store);
      await patchStageVia(deps.store, (draft) => {
        if (draft.wires.some((wire) => (wire.from === partner.id && wire.to === id) || (wire.to === partner.id && wire.from === id))) return;
        draft.wires.push({ id: `${partner.id}-${id}`, from: partner.id, fromHandle: 'r', to: id, toHandle: 'l' });
      });
    }

    // ------------------------------------------------------------ the morning turn

    const ask = options.ask ?? (deps.fake ? async () => FAKE_MORNING : async (messages: ModelMessage[]) => {
      const { order } = routeModels(deps.clients, deps.usage, { promptChars: promptSize(messages), tools: false });
      const reply = await complete(messages, { onToken: () => {} }, order);
      deps.usage.record(reply.client.name, reply.usage, reply.quota);
      return reply.text;
    });

    // Today's note, written now if it is due (or asked for), else the one already written, else null.
    let writing: Promise<MorningNote | null> | null = null;
    const morning = (asked: boolean) => (writing ??= (async () => {
      try {
        const at = now();
        const today = localDay(at);
        const held = await state.read();
        if (held.morning?.day === today) return held.morning;
        if (!asked && (!morningOnTick || !morningDue(held, at))) return null;
        const stage = await deps.store.loadStage();
        const partner = partnerOf(stage);
        // Never beside a turn of their own: the note would land in the middle of what they are saying.
        if (!partner || deps.busy.has(partner.id)) return null;
        const count = held.tries?.day === today ? held.tries.count : 0;
        await state.change((draft) => { draft.tries = { day: today, count: count + 1, last: at }; });
        const note = await writeMorning({
          name: partner.name, ask,
          promptFor: (on, roomId) => deps.promptFor(on, roomId, [], true),
          sources: {
            workspace: deps.workspace, stage, partnerId: partner.id, now: at, bets,
            decisions: () => deps.decisions.list(), boards: (id) => deps.boards.list(id), leads: (id) => leadsFor(deps.workspace).list(id),
            chat: (roomId) => deps.store.readChat(roomId),
          },
        }).catch((error: Error) => { console.error(`partner morning: ${error.message}`); return null; });
        if (!note) return null;
        await state.change((draft) => { draft.morning = note; });
        await deps.store.appendChat(partner.id, { id: newMessageId(), role: 'assistant', text: morningMessage(note), at: note.at });
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
        found.push({ id: `morning-note:${note.day}`, kind: 'morning-note', title: `Morning note: ${note.things[0]}`, detail: `Risk: ${note.risk} Question: ${note.question}`, at: note.at, who: note.who, roomId: note.roomId });
      }
      return found;
    });

    return {
      async tick() {
        await keepCompany();
        await sync();
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
            deps.json(res, 200, { partner: partner ? { roomId: partner.id, name: partner.name } : null, companyId: companyDocOf(stage)?.id ?? null, morning: held.morning ?? null, bets: await bets() });
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
        await syncing?.catch(() => {});
        await writing?.catch(() => {});
        await state.settled();
      },
    };
  };
}

export default { name: 'partner', install: createPartner() } satisfies Slice;
