import { content, countWords, STOP, type Layout, type Scene } from './spec.ts';
import { inStyle, noFace, photographic, trimTo } from './critic.ts';

// The pictures.
//
// Everything before this decides what the film says and when it cuts. This decides what is actually on the screen
// at each of those cuts, and it is the pass that was missing. The three proof films made without it came back with
// five pictures of a hand holding a phone filming a street under a script about what investors look for — five
// photographs that could have illustrated any sentence in any film, which is the same as illustrating none of them.
//
// The fault was structural, not a bad prompt. A picture was drawn per *scene* out of `keywords(scene.text)`, the
// same picture was shared down a run of scenes, and nothing anywhere compared one picture's subject to another's.
// So the rules are here, and they are rules rather than hopes:
//
//   - **A picture belongs to a shot, not to a scene.** The editor cuts a scene into several shots; each of them
//     shows something of its own, or the cut changes nothing and is worse than a hold.
//   - **A picture comes out of the phrase being spoken under it** — the words on the clock at that moment, not the
//     scene's headline and not the film's subject in general.
//   - **It names a subject, an action and a place.** "Investors" is not a picture. "A partner reading a one-page
//     summary across a table in an empty meeting room" is.
//   - **No two pictures in one film share a subject.** Measured as token overlap, not hoped for.
//   - **Nothing generic.** There is a banned list, and it holds the exact shots that came back on the proof films.
//   - **Variety is assigned, not requested.** Each slot is given a kind — wide, medium, detail, object, environment
//     — before the model sees it, so a film cannot come back as six medium shots of the same thing.
//   - **A picture that sits under type is composed with a hole where the type goes**, and is measured afterwards to
//     make sure the type really clears it.

// The six ways a shot can be framed. A film that cuts between them reads as a film; one that does not reads as a
// slideshow, however different the subjects are.
export const KINDS = ['wide', 'medium', 'detail', 'object', 'environment', 'data'] as const;
export type Kind = (typeof KINDS)[number];

// Where on the frame the words are going to sit, so the picture can be composed with room for them. `none` is a
// picture with nothing over it at all, which is the only one that may fill the frame.
export type Room = 'foot' | 'top' | 'none';

// One picture, for one shot.
export type Visual = {
  // Which shot in the film this is, counted from zero, and which scene it belongs to.
  at: number; scene: number; take: number;
  // The words spoken under it. Everything else in here is checked against these.
  line: string;
  // The whole line the scene says, of which `line` is the part that lands on this shot. A shot in the middle of a
  // sentence gets a fragment — "sales. Prove customers" was a real one — and a fragment has too few words in it to
  // judge a picture against, so the sentence it came out of counts too.
  about?: string;
  // What is in the picture: a subject doing something somewhere, in the words a picture model reads.
  subject: string;
  kind: Kind;
  room: Room;
  // When the line is an abstraction — "trust", "momentum", "what investors look for" — the picture is a declared
  // stand-in for it rather than a photograph of the word. Naming it is what makes it checkable: a picture with no
  // noun from the line and no metaphor is a picture of something else.
  metaphor?: string;
};

export type Finding = { rule: string; at: number; says: string };

// --- what a picture may not be -----------------------------------------------------------------------------

// The shots a picture model reaches for when it has not been told anything. Every one of these has been on a film
// this studio made, and most of them were on all five frames of the same one. They are banned outright: a line
// that is really about a phone may still have a phone in it, which is why the check below lets the line's own
// nouns override the ban.
export const FILLER_SHOTS = [
  'hand holding a phone', 'holding a phone', 'person holding a phone', 'hand holding a smartphone',
  'filming a street', 'filming the street', 'pointing a phone', 'scrolling on a phone',
  'laptop on a desk', 'laptop on a table', 'open laptop', 'hands typing on a keyboard', 'typing on a laptop',
  'person at a laptop', 'person working on a laptop', 'man at a computer', 'woman at a computer',
  'business meeting', 'team meeting', 'people in a meeting room', 'group of people collaborating',
  'team collaborating', 'diverse team', 'business people shaking hands', 'handshake',
  'busy city street', 'city skyline at sunset', 'crowded street', 'people walking in a city',
  'abstract background', 'abstract shapes', 'gradient background', 'blurred background',
  'light bulb', 'lightbulb moment', 'rocket taking off', 'rocket launch', 'upward arrow',
  'growth chart going up', 'bar chart going up', 'stack of coins', 'piggy bank',
  'coffee cup on a desk', 'cup of coffee beside a notebook', 'sticky notes on a wall',
  'person looking at the camera', 'influencer talking to camera', 'young professional smiling',
];
const FILLER_RE = new RegExp(`(${FILLER_SHOTS.map((one) => one.replace(/\s+/g, '\\s+')).join('|')})`, 'i');
export const fillerShot = (subject: string): string | null => FILLER_RE.exec(subject ?? '')?.[1]?.toLowerCase() ?? null;

// A picture model cannot write. It has no negative prompt either — the local model is distilled and runs at a
// guidance of one, which throws the negative away, and Workers AI takes only a prompt — so "no text, no letters"
// is read as part of the same sentence and summons the very thing it asked to be spared. A real scene of type
// came back sitting on a picture of fake type reading "rogblellem / Solvic" that way.
//
// The only thing that works is never asking. So every noun that summons lettering is struck out of a subject
// before it is drawn, and a verb that asks for writing goes with it.
export const SUMMONS_TEXT = /\b(charts?|graphs?|dashboards?|decks?|slides?|metrics|checklists?|lists?|texts?|signs?|signage|screens?|displays?|interfaces?|ui|uis|apps?|websites?|web ?pages?|pages?|documents?|reports?|spreadsheets?|logos?|brands?|labels?|posters?|banners?|headlines?|newspapers?|magazines?|books?|whiteboards?|notebooks?|notes?|letters?|words?|writing|written|typography|captions?|subtitles?|numbers?|figures?|percentages?|slogans?|titles?|inscriptions?|lettering|typeface|font|question\s+marks?|exclamation\s+marks?|punctuation|symbols?|emoji|icons?|pictograms?|glyphs?)\b/gi;
// "a sign reading OPEN", "a mug that says Boss", "a door labelled Accounts" — the literal goes with the verb that
// introduced it, because the noun alone is not what summons the lettering: the quoted words are. A verb with no
// literal after it ("a founder reading a summary") is somebody doing something and is left where it is.
const ASKS_FOR_WRITING = /\b(?:reading|saying|says|inscribed(?:\s+with)?|captioned|titled|labell?ed|spelling\s+out)\b\s+["“']?[A-Z][^,.;]{0,40}/g;
// A global regular expression keeps its place between calls, so it is never asked a yes-or-no question: what came
// back is the match itself, which is also the word the founder is told about.
export const asksForWriting = (subject: string): string | null =>
  ((subject ?? '').match(SUMMONS_TEXT)?.[0] ?? (subject ?? '').match(ASKS_FOR_WRITING)?.[0] ?? null);

// The same subject with every word that summons lettering taken out of it. What is left is the picture that was
// really wanted: "a founder reading a one-page summary" rather than "a founder reading a pitch deck slide".
export function unlettered(subject: string): string {
  SUMMONS_TEXT.lastIndex = 0;
  return (subject ?? '')
    .replace(ASKS_FOR_WRITING, ' ')
    .replace(SUMMONS_TEXT, ' ')
    // The article whose noun has just gone with the rest of it: "a founder reading a , in an empty room".
    .replace(/\b(?:a|an|the|of|with)\s*(?=[,;.]|$)/gi, ' ')
    .replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').replace(/^[\s,;.]+|[\s,;.]+$/g, '')
    .trim();
}

// Somebody in the frame. A film has one person in it at most, and this is how that is counted.
//
// The rule is not squeamishness, it is what a real render showed. A fifteen-second reel made with everything else
// in this file working came back with four different shots of the same dark-haired woman in the same office,
// because four different subjects all ended with "anybody in the picture is at work and turned away from the
// camera" and a picture model handed that draws a person — the same person, because the look is fixed and that is
// what a fixed look is for. Four shots of one stranger nobody introduced is the identity-drift fault from the
// other direction: not a person who keeps changing, a person who keeps coming back.
//
// So at most one picture in a film may have somebody in it. Everything else is a place, a thing or a detail, and
// the clause that invites a person is only written on the one that is allowed one.
const SOMEBODY = /\b(person|people|man|men|woman|women|boy|girl|child|founder|investor|partner|presenter|speaker|host|worker|customer|client|colleague|stranger|somebody|someone|crowd|team|face|portrait|hands?|figures?|silhouettes?|shoulders?)\b/gi;
export const somebodyIn = (subject: string): string | null => ((subject ?? '').match(SOMEBODY)?.[0] ?? null);
// The same subject with the people taken out of it, so what is left is the place or the thing it was set in.
export const nobodyIn = (subject: string): string =>
  (subject ?? '').replace(SOMEBODY, ' ')
    .replace(/\b(?:a|an|the|of|with|by|beside|near)\s*(?=[,;.]|$)/gi, ' ')
    .replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').replace(/^[\s,;.]+|[\s,;.]+$/g, '').trim();

// --- is this picture of what is being said? ------------------------------------------------------------------

// How much two subjects have in common, counted in the words that carry meaning. Two pictures that share most of
// their nouns are one picture drawn twice, whatever the grammar around them.
export function shares(a: string, b: string): number {
  const mine = new Set(content(a));
  const theirs = new Set(content(b));
  if (!mine.size || !theirs.size) return 0;
  let both = 0;
  for (const word of mine) if (theirs.has(word)) both += 1;
  return both / Math.min(mine.size, theirs.size);
}

// The one word a picture is of: the first thing in it that carries meaning. Two pictures with the same head noun
// are two pictures of the same thing, however far apart the rest of the words are.
export const headNoun = (subject: string): string => content(subject)[0] ?? '';

// Whether a picture is of the line it sits under. It is, if it uses one of the line's own words; or if it says,
// in as many words, that it stands for the line instead. Anything else is a picture of something else.
export const aboutTheLine = (visual: Visual): boolean => {
  const line = new Set([...content(visual.line), ...content(visual.about ?? '')]);
  if (!line.size) return true;
  if (content(visual.subject).some((word) => line.has(word))) return true;
  return !!visual.metaphor && content(visual.metaphor).length >= 2;
};

// --- the reading ------------------------------------------------------------------------------------------

// How much two subjects may share before they are the same picture. Half is generous: "a founder at a table" and
// "a founder at a desk" share two of three and are the same photograph.
export const SAME = 0.5;

export function criticiseVisuals(visuals: Visual[]): Finding[] {
  const found: Finding[] = [];
  const say = (rule: string, at: number, says: string) => found.push({ rule, at, says });
  const heads = new Map<string, number>();
  visuals.forEach((visual, index) => {
    const where = `picture ${index + 1}`;
    if (countWords(visual.subject) < 4) {
      say('thin', index, `${where} is "${visual.subject}" — a picture names a subject, what it is doing and where it is`);
    }
    const filler = fillerShot(visual.subject);
    // A line that really is about a phone may have a phone in it; a line about anything else may not.
    if (filler && !content(visual.line).some((word) => filler.includes(word))) {
      say('filler', index, `${where} is "${filler}", which could illustrate any sentence in any film`);
    }
    if (asksForWriting(visual.subject)) {
      say('lettering', index, `${where} asks a picture model to write "${asksForWriting(visual.subject)}", and a picture model cannot write`);
    }
    if (!aboutTheLine(visual)) {
      say('unrelated', index, `${where} shares no word with "${trimTo(visual.line, 9)}" and names no stand-in for it`);
    }
    const head = headNoun(visual.subject);
    if (head) {
      const before = heads.get(head);
      if (before !== undefined) say('repeat', index, `${where} is another picture of ${head}, and so was picture ${before + 1}`);
      else heads.set(head, index);
    }
    for (let other = 0; other < index; other += 1) {
      if (shares(visual.subject, visuals[other].subject) >= SAME) {
        say('same', index, `${where} and picture ${other + 1} are the same picture in different words`);
        break;
      }
    }
  });
  // A film has one person in it. The second one is a stranger nobody introduced, and in a fixed look it is the
  // same stranger, which is worse.
  const peopled = visuals.map((one, index) => (somebodyIn(one.subject) ? index : -1)).filter((one) => one >= 0);
  for (const index of peopled.slice(1)) {
    say('crowd', index, `picture ${index + 1} has somebody in it and so does picture ${peopled[0] + 1} — a film has one person in it`);
  }
  // A film framed the same way throughout is a slideshow however varied its subjects are.
  const kinds = new Set(visuals.map((one) => one.kind));
  if (visuals.length >= 4 && kinds.size < 3) {
    say('framing', 0, `every picture in the film is a ${[...kinds].join(' and ')} shot — a film cuts between wide, medium and detail`);
  }
  return found;
}

// --- putting it right without asking anybody ------------------------------------------------------------------

// The places a picture can be, one per shot, so two shots drawn from the same line are still two pictures. These
// are deliberately plain: a place is where a thing happens, and the drama is meant to come from the subject.
const PLACES = [
  'in an empty office at first light', 'across a bare wooden table', 'in a stairwell with one window',
  'on a loading bay at dusk', 'in a workshop with the door open', 'against a plain painted wall',
  'in a kitchen at the end of the day', 'on a bench outside a station', 'in a storeroom under one lamp',
  'beside a window on a grey afternoon', 'in a corridor with the lights off', 'on a rooftop before the rain',
];
// What the camera is doing, per kind. This is the half of a picture nobody writes down and every generated still
// is missing: a frame has a distance and a lens, and six frames at the same distance read as one frame.
// One of these describes a person and the rest describe a place or a thing, and that is the whole point. A
// picture model told "the subject to one side of the frame" draws a person, because to a picture model a subject
// is a person — so a film where four slots were framed that way came back with three strangers in it even after
// the one-person rule had struck every person out of the words. The framing is where a person really gets in, so
// only `medium` lets one in, and `slotsFor` hands `medium` out exactly once a film.
const FRAMING: Record<Kind, string> = {
  wide: 'a wide establishing frame of an empty place, a great deal of air above, nothing in the middle of the frame',
  medium: 'a medium shot at eye level of one person at work, seen in profile or from behind, to one side of the frame',
  detail: 'a tight detail filling the frame, very shallow focus, the background fallen away',
  object: 'one object alone on a plain surface, raked side light, the rest of the frame empty',
  environment: 'a room with nobody in it, the light falling across the floor, seen from the doorway',
  data: 'a flat overhead of a plain surface, one object placed on it, even light, nothing else in frame',
};
// Where the hole for the type goes. A picture that fills the frame under a headline is a picture with a headline
// across its subject, which is how a real reel put its hook over somebody's face.
const ROOM: Record<Room, string> = {
  foot: 'the lower third of the frame is empty and in shadow, the subject kept in the upper half',
  top: 'the upper third of the frame is empty and in shadow, the subject kept in the lower half',
  none: 'the subject centred, filling the frame',
};

// The words of a line worth building a picture out of: what it is about, longest first, with anything already
// used elsewhere in the film skipped. This is the floor under the whole pass — a picture built from these is
// never brilliant and is always of the right thing, which is the trade the founder actually wants.
export function subjectWords(line: string, used: Set<string>, most = 3): string[] {
  const words = content(line).filter((word) => !used.has(word));
  const ranked = [...new Set(words)].sort((a, b) => b.length - a.length);
  return ranked.slice(0, most);
}

// A picture built out of a line and nothing else. Deterministic: the same line at the same place in the same film
// gives the same picture every time it is rendered.
//
// It is the subject only — no framing and no hole for the type. Those are the same handful of words on every
// picture in a film, and baking them into the subject made two perfectly different pictures look, to the rule
// that counts shared words, like the same picture twice.
export function visualFrom(line: string, at: number, used: Set<string>): string {
  const words = subjectWords(line, used, 3);
  for (const word of words) used.add(word);
  const about = words.length ? words.join(' and ') : trimTo(line, 4) || 'a pair of hands at rest';
  return `${about}, ${PLACES[at % PLACES.length]}`;
}

// Everything the critic found, done to the pictures rather than said about them. Nothing here asks anybody
// anything and it always terminates: each pass either replaces one picture with one built from its own line or
// leaves it alone.
export function repairVisuals(visuals: Visual[]): { visuals: Visual[]; notes: string[] } {
  const notes: string[] = [];
  const note = (line: string) => { if (!notes.includes(line)) notes.push(line); };
  const used = new Set<string>();
  const made: Visual[] = [];
  // Whether somebody has already been put on screen in this film.
  let peopled = false;
  for (const [index, visual] of visuals.entries()) {
    let one: Visual = { ...visual, subject: unlettered(visual.subject) };
    if (one.subject !== visual.subject) note('a picture was asked to have writing in it, and a picture model cannot write, so the writing came out');
    const wrong = () => {
      const filler = fillerShot(one.subject);
      if (filler && !content(one.line).some((word) => filler.includes(word))) return 'generic';
      if (countWords(one.subject) < 4) return 'thin';
      if (!aboutTheLine(one)) return 'unrelated';
      if (made.some((other) => shares(one.subject, other.subject) >= SAME)) return 'repeated';
      const head = headNoun(one.subject);
      if (head && made.some((other) => headNoun(other.subject) === head)) return 'repeated';
      return null;
    };
    const fault = wrong();
    if (fault) {
      note(fault === 'generic' ? 'a picture that could have illustrated any sentence was drawn from the line it sits under instead'
        : fault === 'repeated' ? 'two pictures in the film were the same picture, so the second is drawn from its own line'
          : 'a picture was of something the line never mentions, so it is drawn from the line instead');
      one = { ...one, subject: visualFrom(content(one.line).length >= 2 ? one.line : (one.about ?? one.line), index, used), metaphor: undefined };
    } else {
      for (const word of content(one.subject).slice(0, 3)) used.add(word);
    }
    // One person in a film. The first picture that has somebody in it keeps them; every one after it is the same
    // place or the same thing with nobody in it, which is what it should have been.
    if (somebodyIn(one.subject)) {
      if (peopled) {
        const alone = nobodyIn(one.subject);
        note('a second picture had somebody in it, and a film has one person in it, so that shot is of the place instead');
        one = { ...one, subject: countWords(alone) >= 3 ? alone : visualFrom(one.line, index, used), kind: one.kind === 'medium' ? 'environment' : one.kind };
      } else peopled = true;
    }
    made.push(one);
  }
  // Framing, last, because a repair may have changed what a picture is of but never how it is framed. A film with
  // fewer than three kinds of frame in it has the middle of its pictures re-framed until it has.
  const kinds = new Set(made.map((one) => one.kind));
  if (made.length >= 4 && kinds.size < 3) {
    const wheel: Kind[] = ['wide', 'medium', 'detail', 'object', 'environment'];
    made.forEach((one, index) => {
      if (kinds.size >= 3 || index === 0) return;
      const next = wheel[index % wheel.length];
      if (next === one.kind) return;
      made[index] = { ...one, kind: next };
      kinds.add(next);
    });
    note('the whole film was framed the same way, so the middle of it cuts between a wide, a medium and a detail');
  }
  return { visuals: made, notes };
}

// --- asking the model -------------------------------------------------------------------------------------

// What every shot in the film is, laid out for the model as a numbered list with the phrase spoken under it and
// the frame it has to be shot in. The frame is assigned rather than asked for, because a model asked to vary its
// own framing does not.
export function visualsPrompt(slots: Visual[], bible: string, angle: string): string {
  return [
    'You are the director of photography on a short film. For each numbered moment below, write the one picture that',
    'is on screen while that line is spoken. Answer with one JSON object and nothing else.',
    '',
    '{"pictures": [{"at": the number, "subject": "who or what, doing what, where — one sentence", "metaphor": "leave this out unless the line is an abstraction, in which case say in a few words what the picture stands for"}]}',
    '',
    `The film argues: ${angle}`,
    `Every picture is shot the same way: ${bible}`,
    '',
    'The rules these pictures are checked against before anything is drawn:',
    '- A picture names a subject, what that subject is doing, and where. "Investors" is not a picture. "A partner sliding a single sheet of paper back across a table" is.',
    '- It comes out of the line spoken under it. Use one of that line\'s own words, or say what the picture stands for in "metaphor".',
    '- No two pictures in this film may be of the same thing. Not the same subject, not the same place, not the same action.',
    '- Never a hand holding a phone, a laptop on a desk, hands on a keyboard, a meeting room, a city street, an abstract background, a lightbulb or a rocket, unless the line itself is about one.',
    '- A picture model cannot write. Nothing in a picture may be a screen, a chart, a sign, a document, a logo or any other surface with words on it.',
    '- At most ONE picture in the whole film may have a person in it. Every other picture is a place, an object or a detail with nobody in it.',
    '- Nobody looks at the camera. Anybody in that one picture is at work and turned away.',
    '- The framing of each picture is already decided and is written beside it. Keep it.',
    '',
    'The moments:',
    ...slots.map((slot) => `${slot.at + 1}. [${slot.kind} shot; ${ROOM[slot.room]}] said over it: "${slot.line || '(nothing is said)'}"`
      + (slot.about && slot.about !== slot.line ? `  (out of: "${slot.about}")` : '')),
  ].join('\n');
}

// What came back, read as loosely as it can honestly be read, with everything missing left for the repair.
export function visualsOf(raw: unknown, slots: Visual[]): Visual[] {
  const said = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(said.pictures) ? said.pictures : Array.isArray(said) ? said : [];
  const byAt = new Map<number, Record<string, unknown>>();
  list.forEach((one, order) => {
    const item = (one ?? {}) as Record<string, unknown>;
    const at = Number(item.at);
    byAt.set(Number.isFinite(at) ? Math.round(at) - 1 : order, item);
  });
  return slots.map((slot) => {
    const said = byAt.get(slot.at);
    const subject = typeof said?.subject === 'string' ? said.subject.trim().slice(0, 240) : '';
    const metaphor = typeof said?.metaphor === 'string' && said.metaphor.trim() ? said.metaphor.trim().slice(0, 120) : undefined;
    return subject ? { ...slot, subject, metaphor } : slot;
  });
}

// --- the shot list, before anything has been drawn --------------------------------------------------------

// A scene whose frame is already full of words wants something quiet behind them rather than a competing picture:
// a texture, framed as a texture, with nothing in it to read.
export const TYPE_HEAVY = new Set<Layout>(['checklist', 'bullets', 'steps', 'compare', 'stat', 'quote', 'title', 'cta', 'outro']);

// Which way a shot is framed, decided before the model sees it. The wheel turns with the shot's place in the
// film, so no two neighbours are framed alike and a six-shot film has at least four framings in it.
const WHEEL: Kind[] = ['medium', 'environment', 'detail', 'wide', 'object', 'detail', 'medium', 'wide'];
export const kindFor = (at: number, layout: Layout): Kind =>
  (TYPE_HEAVY.has(layout) ? (at % 2 ? 'detail' : 'environment') : WHEEL[at % WHEEL.length]);

// Where the words are on this frame, and so where the picture must leave a hole. A picture scene with no caption
// of its own is the only one that gets the whole frame.
export function roomFor(scene: Scene, captions: boolean): Room {
  const writes = [scene.heading, scene.text, ...(scene.bullets ?? [])].some((one) => one?.trim());
  // Nothing is going to be written on this frame and nothing is being said under it, so the picture is the whole
  // scene and may fill the frame. It is the only one that may.
  if (!writes && !captions) return 'none';
  // A picture scene in a captioned film moves its own caption to the head of the frame, because the foot is
  // already spoken for by the caption band — so the hole in the picture moves with it.
  if (captions && scene.layout === 'picture') return 'top';
  // Everywhere else the words a viewer reads end up in the lower half: the caption band in a captioned film, the
  // block of type over a photograph in one without.
  return 'foot';
}

// One slot per shot, empty, ready for the model to fill or the rules to fill for it. `line` is the phrase really
// spoken under that shot rather than the whole scene's narration: a three-second shot in the middle of a long
// sentence gets the words that land on it.
export type Slot = { scene: number; take: number; line: string; layout: Layout };
// The framings a film may use for the shots that are not its one person: a place, a thing, a detail, a wide.
const WITHOUT: Kind[] = ['environment', 'detail', 'object', 'wide'];
export function slotsFor(slots: Slot[], captions: boolean, scenes: Scene[]): Visual[] {
  const made = slots.map((slot, at) => ({
    at, scene: slot.scene, take: slot.take, line: slot.line,
    about: (scenes[slot.scene]?.say ?? '').trim() || undefined,
    subject: '', kind: kindFor(at, slot.layout), room: roomFor(scenes[slot.scene] ?? { layout: slot.layout }, captions),
  }));
  // Exactly one shot in a film is framed as a person. The first one the wheel offers keeps it; the rest take a
  // place or a thing, by rotation, so the film still cuts between distances.
  let person = false;
  return made.map((one, at) => {
    if (one.kind !== 'medium') return one;
    if (!person) { person = true; return one; }
    return { ...one, kind: WITHOUT[at % WITHOUT.length] };
  });
}

// --- the words a picture model is finally handed -----------------------------------------------------------

// Everything above, turned into the one line a picture model reads: the film's own look first so six frames are
// six frames of one film, then the framing, then the subject, then the hole the type sits in. Nothing in it asks
// for lettering, nobody in it faces the camera, and nothing in it is drawn when the rest of the film is shot.
export function drawnAs(visual: Visual, bible: string): string {
  const subject = unlettered(noFace(photographic(bible) ? inStyle(visual.subject, bible) : visual.subject));
  const body = subject || visualFrom(visual.line, visual.at, new Set());
  // The clause that invites a person is written on the one picture that is allowed one and nowhere else. It used
  // to be on all of them, and a picture model handed it draws a person every time — the same person, because the
  // look is fixed. Four shots of one stranger is what that cost on a real reel.
  const who = somebodyIn(body) ? ', anybody in the picture is at work and turned away from the camera' : '';
  return `${bible}. ${FRAMING[visual.kind]}: ${body}, ${ROOM[visual.room]}${who}`
    .replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1');
}

// How many pictures a film can afford to draw, in minutes rather than in principle. Away from this machine a
// picture is four seconds and a free account covers hundreds a day, so a film draws one a shot. Here it is nearly
// a minute each, and eleven minutes of waiting for a fifteen-second reel is not a trade a founder would make.
// The arithmetic lives in `shared/film-time.ts`, because the card says the same minutes before Make is pressed.
export { afforded, SECONDS_AWAY, SECONDS_HERE } from '../../shared/film-time.ts';

// Which shots get a picture of their own when there is not one for every shot: the opening, the close, and then
// the longest, because a long shot is where a repeat is seen. The rest share the picture nearest them, at their
// own crop — which is the old behaviour, kept honest by being the exception rather than the rule.
//
// `have` is the shots whose picture is already drawn or being drawn. They were started while the narration was
// still being listened back to, from a cut that was guessed; the measured cut may rank its shots a little
// differently, and a picture already paid for is never thrown away to draw its neighbour instead.
export function shareOut(lengths: number[], many: number, have: ReadonlySet<number> = new Set()): number[] {
  if (many >= lengths.length) return lengths.map((_one, at) => at);
  const order = lengths.map((seconds, at) => ({ seconds, at }))
    .sort((a, b) => (a.at === 0 ? -1 : b.at === 0 ? 1 : b.seconds - a.seconds || a.at - b.at));
  const kept = [...have].filter((at) => at >= 0 && at < lengths.length);
  const drawn = new Set([...kept, ...order.map((one) => one.at).filter((at) => !have.has(at))].slice(0, Math.max(many, kept.length)));
  const owners: number[] = [];
  let last = -1;
  for (let at = 0; at < lengths.length; at += 1) {
    if (drawn.has(at)) last = at;
    owners.push(last);
  }
  // A shot before the first drawn one takes the first drawn one.
  const first = owners.find((one) => one >= 0) ?? 0;
  return owners.map((one) => (one >= 0 ? one : first));
}

// A shot's name across two cuts of the same film: which scene it is in and which take of that scene it is. The
// guessed cut and the measured one disagree by a few frames about *when*, and almost never about *which*.
export const shotKey = (one: { scene: number; take: number }): string => `${one.scene}:${one.take}`;

// The words really spoken under one shot, out of the film's measured word timings. A shot is given the words
// whose middle falls inside it, so a picture is of the phrase on the screen rather than of the scene in general.
export function lineUnder(words: { word: string; at: number; seconds: number }[], from: number, to: number, fallback: string): string {
  const said = words.filter((one) => one.at + one.seconds / 2 >= from && one.at + one.seconds / 2 < to).map((one) => one.word);
  // Two words is not a phrase. A shot that lands in a gap takes the scene's own line rather than a stray preposition.
  return said.filter((one) => !STOP.has(one.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''))).length >= 2 ? said.join(' ') : fallback;
}
