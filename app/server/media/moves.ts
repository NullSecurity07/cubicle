import type { Layout, Scene } from './spec.ts';
import type { Pace } from './templates/looks.ts';
import type { Pack } from './templates/packs.ts';

// What the camera does.
//
// A still that sits dead on the screen is a slide, and a still that always does the same slow push is a slideshow
// with a transition on it. A film cuts between what the camera is doing as much as between what it is looking at, so
// every picture scene is handed one move out of a fixed table, the way every shot is handed a framing: dealt, not
// hoped for, so that no two neighbours move alike.
//
// The table is ours. The names are the ones any crew uses; the recipes and the words are written here.
//
//   - A **still** move is done in the page, on the picture we drew: a few keyframes of slide, scale and turn over
//     the length of the shot. It sits on a box of its own around the picture, so the look's own slow push and the
//     editor's punch-in still run inside it and the three multiply rather than overwrite each other.
//   - A **motion** move cannot be faked on a still. An orbit needs the far side of the subject and a tracking shot
//     needs somebody walking, so these are only ever asked of a real clip, in words the clip model reads.

export const MOVE_NAMES = [
  'static', 'push in', 'pull out', 'pan left', 'pan right', 'tilt up', 'tilt down', 'truck left', 'truck right',
  'pedestal up', 'pedestal down', 'slow zoom in', 'crash zoom in', 'whip pan', 'push past', 'parallax arc',
  'handheld', 'orbit', 'tracking', 'drone pull back', 'crane up',
] as const;
export type MoveName = (typeof MOVE_NAMES)[number];
export type Energy = 'calm' | 'steady' | 'brisk';

// One moment of a move on the picture's box: where it is, as a share of the shot, and how it sits then. `x` and `y`
// are percentages of the box, `scale` is a plain factor, `rotate` is degrees and `blur` pixels.
export type Frame = { at: number; x: number; y: number; scale: number; rotate?: number; blur?: number };
// A move as the page plays it. `zooms` says it changes the scale, which is what a punch-in also does; `travels`
// says it slides, which is what the look's own drift across a background also does.
export type Recipe = { frames: Frame[]; ease: string; zooms: boolean; travels: boolean };

export type Move = {
  name: MoveName;
  kind: 'still' | 'motion';
  energy: Energy;
  // One clause a clip model can read, appended to what the clip is of.
  wan: string;
  // Whether that clause reads well on a clip even though the move itself can be done on a still.
  wanReads: boolean;
  // The keyframes over a shot of that many seconds, or nothing: a static shot and a motion move draw no box.
  css: (seconds: number) => Recipe | null;
  // For a motion move, the still move nearest to it, for when the scene turns out to be a picture after all.
  still?: MoveName;
};

// How far a move goes over this shot. A short shot gets a shorter move rather than a faster one, because a picture
// that slides quickly is a picture sliding, not a camera moving. Five seconds is a whole move.
const reach = (seconds: number): number => Math.max(0.5, Math.min(1, seconds / 5));
// How much larger than the frame the picture has to be to slide that far without its edge coming into view. A slide
// of three per cent each way needs six per cent of spare picture, plus a hair so the edge never touches.
export const cover = (x: number, y: number): number => {
  const most = Math.max(Math.abs(x), Math.abs(y));
  return most ? Math.round((1 + (2 * most) / 100 + 0.01) * 10000) / 10000 : 1;
};
const round = (value: number): number => Math.round(value * 1000) / 1000;

// A slide from one side to the other at a scale that covers it the whole way. `dx` and `dy` are where the picture
// ends up, so a camera going left is a picture ending up to the right.
const slide = (dx: number, dy: number, ease: string) => (seconds: number): Recipe => {
  const much = reach(seconds);
  const x = round(dx * much);
  const y = round(dy * much);
  const scale = cover(x, y);
  return { frames: [{ at: 0, x: -x, y: -y, scale }, { at: 1, x, y, scale }], ease, zooms: false, travels: true };
};
// A change of scale from one to the other, centred.
const zoom = (from: number, to: number, ease: string) => (seconds: number): Recipe => {
  const much = reach(seconds);
  return { frames: [{ at: 0, x: 0, y: 0, scale: round(1 + (from - 1) * much) }, { at: 1, x: 0, y: 0, scale: round(1 + (to - 1) * much) }], ease, zooms: true, travels: false };
};

// The table. A pan swings the view, so it eases in and out the way a head turns; a truck or a pedestal is the whole
// camera on a slider, so it does not ease at all. Content moves the opposite way to the camera: a camera panning
// left sees the picture slide right.
const TABLE: Move[] = [
  { name: 'static', kind: 'still', energy: 'calm', wanReads: true, wan: 'the camera holds still on a tripod', css: () => null },
  { name: 'push in', kind: 'still', energy: 'calm', wanReads: true, wan: 'the camera moves slowly forward', css: zoom(1, 1.08, 'none') },
  { name: 'pull out', kind: 'still', energy: 'calm', wanReads: true, wan: 'the camera moves slowly back and the scene opens up', css: zoom(1.08, 1, 'none') },
  { name: 'pan left', kind: 'still', energy: 'steady', wanReads: true, wan: 'the camera turns slowly to the left', css: slide(3, 0, 'power1.inOut') },
  { name: 'pan right', kind: 'still', energy: 'steady', wanReads: true, wan: 'the camera turns slowly to the right', css: slide(-3, 0, 'power1.inOut') },
  { name: 'tilt up', kind: 'still', energy: 'steady', wanReads: true, wan: 'the camera tilts slowly upward', css: slide(0, 3, 'power1.inOut') },
  { name: 'tilt down', kind: 'still', energy: 'steady', wanReads: true, wan: 'the camera tilts slowly downward', css: slide(0, -3, 'power1.inOut') },
  { name: 'truck left', kind: 'still', energy: 'steady', wanReads: true, wan: 'the camera glides sideways to the left', css: slide(4, 0, 'none') },
  { name: 'truck right', kind: 'still', energy: 'steady', wanReads: true, wan: 'the camera glides sideways to the right', css: slide(-4, 0, 'none') },
  { name: 'pedestal up', kind: 'still', energy: 'calm', wanReads: true, wan: 'the camera rises straight up', css: slide(0, 3, 'none') },
  { name: 'pedestal down', kind: 'still', energy: 'calm', wanReads: true, wan: 'the camera sinks straight down', css: slide(0, -3, 'none') },
  { name: 'slow zoom in', kind: 'still', energy: 'calm', wanReads: true, wan: 'a slow, even zoom in', css: zoom(1, 1.05, 'sine.in') },
  {
    name: 'crash zoom in', kind: 'still', energy: 'brisk', wanReads: false, wan: 'a sudden fast zoom in',
    // Most of the move in the first third of a second, then it settles and creeps on, so the frame is not dead after.
    css: (seconds) => {
      const snap = Math.min(0.35, seconds * 0.3) / Math.max(seconds, 0.1);
      return { frames: [{ at: 0, x: 0, y: 0, scale: 1 }, { at: round(snap), x: 0, y: 0, scale: 1.16 }, { at: 1, x: 0, y: 0, scale: 1.19 }], ease: 'power4.out', zooms: true, travels: false };
    },
  },
  {
    name: 'whip pan', kind: 'still', energy: 'brisk', wanReads: false, wan: 'a fast whip pan with motion blur',
    // The picture arrives out of a smear from the side and then drifts on the way it came.
    css: (seconds) => {
      const land = Math.min(0.3, seconds * 0.25) / Math.max(seconds, 0.1);
      return { frames: [{ at: 0, x: 7, y: 0, scale: cover(7, 0), blur: 12 }, { at: round(land), x: 0.8, y: 0, scale: cover(7, 0), blur: 0 }, { at: 1, x: -0.8, y: 0, scale: cover(7, 0), blur: 0 }], ease: 'power3.out', zooms: false, travels: true };
    },
  },
  {
    name: 'push past', kind: 'still', energy: 'steady', wanReads: false, wan: 'the camera moves forward past something close in the foreground',
    css: (seconds) => {
      const much = reach(seconds);
      const x = round(3 * much);
      return { frames: [{ at: 0, x: x / 2, y: 0, scale: cover(x, 0) }, { at: 1, x: -x / 2, y: 0, scale: round(cover(x, 0) + 0.08 * much) }], ease: 'none', zooms: true, travels: true };
    },
  },
  {
    name: 'parallax arc', kind: 'still', energy: 'calm', wanReads: false, wan: 'the camera arcs gently around the subject, near and far apart',
    // On a still cut into planes the planes do the depth; the box adds only the curve of the arc.
    css: (seconds) => {
      const much = reach(seconds);
      const x = round(2 * much);
      const turn = round(0.6 * much);
      return { frames: [{ at: 0, x: -x, y: 0, scale: cover(x + 1, 0), rotate: -turn }, { at: 1, x, y: 0, scale: cover(x + 1, 0), rotate: turn }], ease: 'sine.inOut', zooms: false, travels: true };
    },
  },
  { name: 'handheld', kind: 'motion', energy: 'steady', wanReads: true, wan: 'handheld camera with a light, natural sway', css: () => null, still: 'static' },
  { name: 'orbit', kind: 'motion', energy: 'steady', wanReads: true, wan: 'the camera circles slowly around the subject', css: () => null, still: 'parallax arc' },
  { name: 'tracking', kind: 'motion', energy: 'steady', wanReads: true, wan: 'the camera travels alongside the subject as it moves', css: () => null, still: 'truck right' },
  { name: 'drone pull back', kind: 'motion', energy: 'calm', wanReads: true, wan: 'an aerial view rising and drawing back to show the whole place', css: () => null, still: 'pull out' },
  { name: 'crane up', kind: 'motion', energy: 'calm', wanReads: true, wan: 'the camera lifts up and over the scene', css: () => null, still: 'pedestal up' },
];

export const MOVES: Record<MoveName, Move> = Object.fromEntries(TABLE.map((one) => [one.name, one])) as Record<MoveName, Move>;
export const stillMoves: Move[] = TABLE.filter((one) => one.kind === 'still');
export const motionMoves: Move[] = TABLE.filter((one) => one.kind === 'motion');

// The words a model writes for a move that is on the table under another name. Anything else is not a move.
const ALIASES: Record<string, MoveName> = {
  'none': 'static', 'still': 'static', 'locked off': 'static', 'locked': 'static', 'tripod': 'static', 'hold': 'static',
  'dolly in': 'push in', 'push': 'push in', 'ken burns': 'push in', 'slow push': 'push in', 'slow push in': 'push in',
  'dolly out': 'pull out', 'pull back': 'pull out', 'pullback': 'pull out',
  'zoom in': 'slow zoom in', 'zoom': 'slow zoom in', 'crash zoom': 'crash zoom in', 'snap zoom': 'crash zoom in',
  'whip': 'whip pan', 'swish pan': 'whip pan', 'parallax': 'parallax arc', 'arc': 'parallax arc',
  'handheld camera': 'handheld', 'hand held': 'handheld', 'orbit shot': 'orbit', 'track': 'tracking', 'tracking shot': 'tracking',
  'drone': 'drone pull back', 'aerial': 'drone pull back', 'crane': 'crane up', 'jib up': 'crane up',
  'truck': 'truck right', 'pan': 'pan right', 'tilt': 'tilt up', 'pedestal': 'pedestal up',
};
// A move's name as written, flattened: "Push-In", "push_in" and " push in " are one move.
export const moveName = (value: unknown): string =>
  (typeof value === 'string' ? value : '').toLowerCase().replace(/[-_]+/g, ' ').replace(/[^a-z ]+/g, '').replace(/\s+/g, ' ').trim();
export function moveOf(name: unknown): Move | undefined {
  const flat = moveName(name);
  if (!flat) return undefined;
  const known = (MOVE_NAMES as readonly string[]).includes(flat) ? flat as MoveName : ALIASES[flat];
  return known ? MOVES[known] : undefined;
}

// The still move to use where a motion move was asked of a still picture.
export const stillOf = (name: unknown): Move | undefined => {
  const move = moveOf(name);
  if (!move) return undefined;
  return move.kind === 'still' ? move : MOVES[move.still ?? 'static'];
};

// The same move the other way. A scene cut into several shots keeps its move but turns it round on every other shot,
// so a pan left is answered by a pan right across the cut rather than the same slide twice.
const MIRROR: Partial<Record<MoveName, MoveName>> = {
  'pan left': 'pan right', 'pan right': 'pan left', 'tilt up': 'tilt down', 'tilt down': 'tilt up',
  'truck left': 'truck right', 'truck right': 'truck left', 'pedestal up': 'pedestal down', 'pedestal down': 'pedestal up',
  'push in': 'pull out', 'pull out': 'push in',
};
// A move that does not change the scale, for a shot that already has the editor's punch-in on it. Two zooms on one
// picture is two cameras.
const ZOOMLESS: Partial<Record<MoveName, MoveName>> = {
  'push in': 'static', 'pull out': 'static', 'slow zoom in': 'static', 'crash zoom in': 'static', 'push past': 'truck left',
};
export const zooms = (move: Move): boolean => !!move.css(4)?.zooms;

// The move one shot really plays. `take` is which shot of its scene this is; `punched` says the editor pushed in on
// it. Anything that is not a still move, or is not a move at all, plays as nothing.
export function settle(name: unknown, shot: { take?: number; punched?: boolean } = {}): Move | undefined {
  let move = stillOf(name);
  if (!move) return undefined;
  if ((shot.take ?? 0) % 2 === 1 && MIRROR[move.name]) move = MOVES[MIRROR[move.name]!];
  if (shot.punched && zooms(move)) move = MOVES[ZOOMLESS[move.name] ?? 'static'];
  return move;
}

// --- dealing them out -------------------------------------------------------------------------------------------

// Which scenes take a move. A picture scene is a still we drew and takes a still move; a clip scene is a moving shot
// and takes one the clip model can be asked for. Everything else sits on the look's own drift behind its words.
export const takesMove = (layout: Layout): 'still' | 'motion' | null => (layout === 'picture' ? 'still' : layout === 'clip' ? 'motion' : null);

// The order moves are offered in, per register. Each wheel is written so no two neighbours on it are the same kind
// of move, and the deal turns it with the scene's place in the film.
const WHEELS: Record<'calm' | 'steady' | 'brisk', MoveName[]> = {
  // Documentary and editorial: the camera is on a slider or a tripod and never hurries.
  calm: ['push in', 'pan right', 'pedestal up', 'slow zoom in', 'truck left', 'tilt down', 'pull out', 'parallax arc', 'pan left', 'truck right'],
  steady: ['truck right', 'push in', 'pan left', 'tilt up', 'slow zoom in', 'truck left', 'push past', 'pedestal up', 'pan right', 'pull out'],
  // A feed: the fast moves lead, with a steady one between each so the film is not all smear.
  brisk: ['crash zoom in', 'truck right', 'whip pan', 'push past', 'pan left', 'crash zoom in', 'tilt up', 'whip pan', 'truck left'],
};
const CLIP_WHEELS: Record<'calm' | 'steady' | 'brisk', MoveName[]> = {
  calm: ['drone pull back', 'crane up', 'push in', 'orbit', 'pan right'],
  steady: ['tracking', 'orbit', 'crane up', 'handheld', 'truck left'],
  brisk: ['handheld', 'tracking', 'orbit', 'truck right', 'crane up'],
};
// Which register a film moves in. The quiet looks are calm whatever the pace; the feed looks are brisk; the rest
// follow the pace the founder chose.
export const registerOf = (pace: Pace | undefined, look: Pack | undefined): 'calm' | 'steady' | 'brisk' => {
  if (look === 'documentary' || look === 'editorial') return 'calm';
  if (look === 'creator' || look === 'neon') return 'brisk';
  return pace === 'punchy' ? 'steady' : 'calm';
};
const ENERGIES: Record<'calm' | 'steady' | 'brisk', Energy[]> = { calm: ['calm', 'steady'], steady: ['calm', 'steady', 'brisk'], brisk: ['steady', 'brisk'] };

// Whether a move may be given to this scene at all: the right kind for what the scene is, and in the film's register.
export function fits(name: unknown, layout: Layout, register?: 'calm' | 'steady' | 'brisk'): boolean {
  const move = moveOf(name);
  const wants = takesMove(layout);
  if (!move || !wants) return false;
  if (wants === 'still' && move.kind !== 'still') return false;
  if (wants === 'motion' && move.kind === 'still' && !move.wanReads) return false;
  return !register || ENERGIES[register].includes(move.energy);
}

// Every picture and clip scene given a move where it has none. Deterministic, like the framing: the same storyboard
// is dealt the same moves every time.
//
//   - A move a scene already has is kept when it fits the scene; one that does not is the critic's to take off.
//   - Never the same move on two neighbouring scenes.
//   - The payoff (the scene before the close) and the close hold on a slow push, or stand still.
//   - A scene the editor punches into gets no move that zooms: `punched` names those scenes by their place.
export function dealMoves(scenes: Scene[], pace?: Pace, look?: Pack, opts: { punched?: ReadonlySet<number> } = {}): Scene[] {
  const register = registerOf(pace, look);
  const made = scenes.map((one) => ({ ...one }));
  const payoff = Math.max(0, made.length - 2);
  const last = made.length - 1;
  const name = (at: number) => (at >= 0 && at < made.length ? moveOf(made[at].move)?.name : undefined);
  made.forEach((scene, at) => {
    const wants = takesMove(scene.layout);
    if (!wants || (scene.move && moveOf(scene.move))) return;
    const punched = opts.punched?.has(at) ?? false;
    const free = (move: MoveName) => move !== name(at - 1) && move !== name(at + 1)
      && fits(move, scene.layout) && !(punched && zooms(MOVES[move]));
    // The hold: a slow push, or nothing at all when the push is taken next door or would fight a punch-in.
    if (at === payoff || at === last) {
      scene.move = ['push in', 'static'].find((one) => free(one as MoveName)) ?? 'static';
      return;
    }
    const wheel = (wants === 'still' ? WHEELS : CLIP_WHEELS)[register].filter((one) => fits(one, scene.layout, register));
    // Turned by the scene's place, then onward until something is free. A wheel of at least three always has one.
    const pick = wheel.map((_one, step) => wheel[(at + step) % wheel.length]).find(free);
    scene.move = pick ?? 'static';
  });
  return made;
}

// --- the shot: how big the subject is, and through what -----------------------------------------------------------

// The six sizes of shot, tightest first. A film cuts between them the way it cuts between framings.
export const SIZES = ['ecu', 'cu', 'mcu', 'ms', 'ws', 'ews'] as const;
export type Size = (typeof SIZES)[number];
// The five lenses a storyboard may name, in millimetres.
export const LENSES = [24, 35, 50, 85, 135] as const;
export type Lens = (typeof LENSES)[number];

// What a model writes for a size, read as one of ours.
const SIZE_WORDS: Record<string, Size> = {
  'extreme close up': 'ecu', 'extreme closeup': 'ecu', 'macro': 'ecu', 'close up': 'cu', 'closeup': 'cu', 'close': 'cu',
  'medium close up': 'mcu', 'medium closeup': 'mcu', 'medium': 'ms', 'medium shot': 'ms', 'mid shot': 'ms', 'mid': 'ms',
  'wide': 'ws', 'wide shot': 'ws', 'long shot': 'ws', 'establishing': 'ews', 'extreme wide': 'ews', 'extreme wide shot': 'ews',
  'extreme long shot': 'ews',
};
export function sizeOf(value: unknown): Size | undefined {
  const flat = moveName(value);
  if ((SIZES as readonly string[]).includes(flat)) return flat as Size;
  return SIZE_WORDS[flat];
}
// A lens as a number, or "85mm", or near enough to one of ours to be it. Anything else is nothing.
export function lensOf(value: unknown): Lens | undefined {
  const read = typeof value === 'number' ? value : Number(String(value ?? '').replace(/\s*mm$/i, '').trim());
  if (!Number.isFinite(read) || read < 10 || read > 300) return undefined;
  return LENSES.reduce((best, one) => (Math.abs(one - read) < Math.abs(best - read) ? one : best));
}

// The framings the picture pass deals out, as sizes. Wide takes the wide sizes, medium the middle ones, detail the
// tight ones; the other framings sit where their words put them.
export type Framing = 'wide' | 'medium' | 'detail' | 'object' | 'environment' | 'data';
export const SIZES_OF: Record<Framing, Size[]> = {
  wide: ['ws', 'ews'], environment: ['ws', 'ews'], medium: ['ms', 'mcu'], data: ['ms', 'mcu'], detail: ['cu', 'ecu'], object: ['cu', 'mcu'],
};
export const framingOf = (size: Size): Framing => (size === 'ws' || size === 'ews' ? 'wide' : size === 'ms' || size === 'mcu' ? 'medium' : 'detail');

// The lens a size is shot on when nobody said: wide sizes on a wide lens, tight ones on a long one.
export const LENS_OF: Record<Size, Lens> = { ews: 24, ws: 35, ms: 50, mcu: 85, cu: 85, ecu: 135 };
// A lens in the words a picture model reads. Never a person's name: a look belongs to the film, not to somebody else.
export function lensPhrase(lens?: Lens): string {
  if (lens === 85 || lens === 135) return 'shallow depth of field, compressed background';
  if (lens === 24 || lens === 35) return 'wide view, deep focus';
  return '';
}
// The two extremes of size said out loud, because the framing words stop at wide and detail.
export const SIZE_PHRASE: Partial<Record<Size, string>> = { ecu: 'an extreme close-up', ews: 'an extreme wide view, the place small in it' };

// The sizes a film's picture and clip scenes are dealt when the storyboard left them out. The wheel never repeats a
// size twice running and cuts between a far one and a near one, which is what makes a sequence read as edited.
const SIZE_WHEEL: Size[] = ['ws', 'mcu', 'cu', 'ms', 'ews', 'ecu'];
export function dealShots(scenes: Scene[]): Scene[] {
  let order = 0;
  return scenes.map((scene) => {
    if (!takesMove(scene.layout)) return scene;
    const place = order;
    order += 1;
    const shot = scene.shot ?? SIZE_WHEEL[place % SIZE_WHEEL.length];
    return { ...scene, shot, lens: scene.lens ?? LENS_OF[shot] };
  });
}
