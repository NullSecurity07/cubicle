import type { Lapsed } from '../shared/lapsed.ts';
import type { AttentionBook } from './attention.ts';
import type { Handler } from './seams.ts';

// An approval the app closed on stops being worth the founder's time the moment they and that person have moved past
// it, and two things at the end of a turn say they have. Either the tool it was waiting on has just run and worked, so
// the thing it asked about is done; or the founder started this turn themselves, so they have seen that person and
// asked for whatever they want now — the old prompt has done its job, and it only ever said "ask them again" anyway.
// (Every lapsed approval is older than this turn: one raised in a turn that is still alive is cleared when it is
// answered, and lapsed is only ever set when the file is read at startup.)
// A turn the founder stopped says nothing either way, so it leaves the list alone. Only the room the turn happened in
// is tidied: what Sam and the founder settled between them is no word at all on what Maya is still waiting to hear.
export const tidyLapsed = (attention: AttentionBook): Handler<'turn:after'> => async (payload, next) => {
  const { roomId, source, reply } = payload;
  if (!reply.stopped) {
    const worked = new Set(reply.tools.filter((tool) => tool.ok === true).map((tool) => tool.name));
    for (const entry of (await attention.list()) as Lapsed[]) {
      if (entry.kind !== 'approval' || !entry.lapsed || entry.roomId !== roomId) continue;
      if (source === 'chat' || (entry.tool && worked.has(entry.tool))) await attention.clear(entry.id);
    }
  }
  return next(payload);
};
