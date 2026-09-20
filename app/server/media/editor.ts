import type { Sfx } from './audio.ts';
import { content, type Layout, type Scene } from './spec.ts';
import { nearestPhrase, phrasesIn, type Phrase, type Word } from './timings.ts';
import type { Pace } from './templates/looks.ts';

// The editor.
//
// Everything before this decides what the film says. This decides when it cuts, and it is the pass that was
// missing. A storyboard handed straight to a renderer gives every scene the length of the line said over it and
// cuts on a fixed grid — which is how a fifteen-second reel came out as three held shots with a voice over them.
// Nothing in here asks anybody anything and nothing in here is random: the same film edits the same way twice.
//
// The numbers are not invented. They are the ones short-form editors actually work to, and they are worth writing
// down because every one of them is load bearing:
//
//   - **A cut lands on a phrase boundary.** When narration leads, you cut on the phrase; you cut on the beat only
//     in a music-led montage with no voice. A cut a fifth of a second off the word is what "obvious cuts" means.
//   - **Five to seven picture changes per ten seconds** for a reel. Below four, retention falls away; above eight
//     it reads as noise.
//   - **No shot under 1.2 seconds**, because a shorter one cannot be processed, and **nothing static past three**,
//     because a held frame is where people leave.
//   - **Shot length is drawn from a distribution, not from a constant.** A film that cuts every two seconds on the
//     nose still feels sluggish: rhythm comes from varying the length, and from one longer hold on the payoff.
//   - **A punch-in lands on a stressed word**, never at an interval. A zoom with no word under it is the thing
//     that reads as a random movement, which is exactly what the founder called it.
//   - **At most five sound effects in a film**, each on a cut frame. An effect on every cut is chaos.
//   - **No asset appears twice in one film.**

// What a style cuts like. One row a look, taken from the per-style table rather than from one global pace.
export type Cutting = {
  // The shot-length distribution: floor, mean, spread and ceiling, in seconds.
  min: number; mean: number; spread: number; max: number;
  // How many picture changes the style wants in ten seconds, as a range.
  changes: [number, number];
  // The one long hold a film gets, on its payoff.
  hold: [number, number];
  // How far a punch-in goes, as a scale. 1.0 to somewhere in here.
  punch: [number, number];
  // How many sounds the whole film may carry.
  sfx: number;
  // How far under the voice the bed sits, in decibels.
  duck: [number, number];
};

// The table. `creator` and `neon` are the fast end, `editorial` the quiet one; a documentary-luxury film holds
// longer than any of them and lets the pictures do the work. A pack the table does not know cuts like `clean`.
export const CUTTING: Record<string, Cutting> = {
  clean: { min: 1.5, mean: 3.0, spread: 0.9, max: 6.0, changes: [3, 5], hold: [4, 6], punch: [1.04, 1.08], sfx: 4, duck: [18, 22] },
  creator: { min: 1.2, mean: 2.2, spread: 0.8, max: 4.0, changes: [5, 7], hold: [3, 4], punch: [1.08, 1.15], sfx: 5, duck: [18, 25] },
  neon: { min: 1.2, mean: 2.6, spread: 0.8, max: 4.5, changes: [4, 6], hold: [3, 4], punch: [1.06, 1.12], sfx: 5, duck: [15, 20] },
  editorial: { min: 1.5, mean: 3.4, spread: 1.0, max: 6.0, changes: [2, 4], hold: [4, 8], punch: [1.04, 1.08], sfx: 4, duck: [15, 20] },
  // The long-form register holds longer than anything else here and lets the pictures do the arguing: two to four
  // changes in ten seconds, a hold of up to eight on the payoff, and a push so slow it reads as a camera.
  documentary: { min: 1.5, mean: 3.8, spread: 1.1, max: 6.5, changes: [2, 4], hold: [4, 8], punch: [1.04, 1.08], sfx: 4, duck: [15, 20] },
  sketch: { min: 1.5, mean: 3.2, spread: 0.9, max: 6.0, changes: [3, 5], hold: [4, 6], punch: [1.03, 1.06], sfx: 4, duck: [18, 22] },
  brand: { min: 1.5, mean: 3.0, spread: 0.9, max: 6.0, changes: [3, 5], hold: [4, 6], punch: [1.04, 1.08], sfx: 4, duck: [18, 22] },
};
export const cuttingFor = (pack: string, pace: Pace): Cutting => {
  const style = CUTTING[pack] ?? CUTTING.clean;
  // A founder who asked for calm gets the same style, given room: the shape of the distribution does not change,
  // only how long each shot is allowed to be.
  return pace === 'calm' ? style : { ...style, mean: Math.max(style.min + 0.4, style.mean * 0.8), max: Math.max(style.min + 0.8, style.max * 0.8) };
};

// One shot: which scene it belongs to, when it starts, how long it holds, and what happens inside it.
// A scene may be several shots — that is what a picture change is — and each of them carries its own picture.
export type Shot = {
  scene: number; at: number; seconds: number;
  // Which take of that scene this is, so the shot can be given its own picture rather than repeating one.
  take: number;
  // A punch-in, where a stressed word earned one: scale to `to`, starting at `at`, over `seconds`.
  punch?: { to: number; at: number; seconds: number };
  // The word this shot turns on, if it has one. What the caption highlights and what a graphic lands on.
  keyword?: string;
  // Where in the film that word is said, for anything that has to hit with it.
  keyAt?: number;
};

export type Cue = { sound: Sfx; at: number; gain?: number };
// Where the bed has to get out of the way, and by how much.
export type Duck = { at: number; seconds: number; db: number };

export type Edit = { shots: Shot[]; cues: Cue[]; ducks: Duck[]; total: number; changesPer10s: number };

// What the editor is given: the scenes in order, each with the span of narration said over it, and the timings.
export type Take = {
  scene: Scene; index: number;
  // When the line over this scene starts and ends, in film time. A scene with nothing said over it carries its own
  // length instead.
  from: number; to: number;
  // Whether this scene already fills the frame with something moving, in which case it is never split or punched:
  // a clip has its own motion and a second one on top of it is two effects on one element.
  moving?: boolean;
  // How long the scene must hold at the least — a piece of footage is as long as the piece of footage.
  least?: number;
};

// A cut is deterministic but it must not be regular, so the spread comes out of the shot's own place in the film
// rather than out of a random number. The same film edits the same way every time it is rendered.
const wobble = (seed: number): number => {
  const spun = Math.sin(seed * 12.9898) * 43758.5453;
  return (spun - Math.floor(spun)) * 2 - 1;
};

// The word a line turns on: the longest word that carries meaning, which is what a viewer's eye goes to and what
// a highlight, a hit or a punch-in should land on. Stop words are never it.
export function keywordOf(said: string, emphasis?: string): string | undefined {
  const asked = emphasis?.trim();
  if (asked && content(asked).length) return asked.split(/\s+/)[0];
  const words = content(said);
  if (!words.length) return undefined;
  return [...words].sort((a, b) => b.length - a.length)[0];
}

// Where that word is said, in film time.
export const whenSaid = (words: Word[], keyword?: string): number | undefined => {
  if (!keyword) return undefined;
  const bare = keyword.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const found = words.find((one) => one.word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') === bare);
  return found ? found.at : undefined;
};

// The whole edit.
//
// It is worked out twice over if it has to be. The first pass cuts at the style's own mean; if that leaves the film
// changing picture less often than the style says it must — below four changes in ten seconds retention falls away,
// and the founder's film was at two and a half — the mean is brought in and it is cut again, down to the floor of
// 1.2 seconds and no further. A target that is written down and not met is not a target.
export function editFilm(takes: Take[], words: Word[], style: Cutting, opts: { sfxOn?: boolean; payoff?: number } = {}): Edit {
  let made = cutOnce(takes, words, style, opts);
  for (let again = 0; again < 3 && made.changesPer10s < style.changes[0]; again += 1) {
    const tighter = Math.max(style.min * 1.05, style.mean * 0.78);
    if (tighter >= style.mean - 0.01) break;
    style = { ...style, mean: tighter };
    const next = cutOnce(takes, words, style, opts);
    if (next.shots.length <= made.shots.length) break;
    made = next;
  }
  return made;
}

function cutOnce(takes: Take[], words: Word[], style: Cutting, opts: { sfxOn?: boolean; payoff?: number }): Edit {
  const phrases = phrasesIn(words);
  const shots: Shot[] = [];
  // The payoff gets the one long hold a film is allowed. Unsaid, it is the scene before the close, because that is
  // where the argument lands and the last scene is the ask.
  const payoff = opts.payoff ?? Math.max(0, takes.length - 2);

  for (const take of takes) {
    const span = Math.max(take.least ?? 0, take.to - take.from);
    const inner = insidePhrases(phrases, take.from, take.from + span);
    const keyword = keywordOf(`${take.scene.text ?? ''} ${take.scene.heading ?? ''} ${take.scene.say ?? ''}`, take.scene.emphasis);
    const keyAt = whenSaid(words, keyword);
    // A moving shot is one shot, whatever its length: it already changes picture sixty times a second.
    // The payoff is one shot too — that is what a hold is.
    // A scene is one shot when it is about the length the style wants a shot to be. Holding anything half again
    // as long as that is where "the same shot for three seconds" comes from, and `style.max` was far too generous
    // a line to draw it at.
    // …except at the opening. The first two seconds decide whether anybody sees the third, and a hook that has
    // not changed picture by two and a half seconds is a hook nobody is still watching: a real reel held its
    // opening headline unchanged for five. So the opening is cut inside whatever the distribution would have
    // said, whenever there is room to cut it at all.
    const hook = take.index === 0 && !take.moving && span > HOOK_CHANGE + style.min;
    const whole = !hook && (take.moving || take.index === payoff || span <= style.mean * 1.35);
    const edges = whole ? [] : splitPoints(take.from, span, style, inner, take.index, words, hook ? HOOK_CHANGE : 0);
    const points = [take.from, ...edges, take.from + span];
    for (let at = 0; at < points.length - 1; at += 1) {
      const seconds = Math.round((points[at + 1] - points[at]) * 1000) / 1000;
      if (seconds <= 0) continue;
      shots.push({
        scene: take.index, at: Math.round(points[at] * 1000) / 1000, seconds, take: at,
        keyword: at === 0 ? keyword : undefined,
        keyAt: at === 0 ? keyAt : undefined,
      });
    }
  }

  // Punch-ins. Only on a stressed word, only where the shot has no motion of its own, and never on two neighbours:
  // one move per element, and a film where every shot pushes is a film that never sits still.
  let lastPunch = -2;
  shots.forEach((shot, at) => {
    const take = takes[shot.scene];
    if (take?.moving) return;
    // A shot with nothing to look at but type does not push; it is the type that moves.
    const word = shot.keyAt;
    const inside = word !== undefined && word >= shot.at && word < shot.at + shot.seconds;
    // A shot held past three seconds has to move whether or not there is a word under it, because a static frame
    // past three seconds is where viewers leave — but then it moves slowly, as a camera does, not as a zoom does.
    const stale = shot.seconds > 3;
    if (!inside && !stale) return;
    // Two punch-ins in a row is a film that never sits still, so a shot next to one that already pushed goes
    // without — unless it would otherwise be held still past three seconds, which is where viewers leave. That
    // is not a punch anyway: it is a slow camera, and two of those running on is what a camera does.
    if (at - lastPunch < 2 && !stale) return;
    lastPunch = at;
    const [near, far] = style.punch;
    const reach = inside ? far : near;
    const from = inside ? Math.max(shot.at, word! - 0.08) : shot.at;
    shot.punch = { to: Math.round(reach * 1000) / 1000, at: Math.round(from * 1000) / 1000, seconds: inside ? 0.3 : Math.min(shot.seconds, 4) };
  });

  const total = shots.length ? Math.round((shots.at(-1)!.at + shots.at(-1)!.seconds) * 1000) / 1000 : 0;
  const cues = opts.sfxOn === false ? [] : soundsFor(shots, takes, style, total);
  // Where the bed has to get out of the way: under the narration, and nowhere else. A film with nobody speaking
  // has nothing to duck for, and a bed pulled down twenty decibels under silence is a bed that never arrives.
  const ducks = words.length
    ? takes
      .filter((take) => take.to > take.from && spokenIn(words, take))
      .map((take): Duck => ({ at: Math.round(take.from * 1000) / 1000, seconds: Math.round((take.to - take.from) * 1000) / 1000, db: style.duck[1] }))
    : [];
  return { shots, cues, ducks, total, changesPer10s: total ? Math.round((shots.length / total) * 100) / 10 : 0 };
}

// Where a scene that runs long is cut in two, three or four: at the phrase boundaries nearest the lengths the
// style's own distribution asks for. Never inside a thought, never under the floor — and, where no boundary is
// within reach at all, never inside a *word* either. A cut landing on the second syllable of "evidence" is the
// thing that reads as a mistake rather than as an edit, and a scene of one unbroken sentence would otherwise get
// one every time.
function splitPoints(from: number, span: number, style: Cutting, inner: Phrase[], seed: number, words: Word[], firstAt = 0): number[] {
  const want = Math.max(firstAt ? 2 : 1, Math.round(span / style.mean));
  if (want < 2) return [];
  const edges: number[] = [];
  let cursor = from;
  for (let at = 1; at < want; at += 1) {
    // Each shot's own length out of the distribution: the mean, nudged by where it sits, floored and capped.
    const nudged = style.mean + wobble(seed * 7.13 + at * 3.77) * style.spread;
    // The opening's first shot is capped however calm the film is: the hook has to change picture inside it.
    const ceiling = at === 1 && firstAt ? Math.min(style.max, firstAt) : style.max;
    const length = Math.min(ceiling, Math.max(style.min, nudged));
    const asked = cursor + length;
    if (asked >= from + span - style.min) break;
    const phrase = nearestPhrase(inner, asked);
    // A boundary that cannot be reached without breaking the floor either side is not a boundary worth having.
    const ok = phrase !== null && phrase - cursor >= style.min && from + span - phrase >= style.min;
    let landed = ok ? phrase! : betweenWords(words, asked);
    // The opening's cap is a cap, not a preference. A phrase boundary half a second the wrong side of it is still
    // the wrong side of it, and a hook that has not changed picture by two and a half seconds is a hook nobody is
    // watching by then — a real reel reported that fault and shipped with it. So when the nearest boundary lands
    // late, the last one that lands in time is taken instead, and failing that the gap between two words.
    if (at === 1 && firstAt && landed > from + firstAt + 0.01) {
      const inTime = inner.flatMap((one) => [one.at, one.at + one.seconds])
        .filter((edge) => edge - cursor >= style.min && edge <= from + firstAt + 0.01 && from + span - edge >= style.min);
      landed = inTime.length ? Math.max(...inTime) : betweenWords(words, from + firstAt);
    }
    const edge = Math.round(landed * 1000) / 1000;
    if (edge - cursor < style.min || from + span - edge < style.min) break;
    edges.push(edge);
    cursor = edge;
  }
  return edges;
}

// The nearest moment nobody was mid-word. Where a scene holds one unbroken sentence there is no phrase boundary
// to take, and this is the floor under the whole thing: a cut is at worst between two words.
function betweenWords(words: Word[], at: number): number {
  let best = at;
  let gap = Infinity;
  for (const word of words) {
    for (const edge of [word.at, word.at + word.seconds]) {
      const far = Math.abs(edge - at);
      if (far < gap) { gap = far; best = edge; }
    }
  }
  return best;
}

// Whether anybody is actually speaking over this scene, rather than it merely having a window on the clock.
const spokenIn = (words: Word[], take: Take): boolean =>
  words.some((one) => one.at >= take.from - 0.2 && one.at < take.to + 0.2);

const insidePhrases = (phrases: Phrase[], from: number, to: number): Phrase[] =>
  phrases.filter((one) => one.at >= from - 0.01 && one.at + one.seconds <= to + 0.01);

// The sounds. Five at the most in a whole film, each one on the frame of a cut, and each one earning its place:
// the opening, the payoff, the close, and whichever cuts in between are biggest. An effect on every cut is what
// makes a film sound like a template.
const WHICH: Partial<Record<Layout, Sfx>> = {
  hook: 'hard', stat: 'accent', logo: 'sting', cta: 'accent', compare: 'turn', checklist: 'mark', steps: 'tick',
};
function soundsFor(shots: Shot[], takes: Take[], style: Cutting, total: number): Cue[] {
  const scored = shots
    .map((shot, at) => ({ shot, at, layout: takes[shot.scene]?.scene.layout }))
    // Only the head of a scene is a moment; the picture changes inside one are rhythm, not events.
    .filter((one) => one.shot.take === 0)
    .map((one) => ({
      ...one,
      // What makes a cut worth a sound: it opens the film, it closes it, it is the payoff, or its scene is one of
      // the shapes that lands on something — a figure arriving, a wordmark dropping.
      weight: (one.at === 0 ? 3 : 0) + (one.at === shots.length - 1 ? 2 : 0) + (one.layout && WHICH[one.layout] ? 2 : 0),
      sound: (one.layout && WHICH[one.layout]) || ('cut-soft' as Sfx),
    }))
    .filter((one) => one.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.at - b.at)
    .slice(0, style.sfx)
    .sort((a, b) => a.at - b.at);
  return scored.map((one) => ({ sound: one.sound, at: Math.min(total, Math.max(0, one.shot.at)) }));
}

// --- reading the cut back ---------------------------------------------------------------------------------
//
// Everything above makes the shot list. This reads it, and it is the assertion under the two rules that were
// written down and then not met on three real films: the opening still had not changed picture five seconds in,
// and a list of bullets sat over one blurred field for the length of a whole scene.
//
// A finding here is worth saying out loud and is not worth withholding the film over — every one of them is a
// judgement about rhythm rather than a fault that would break a render — so it is reported, not thrown.
export type Note = { rule: string; at: number; says: string };

// How long a frame may sit still. Past three seconds a static frame is where viewers leave, and the only things
// that earn longer are a picture change, a move on the picture, or words arriving on it.
export const MOST_HELD = 3.0;
// How long the opening may hold its first picture. The first two seconds decide whether anybody sees the third.
export const HOOK_CHANGE = 2.5;

// Whether words arrive on this shot: a scene's first take is where its type lands, so it has a beat of its own
// even if nothing moves on the picture. A later take of the same scene shows the same words already settled.
const hasType = (shot: Shot, scene: Scene): boolean =>
  shot.take === 0 && [scene.heading, scene.text, ...(scene.bullets ?? [])].some((one) => one?.trim());

export function checkCut(shots: Shot[], scenes: Scene[], moving: boolean[] = []): Note[] {
  const notes: Note[] = [];
  shots.forEach((shot, at) => {
    const scene = scenes[shot.scene];
    if (!scene || moving[shot.scene]) return;
    if (shot.seconds > MOST_HELD + 0.01 && !shot.punch && !hasType(shot, scene)) {
      notes.push({ rule: 'held', at, says: `shot ${at + 1} holds one still frame for ${shot.seconds.toFixed(1)} seconds with nothing arriving on it` });
    }
  });
  const opening = shots.filter((one) => one.scene === 0);
  const first = opening[0];
  const whole = shots.reduce((sum, one) => sum + one.seconds, 0);
  // A moving opening changes picture sixty times a second, so it answers the rule by being what it is.
  if (first && !moving[0] && whole > HOOK_CHANGE * 2 && first.seconds > HOOK_CHANGE + 0.01) {
    notes.push({ rule: 'hook', at: 0, says: `the opening picture holds for ${first.seconds.toFixed(1)} seconds — a hook changes picture inside ${HOOK_CHANGE}` });
  }
  return notes;
}
