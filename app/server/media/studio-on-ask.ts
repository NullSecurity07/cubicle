import type { Card, Stage, Wire } from '../../shared/model.ts';
import { wiredCards } from '../prompt.ts';
import { besideRoom } from '../tools/docs.ts';

// A film asked of somebody with no video studio wired to them. Journey 19: "video studio" typed alone offered no card,
// and a founder who asks a person for a film is asking for the studio too: generate_video is only offered with one
// wired, so the person could only answer that there was none. The studio is put beside them and wired to them before
// the turn starts, so the same turn can make the film, and the reply says so in its first line.

// "make a 20 s explainer", "can you do a video about…", "I need a reel for launch", "20 s explainer about our quote
// tool". A film named after a verb of making, or a length and a film word on their own. Talk about a film ("what did
// you think of that video") asks for nothing, and "don't make a video" is a no.
const MAKING = /\b(?:make|makes|making|create|produce|shoot|render|generate|put together|cut|do|draft|need|want|give me|film)\b[^.?!\n]{0,60}?\b(?:film|video|explainer|reel|clip|promo|teaser|trailer|movie)s?\b/i;
const SIZED = /^\s*(?:an?\s+)?\d+\s*(?:s|sec|secs|seconds?|-second)\b[^.?!\n]{0,20}?\b(?:film|video|explainer|reel|clip|promo|teaser)\b/i;
const STUDIO = /\bvideo studio\b/i;
const NOT = /\b(?:don'?t|do not|never|no need to|stop|cancel)\b[^.?!\n]{0,20}\b(?:make|do|create|shoot|render|film)\b/i;

export const asksForFilm = (text: string): boolean => {
  const said = text ?? '';
  return !NOT.test(said) && (MAKING.test(said) || SIZED.test(said) || STUDIO.test(said));
};

const SIZE: [number, number] = [380, 420];

export type StudioAdded = { id: string; made: boolean; line: string };

// The edit that puts a studio in reach of `roomId`: an existing studio wired to nobody is wired to them, else a new
// one is made beside them. Nothing when the ask is not for a film, the room has one wired already, or no room.
export function studioFor(stage: Stage, roomId: string, text: string): { edit: (stage: Stage) => void; added: StudioAdded } | null {
  if (!asksForFilm(text)) return null;
  const room = stage.rooms.find((one) => one.id === roomId);
  if (!room || wiredCards(stage, roomId, 'videogen').length) return null;
  const cards = stage.cards ?? [];
  const touched = new Set(stage.wires.flatMap((wire) => [wire.from, wire.to]));
  const spare = cards.find((card) => card.kind === 'videogen' && !touched.has(card.id));
  const id = spare?.id ?? `videogen-${Math.random().toString(36).slice(2, 8)}`;
  const wire: Wire = { id: `${roomId}-${id}`, from: roomId, fromHandle: 'r', to: id, toHandle: 'l' };
  const line = spare
    ? 'I wired the video studio on the stage to me, so I can make the film there.'
    : 'There was no video studio, so I added one beside me and wired it to me.';
  return {
    added: { id, made: !spare, line },
    edit: (current) => {
      const here = current.rooms.find((one) => one.id === roomId);
      if (!here || wiredCards(current, roomId, 'videogen').length) return;
      current.cards ??= [];
      if (!current.cards.some((card) => card.id === id)) {
        current.cards.push({ id, kind: 'videogen', brief: '', ...besideRoom(current, here, SIZE), w: SIZE[0], h: SIZE[1] } as Card);
      }
      if (!current.wires.some((one) => one.id === wire.id)) current.wires.push(wire);
    },
  };
}
