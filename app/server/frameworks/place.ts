import type { Case, DocSpec, Framework, Placed, RoomSpec, Spot } from '../../shared/frameworks.ts';
import { DOC_SIZE, frameworkId, slugOf } from '../../shared/frameworks.ts';
import type { Box, Card, Doc, Room, Stage, Wire } from '../../shared/model.ts';

// Putting a framework on the stage, and taking one off it again. Both directions live here, next to each other, so
// what is written down when a team is saved and what is read back when it is placed can never drift apart.

// The id rule the store holds every room, doc and card to. An id that does not pass it cannot be saved at all, so
// everything minted here is checked against it rather than trusted.
const STAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STEM = 48;
const short = () => Math.random().toString(36).slice(2, 6);
const stemOf = (key: string) => slugOf(key).slice(0, STEM) || 'one';

// A name nothing in `used` has yet. `tail` says what to add when the plain one is taken; after a few tries it counts
// instead of guessing, so a tail that keeps saying the same thing still ends.
function unique(stem: string, used: Set<string>, tail: (tries: number) => string): string {
  let name = stem;
  for (let tries = 1; used.has(name); tries += 1) name = `${stem}-${tail(tries)}`;
  used.add(name);
  return name;
}

// An id for each of a framework's keys that nothing on this stage is called, and that the store will accept. The key
// itself is used when it is free, because "assumption" on the canvas is worth more to the founder than a random word.
export function mintIds(keys: string[], taken: Iterable<string>, rand: () => string = short): Map<string, string> {
  const used = new Set(taken);
  const ids = new Map<string, string>();
  for (const key of keys) {
    const stem = stemOf(key);
    const id = unique(STAGE_ID.test(stem) ? stem : 'one', used, (tries) => (tries <= 5 ? rand() : String(tries)));
    ids.set(key, id);
  }
  return ids;
}

const middle = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
// Which side of each card a wire leaves and arrives on. A framework's layout is the drawing the founder is about to
// see, so the wires are hung the way that drawing reads: across when the two sit side by side, down when one is
// above the other. Nothing else on the stage is wired any differently — these are the same four handles.
export function handlesFor(from: Box, to: Box): { fromHandle: string; toHandle: string } {
  const [one, other] = [middle(from), middle(to)];
  const [dx, dy] = [other.x - one.x, other.y - one.y];
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? { fromHandle: 'r', toHandle: 'l' } : { fromHandle: 'l', toHandle: 'r' };
  return dy >= 0 ? { fromHandle: 'b', toHandle: 't' } : { fromHandle: 't', toHandle: 'b' };
}

// The framework as a piece of stage: fresh ids, every position offset from `at`, and the words each doc starts with.
// The caller writes those words and merges the rest; nothing here touches the workspace.
export function place(framework: Framework, stage: Pick<Stage, 'rooms' | 'docs' | 'cards'>, at: Spot): { placed: Placed; texts: Record<string, string> } {
  const keys = [...framework.rooms, ...framework.docs, ...framework.cards].map((one) => one.key);
  const ids = mintIds(keys, [...stage.rooms, ...stage.docs, ...(stage.cards ?? [])].map((one) => one.id));
  // A key the layout says nothing about lands on the group's own corner rather than nowhere at all.
  const spot = (key: string, w: number, h: number): Box => {
    const held = framework.layout[key] ?? { x: 0, y: 0 };
    return { x: Math.round(at.x + held.x), y: Math.round(at.y + held.y), w, h };
  };
  const rooms = framework.rooms.map(({ key, w, h, ...data }: RoomSpec): Room => ({ id: ids.get(key)!, ...data, ...spot(key, w, h) }));
  const docs = framework.docs.map(({ key, text, w, h, ...data }: DocSpec): Doc => ({ id: ids.get(key)!, ...data, ...spot(key, w ?? DOC_SIZE.w, h ?? DOC_SIZE.h) }));
  const cards = framework.cards.map(({ key, w, h, ...data }): Card => ({ id: ids.get(key)!, ...data, ...spot(key, w, h) } as Card));
  const boxes = new Map([...rooms, ...docs, ...cards].map((one) => [one.id, one]));
  const wires = framework.wires.flatMap((wire): Wire[] => {
    const [from, to] = [ids.get(wire.from), ids.get(wire.to)];
    // A wire whose end is not in the framework is a file somebody edited by hand: the group still lands.
    if (!from || !to || from === to) return [];
    return [{ id: `${from}-${to}`, from, to, ...handlesFor(boxes.get(from)!, boxes.get(to)!) }];
  });
  const texts = Object.fromEntries(framework.docs.map((doc) => [ids.get(doc.key)!, doc.text]));
  return { placed: { rooms, docs, cards, wires }, texts };
}

// What a thing on the stage is called inside a framework: a person by their name, a doc by its title, a card by the
// kind of card it is. The founder chose those words, so a framework saved from their stage reads like their stage.
// A card is asked first, because a link card has a title of its own and would otherwise be taken for a doc.
function keyOf(one: Room | Doc | Card): string {
  if ('kind' in one) return one.kind;
  if ('name' in one) return one.name.trim() || one.role.trim() || one.id;
  return one.title.trim() || one.id;
}

// A framework written from what is selected on the stage. `texts` is what the selected docs say right now, because a
// doc's words are the doc; `hashOf` is the library's hash for a note a selected card holds, so the framework records
// which version of the founder's notes it was built from. `was` is the framework this one replaces: the dataset, the
// intent and the scorecard the founder already had are theirs to keep, and only the team is being written again.
export function frameworkFrom(asked: {
  stage: Pick<Stage, 'rooms' | 'docs' | 'cards' | 'wires'>; ids: string[]; name: string; intent?: string;
  texts: Record<string, string>; hashOf?: (noteId: string) => string | undefined; was?: Framework | null; now?: () => number;
}): Framework {
  const name = asked.name.replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('A framework needs a name.');
  const chosen = new Set(asked.ids);
  const rooms = asked.stage.rooms.filter((room) => chosen.has(room.id));
  const docs = asked.stage.docs.filter((doc) => chosen.has(doc.id));
  const cards = (asked.stage.cards ?? []).filter((card) => chosen.has(card.id));
  const all = [...rooms, ...docs, ...cards];
  if (!all.length) throw new Error('There is nothing selected to save as a framework.');

  // Keys are made once, in the order the stage holds things, and every wire and every place refers to them.
  const used = new Set<string>();
  const keys = new Map(all.map((one) => [one.id, unique(stemOf(keyOf(one)), used, (tries) => String(tries + 1))]));
  // Relative to the selection's own top-left corner, so the group keeps its shape wherever it lands next.
  const origin = { x: Math.min(...all.map((one) => one.x)), y: Math.min(...all.map((one) => one.y)) };
  const layout = Object.fromEntries(all.map((one) => [keys.get(one.id)!, { x: one.x - origin.x, y: one.y - origin.y }]));
  const notes = [...new Set(cards.flatMap((card) => (card.kind === 'library' && card.noteId ? [card.noteId] : [])))]
    .map((id) => ({ id, hash: asked.hashOf?.(id) ?? '' }));

  return {
    id: frameworkId(name), name, intent: (asked.intent ?? asked.was?.intent ?? '').trim(),
    version: (asked.was?.version ?? 0) + 1, builtAt: (asked.now ?? Date.now)(), notes,
    rooms: rooms.map(({ id, x, y, ...room }) => ({ key: keys.get(id)!, ...room })),
    docs: docs.map(({ id, x, y, w, h, ...doc }) => ({ key: keys.get(id)!, ...doc, text: asked.texts[id] ?? '', w, h })),
    cards: cards.map(({ id, x, y, ...card }) => ({ key: keys.get(id)!, ...card }) as Framework['cards'][number]),
    wires: asked.stage.wires.flatMap((wire) => {
      const [from, to] = [keys.get(wire.from), keys.get(wire.to)];
      // Only the wires inside the selection: one that leads out of it would point at nothing when the group lands.
      return from && to ? [{ from, to }] : [];
    }),
    layout,
    dataset: (asked.was?.dataset ?? []) as Case[],
    ...(asked.was?.scorecard ? { scorecard: asked.was.scorecard } : {}),
  };
}
