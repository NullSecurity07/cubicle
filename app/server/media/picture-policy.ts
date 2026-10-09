import { castFor, hasNoun, NOT_CONCRETE, onABareSurface, photoOfTheLine, stockQueries, THING_STEM, thingsOf, type Visual, type World } from './visuals.ts';

// Where a film's pictures come from first.
//
// Four journeys in a row (13 to 16) asked for an explainer about the founder's company and came back with somebody
// else's photographs: an engraving of a family saying grace and a campfire under "hospital canteens close when your
// night shift begins", a printer marketplace as an old market square. Each round taught the title matcher one more
// way a library's caption can share a word with a line and be of something else, and the next film found another.
// A matcher over captions will always be one caption behind.
//
// So the order is turned round. A film about the founder's own company or product is DRAWN FIRST: its pictures are
// drawn from the film's world (the brief's things, the product's things, where they are) and the scene's own line,
// and a photograph is used only when all three of these hold —
//   (a) the scene names a concrete, photographable thing of the film's world (a nurse, a meal box, a hospital);
//   (b) the photograph's title names that thing AND a second concrete thing of the world, so "Meal Prep" alone is
//       a jar of food anywhere, while "nurse with a meal box" is this film;
//   (c) the studio's own eyes (`sight.ts`, CLIP, on this machine) agree the photograph shows the scene's things,
//       scoring the scene against a few generic pictures, and the photograph is refused under `PHOTO_AGREES`. A
//       machine that cannot look cannot agree, so then the picture is drawn.
// Anything else is drawn, and the film's log says which and why, scene by scene.
//
// A film that asks for the real world — a documentary, real footage, real photographs, b-roll — is PHOTO FIRST, as
// before: Openverse and Commons, the title rules in `visuals.ts`, and the same look from `sight.ts` when it can.
export type PicturePolicy = 'drawn-first' | 'photo-first';

export const REAL_ASK = /\b(?:documentar(?:y|ies)|real[- ](?:world\s+)?(?:footage|photos?|photographs?|pictures?|images?|clips?|people|places?)|stock\s+(?:photos?|photographs?|footage|images?|clips?)|b-?roll|archive\s+footage|archival|actual\s+(?:footage|photos?|photographs?)|news\s*reel|photo\s*essay)\b/i;

export const picturePolicy = (ask: string): PicturePolicy => (REAL_ASK.test(ask ?? '') ? 'photo-first' : 'drawn-first');

// The world's things a camera could be pointed at.
export const concreteOf = (world?: World): string[] => (world?.words ?? []).filter((word) => !NOT_CONCRETE.has(word));

const sameThing = (a: string, b: string) => THING_STEM(a) === THING_STEM(b);

// (a) The scene's own photographable things, in the order the line says them: the line's things that are concrete
// things of the film's world.
export function sceneThings(visual: Pick<Visual, 'line' | 'about'>, world?: World): string[] {
  const concrete = concreteOf(world);
  return thingsOf(`${visual.line} ${visual.about ?? ''}`)
    .filter((word) => !NOT_CONCRETE.has(word) && concrete.some((one) => sameThing(one, word)))
    .filter((word, at, all) => all.findIndex((one) => sameThing(one, word)) === at);
}

// What the library is asked for one drawn-first shot: the scene's thing beside a second thing of the scene, else of
// the world. Two tries at most.
export function photoAsks(visual: Pick<Visual, 'line' | 'about'>, world?: World): string[] {
  const mine = sceneThings(visual, world);
  if (!mine.length) return [];
  const [thing] = mine;
  const others = [...mine.slice(1), ...concreteOf(world).filter((word) => !mine.some((one) => sameThing(one, word)))];
  return [...new Set(others.slice(0, 2).map((other) => `${thing} ${other}`))];
}

// (b) Whether a photograph's title names the scene's thing and a second concrete thing of the world. Answers the
// second thing it named, or null.
export function namesTwo(what: string, visual: Pick<Visual, 'line' | 'about'>, world?: World): string | null {
  const [thing] = sceneThings(visual, world);
  if (!thing || !hasNoun(what, [thing])) return null;
  return concreteOf(world).find((word) => !sameThing(word, thing) && hasNoun(what, [word])) ?? null;
}

// What the studio's eyes are asked a photograph or a drawn picture is of: the scene's things as a picture, and its
// setting when the brief gave one. A spoken line ("patients leave voicemails nobody returns") is not a picture, and
// CLIP scores it against anything; the scene's own things are.
export function seenAs(visual: Pick<Visual, 'line' | 'about' | 'subject'>, world?: World): string {
  const things = sceneThings(visual, world).slice(0, 3);
  const where = world?.setting ? ` ${world.setting}` : '';
  if (things.length) return `a photograph of ${things.join(' and ')}${where}`;
  return `a photograph of ${(visual.subject ?? visual.line ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)}`;
}

// (c) The line a photograph must reach on the studio's eyes, as a share of certainty against the generic pictures in
// `sight.ts` (`ASKS.about`). Measured on Journey 16's own photographs: the engraving of a family saying grace 0.02
// and the campfire 0.04 under "hospital canteens at night"; the meal-prep photograph 0.96 under "ready meals"; real
// pottery-class photographs 0.68 to 1.0 under a pottery class, and other things under it 0.0 to 0.36.
export const PHOTO_AGREES = 0.5;
// The line a drawn picture must reach to count as showing its own subject. Lower than a photograph's, because a
// redraw is most of a minute and a drawn picture was asked for exactly this: the empty clinic corridors a picture
// model drew for "a dental front desk phone flashing red" scored 0.06 to 0.18, the desk with its phone 0.46.
export const SUBJECT_PRESENT = 0.25;

// The line a film's log says about one shot's picture. "drawn: no photo matched 'nurse' + 'meal box'".
export function decisionLine(how: 'photo' | 'drawn', why: { thing?: string; other?: string; title?: string; score?: number | null; reason?: string }): string {
  if (how === 'photo') return `photo: "${(why.title ?? '').slice(0, 60)}" names '${why.thing}' + '${why.other}'${typeof why.score === 'number' ? `, and it looks like the scene (${why.score.toFixed(2)})` : ''}`;
  return `drawn: ${why.reason ?? (why.thing ? `no photo matched '${why.thing}'${why.other ? ` + '${why.other}'` : ''}` : 'the line names none of the film\'s own things')}`;
}

// A drawn picture's subject, held to its scene and its world: the scene's own things are in it, and so is where the
// brief set the film. The director's subject is kept and only added to, so a picture written well is drawn as it was.
//
// A film of a product nobody can photograph draws its cast (`castOf`): a shot whose subject has none of the cast in
// it is drawn as the one its line names, or the next one round. A stand-by of things on a bare surface ("van, a quote,
// resting on a bare wooden table", which came back as a toy van) is replaced by it outright.
export function groundedFor(visual: Visual, world?: World): Visual {
  const cast = castFor(visual, world);
  if (cast) {
    const where = world?.setting && !cast.includes(world.setting) ? `, ${world.setting}` : '';
    return { ...visual, subject: onABareSurface(visual.subject ?? '') || !(visual.subject ?? '').trim() ? `${cast}${where}` : `${cast}, ${visual.subject}${where}` };
  }
  // Drawn as one of the cast already: nothing more is put in front of it, least of all another person.
  if (world?.cast?.length) return visual;
  const things = sceneThings(visual, world).filter((word) => !hasNoun(visual.subject ?? '', [word])).slice(0, 2);
  const where = world?.setting && !(visual.subject ?? '').toLowerCase().includes(world.setting.toLowerCase()) ? world.setting : '';
  if (!things.length && !where) return visual;
  return { ...visual, subject: [things.length ? `${things.join(' and ')}, ${visual.subject}` : visual.subject, where].filter(Boolean).join(', ') };
}

// The visual a picture that did not show its scene is drawn again from: nearer, with the scene's things large in the
// middle of the frame.
export function closerFor(visual: Visual, world?: World): Visual {
  const things = sceneThings(visual, world).slice(0, 2);
  const lead = things.length ? `${things.join(' and ')}, large and clear in the middle of the frame` : '';
  return { ...visual, kind: 'medium', size: undefined, subject: [lead, visual.subject].filter(Boolean).join(', ') };
}

// One shot's photograph, or none, under the film's policy, and the line the film's log says about it. `take` asks the
// library (and keeps whatever it hands back on disk); `look` asks the studio's eyes how sure they are the photograph
// shows `seenAs` (null when they cannot look). A photograph handed back is never handed back again in the same film.
export type Listed = { id: string; what: string };
export async function choosePhoto<T extends { found: Listed }>(ask: {
  policy: PicturePolicy; visual: Pick<Visual, 'line' | 'about' | 'subject'>; world?: World; topic?: string[]; brief?: string;
  used: Set<string>;
  take: (query: string, fits: (one: Listed) => boolean) => Promise<T | null>;
  look: (one: T) => Promise<number | null>;
  stopped?: () => boolean;
}): Promise<{ photo: T | null; line: string }> {
  const { policy, visual, world, topic = [], brief = '', used } = ask;
  const label = seenAs(visual, world).replace(/^a photograph of /, '');
  const ofLine = (one: Listed) => !used.has(one.id) && photoOfTheLine(one.what, visual, topic, brief, world);
  if (policy === 'photo-first') {
    let why = '';
    for (const query of stockQueries(visual, topic, world)) {
      const photo = await ask.take(query, ofLine);
      if (ask.stopped?.()) break;
      if (!photo) continue;
      used.add(photo.found.id);
      const score = await ask.look(photo);
      // Photographed first, a photograph nobody could look at is taken, as it always was.
      if (score !== null && score < PHOTO_AGREES) { why = `"${photo.found.what.slice(0, 50)}" did not look like ${label} (${score.toFixed(2)})`; continue; }
      return { photo, line: `photo: "${photo.found.what.slice(0, 60)}"${score === null ? '' : ` looks like ${label} (${score.toFixed(2)})`}` };
    }
    return { photo: null, line: decisionLine('drawn', { reason: why || `no photograph of ${label} was found` }) };
  }
  const [thing] = sceneThings(visual, world);
  const asks = photoAsks(visual, world);
  if (!thing) return { photo: null, line: decisionLine('drawn', {}) };
  let other = asks[0]?.split(' ').slice(1).join(' ');
  let why = '';
  for (const query of asks) {
    const photo = await ask.take(query, (one) => ofLine(one) && !!namesTwo(one.what, visual, world));
    if (ask.stopped?.()) break;
    if (!photo) continue;
    used.add(photo.found.id);
    other = namesTwo(photo.found.what, visual, world) ?? other;
    const score = await ask.look(photo);
    // Drawn first, a photograph is taken only when the studio's eyes agree; eyes that cannot look do not agree.
    if (score === null || score < PHOTO_AGREES) {
      why = score === null
        ? `"${photo.found.what.slice(0, 50)}" named '${thing}' + '${other}', and the studio could not look at it`
        : `"${photo.found.what.slice(0, 50)}" named '${thing}' + '${other}' and did not look like it (${score.toFixed(2)})`;
      continue;
    }
    return { photo, line: decisionLine('photo', { thing, other, title: photo.found.what, score }) };
  }
  return { photo: null, line: decisionLine('drawn', { thing, other, reason: why || undefined }) };
}
