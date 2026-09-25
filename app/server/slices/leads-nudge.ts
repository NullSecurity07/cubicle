import { leadName } from '../../shared/leads.ts';
import { nudgeAsk, nudgeDetail, nudgeId, nudgeTitle, readNudgeId, staleDays, staleFrom } from '../../shared/leads-nudge.ts';
import type { Attention, Stage } from '../../shared/model.ts';
import type { Slice } from '../install.ts';
import { dismiss, enteredAt, observe, readBook, writeBook, type LeadBook } from '../leads/moves.ts';
import { leadsCardIds, leadsFor } from '../leads/store.ts';
import { wired } from '../prompt.ts';

// Follow-up nudges on the Leads card, as a slice of its own so the card itself is not touched. Every half minute it
// looks at every Leads card: it writes down stage moves, raises one nudge when a lead goes quiet where a message is
// owed (Contacted for five days, Replied or Meeting for three) and closes it once the lead is written about or moves
// on. Needs you shows each open one with a button that asks the wired person to draft the message.

// The person who drafts: the first one wired to the card, the way "Draft first message" defaults.
const drafterOf = (stage: Stage, cardId: string) => {
  const ids = wired(stage, cardId, stage.rooms.map((room) => room.id));
  return stage.rooms.find((room) => room.id === ids[0]);
};

export default {
  name: 'leads-nudge',
  // After the Leads card, whose store this reads: the first to ask for it decides who hears its changes.
  order: 110,
  install(deps) {
    let book: LeadBook | null = null;
    let running: Promise<{ book: LeadBook; changed: boolean }> | null = null;

    // One look at every card, one at a time however many ask at once.
    async function sweep(now = Date.now()) {
      running ??= (async () => {
        try {
          book ??= await readBook(deps.workspace);
          const stage = await deps.store.loadStage();
          const leads = leadsFor(deps.workspace);
          let changed = false;
          for (const cardId of leadsCardIds(stage)) if (observe(book, cardId, await leads.list(cardId), now)) changed = true;
          if (changed) await writeBook(deps.workspace, book);
          return { book, changed };
        } finally { running = null; }
      })();
      return running;
    }

    // Every nudge that is open: raised, still quiet, not over.
    async function open(): Promise<Attention[]> {
      const now = Date.now();
      const { book } = await sweep(now);
      const stage = await deps.store.loadStage();
      const found: Attention[] = [];
      for (const cardId of leadsCardIds(stage)) {
        const drafter = drafterOf(stage, cardId);
        for (const lead of await leadsFor(deps.workspace).list(cardId)) {
          const id = nudgeId(cardId, lead.id, lead.stage);
          if (!(id in book.raised)) continue;
          const since = enteredAt(book, cardId, lead);
          const quiet = staleDays(lead, since, now);
          if (quiet === null) continue;
          found.push({ id, kind: 'lead-stale', cardId, title: nudgeTitle(lead, since, now), detail: nudgeDetail(quiet), at: Math.min(now, staleFrom(lead, since)), ...(drafter ? { roomId: drafter.id } : {}) });
        }
      }
      return found;
    }
    deps.attention?.source(open);

    return {
      async tick() { if ((await sweep()).changed) await deps.attention.refresh(); },
      async route(req, res, path) {
        if (req.method !== 'POST' || (path !== '/api/nudges/dismiss' && path !== '/api/nudges/ask')) return false;
        const id = String((await deps.body(req))?.id ?? '');
        const named = readNudgeId(id);
        if (!named) { deps.json(res, 400, { error: 'that is not a follow-up nudge' }); return true; }
        if (path === '/api/nudges/dismiss') {
          const { book } = await sweep();
          if (dismiss(book, id)) await writeBook(deps.workspace, book);
          await deps.attention.refresh();
          deps.json(res, 200, { ok: true });
          return true;
        }
        // The words for the person, worked out here so they match the lead as it is now.
        const stage = await deps.store.loadStage();
        const drafter = drafterOf(stage, named.cardId);
        if (!drafter) { deps.json(res, 409, { error: 'Wire a person to the Leads card first, and they will draft it.' }); return true; }
        const lead = (await leadsFor(deps.workspace).list(named.cardId)).find((one) => one.id === named.leadId);
        if (!lead) { deps.json(res, 404, { error: 'that lead is no longer on the card' }); return true; }
        const { book } = await sweep();
        deps.json(res, 200, { roomId: drafter.id, name: drafter.name, lead: leadName(lead), text: nudgeAsk(lead, enteredAt(book, named.cardId, lead), Date.now()) });
        return true;
      },
    };
  },
} satisfies Slice;
