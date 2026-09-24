import type { Card, Stage } from './model.ts';

// What a film may draw on, worked out the way the server works it out. These three are twins of `wiredTo`,
// `sourcesFor` and `docsFor` in server/media/video.ts, which is what `gather` really reads when a film is made; the
// video card reads these to say, before Make is pressed, what the film will use. Change the rules there and here
// together, or the card will promise one thing and the film do another. (This file only mirrors them: the server's
// copies stay where they are, beside the code that depends on their every detail.)

type Wires = Pick<Stage, 'wires' | 'cards'>;

// Which cards are joined to this one, in either direction.
export const wiredTo = (stage: Wires, cardId: string): Card[] => {
  const ends = new Set((stage.wires ?? []).flatMap((wire) => (wire.from === cardId ? [wire.to] : wire.to === cardId ? [wire.from] : [])));
  return (stage.cards ?? []).filter((card) => ends.has(card.id));
};

// The kinds of card a person carries into a film they are asked to make.
const THEIRS = new Set<Card['kind']>(['imagegen', 'image', 'note', 'link', 'project']);

// Three reaches, in the order they matter: what is wired to the studio; the image studio behind a wired picture card;
// and everything of those kinds wired to whoever is making the film.
export function sourcesFor(stage: Wires, cardId?: string, roomId?: string): Card[] {
  const found = new Map<string, Card>();
  const keep = (card: Card) => { if (card.id !== cardId && !found.has(card.id)) found.set(card.id, card); };
  const direct = cardId ? wiredTo(stage, cardId) : [];
  for (const card of direct) keep(card);
  for (const card of direct) {
    if (card.kind !== 'image') continue;
    for (const behind of wiredTo(stage, card.id)) if (behind.kind === 'imagegen') keep(behind);
  }
  if (roomId) for (const card of wiredTo(stage, roomId)) if (THEIRS.has(card.kind)) keep(card);
  return [...found.values()];
}

// The documents a film may read: the ones wired to the studio, and the ones wired to whoever is making it.
export const docsFor = (stage: Pick<Stage, 'wires' | 'docs'>, cardId?: string, roomId?: string): string[] => {
  const ends = new Set((stage.wires ?? []).flatMap((wire) => {
    if (wire.from === cardId || wire.from === roomId) return [wire.to];
    if (wire.to === cardId || wire.to === roomId) return [wire.from];
    return [];
  }));
  return (stage.docs ?? []).filter((doc) => ends.has(doc.id)).map((doc) => doc.id);
};

// What the card says a film will use, one phrase per thing, in the order `gather` reads them: the cards, then the
// docs. A card `gather` would skip is not named: an empty note or picture card, a link with no address, a browser
// still on a blank page (`where` is the page a browser card is on, '' when nobody has opened one), an image studio
// that has drawn nothing yet (`drawn` is how many pictures it has, of which a film takes the newest three). A doc is
// named by its title, because what is written in it is not known here.
export function filmSays(cards: Card[], docTitles: string[], seen: { where: (cardId: string) => string; drawn: (cardId: string) => number }): string[] {
  const said: string[] = [];
  for (const card of cards) {
    if (card.kind === 'project' && card.path) said.push(`${card.path.split('/').filter(Boolean).at(-1) ?? 'a'} project`);
    else if (card.kind === 'link' && card.url) said.push(card.title || card.url);
    else if (card.kind === 'browser' && seen.where(card.id) && !/^about:/.test(seen.where(card.id))) said.push('a browser card');
    else if (card.kind === 'note' && card.text?.trim()) said.push('a note');
    else if (card.kind === 'image' && card.path) said.push('a picture');
    else if (card.kind === 'imagegen') {
      const count = Math.min(3, seen.drawn(card.id));
      if (count) said.push(`${count} picture${count === 1 ? '' : 's'} from the image studio`);
    }
  }
  return [...said, ...docTitles];
}
