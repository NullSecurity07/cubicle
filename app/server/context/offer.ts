import type { Card, Stage } from '../../shared/model.ts';
import { sourceCards } from '../../shared/sources.ts';
import { colleagueIds, wired, wiredDocIds } from '../prompt.ts';
import type { Tool } from '../tools/registry.ts';

// What one room can reach: the kinds of card wired to it, whether it may write a document, whether anybody is there
// to ask, whether there is a trusted website anywhere on the stage to search inside. Worked out once, because a turn
// asks this of every tool on the list.
// `docs` is also true when the person may make a document this turn: one made with create_doc is theirs to write and
// add to straight away, and a room with nothing wired to it is exactly where that happens. The doc tools themselves
// still refuse any document that is neither wired to the person nor made by them in this turn.
type Reach = { kinds: Set<Card['kind']>; docs: boolean; colleagues: boolean; sources: boolean };

const reachOf = (stage: Stage, roomId: string, tools: Tool[]): Reach => {
  const cards = stage.cards ?? [];
  const mine = new Set(wired(stage, roomId, cards.map((card) => card.id)));
  return {
    kinds: new Set(cards.filter((card) => mine.has(card.id)).map((card) => card.kind)),
    docs: wiredDocIds(stage, roomId).length > 0 || tools.some((tool) => tool.name === 'create_doc'),
    colleagues: colleagueIds(stage, roomId).length > 0,
    sources: sourceCards(cards).length > 0,
  };
};

// What a tool needs before it is worth describing to anybody. Two tool calls in a bare room cost 15,900 input tokens
// on the live check, most of it schemas for studios and boards that were not there — a person cannot use a video
// studio nobody wired to them, and reading about one costs the same as using it.
// Everything left out of this list is always offered: searching and reading the web, the shared files, remember,
// recall, the decisions, use_skill, note_founder, running code, creating a document — and whatever a later feature
// adds, because a rule written here can only ever take away a tool it knows by name.
const NEEDS: Record<string, (reach: Reach, tool: Tool) => boolean> = {
  code_task: (reach) => reach.kinds.has('project'),
  code_reply: (reach) => reach.kinds.has('project'),
  code_stop: (reach) => reach.kinds.has('project'),
  code_status: (reach) => reach.kinds.has('project'),
  browse: (reach) => reach.kinds.has('browser'),
  generate_image: (reach) => reach.kinds.has('imagegen'),
  generate_voice: (reach) => reach.kinds.has('voicegen'),
  generate_video: (reach) => reach.kinds.has('videogen'),
  edit_video: (reach) => reach.kinds.has('videogen'),
  propose_task: (reach) => reach.kinds.has('board'),
  list_tasks: (reach) => reach.kinds.has('board'),
  ask_person: (reach) => reach.colleagues,
  read_doc: (reach) => reach.docs,
  write_doc: (reach) => reach.docs,
  append_doc: (reach) => reach.docs,
  // A source is searched whether or not it is wired to anybody; with none on the stage the call can only fail.
  search_source: (reach) => reach.sources,
  // Mail is the one that is not on the stage: a tool that already knows it cannot work is not worth a schema either.
  send_email: (_reach, tool) => !tool.ready?.(),
  read_inbox: (_reach, tool) => !tool.ready?.(),
};

export function offered(tools: Tool[], stage: Stage, roomId: string): Tool[] {
  const reach = reachOf(stage, roomId, tools);
  return tools.filter((tool) => NEEDS[tool.name]?.(reach, tool) ?? true);
}
