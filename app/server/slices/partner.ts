import type { Stage } from '../../shared/model.ts';
import type { Slice } from '../install.ts';
import { companyDocOf, ensureCompany, syncDecisions } from '../partner/company.ts';
import { partnerState } from '../partner/state.ts';
import { patchStageVia } from '../slice-kit.ts';

// The partner: one person who holds the whole company rather than one part of it, and the things that make that
// true. The Company document is the shared record every person reads; decisions land in it as they are made.

// The founder's partner, if one is on the stage: the first person marked so.
export const partnerOf = (stage: Stage) => stage.rooms.find((room) => room.partner);

export default {
  name: 'partner',
  async install(deps) {
    const state = partnerState(deps.workspace);
    // The document is made at start on a real run. A fake run leaves the stage as the browser tests expect it unless
    // it is asked to (STAGE_PARTNER=1), or until a partner is added.
    const makeAtStart = !deps.fake || process.env.STAGE_PARTNER === '1';
    if (makeAtStart) await ensureCompany(deps.store).catch((error: Error) => console.error(`partner: ${error.message}`));

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

    return {
      async tick() {
        await keepCompany();
        await sync();
      },
      async close() {
        offDecisions();
        await syncing?.catch(() => {});
        await state.settled();
      },
    };
  },
} satisfies Slice;
