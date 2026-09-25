import { rgbOf } from './templates/packs.ts';

// Whether the words can actually be read off the picture under them.
//
// A scrim is the wash of the film's own ground laid over a photograph so type can sit on it, and until now it was
// one number a pack: every picture in a `documentary` film got the same 0.42 whether it was a black doorway or a
// white wall. Both ways of being wrong were in the proof films — body copy over a pale photograph with no contrast
// at all, and a whole reel of near-black because the hold was heavy and the photographs were already dark.
//
// So it is measured. The rendered still is sampled where the type is going to be, the brightness there is turned
// into the contrast ratio the type would really have, and the hold is the smallest one that gets that ratio over
// the line. A dark picture gets almost nothing; a white wall gets most of a wash. Nobody has to guess.

// The ratio a line of body copy needs over a picture. This is WCAG's figure for normal text, and it is the right
// one even though a film is not a web page: a caption read at arm's length in daylight on a phone is a harder
// case than a paragraph on a screen, not an easier one.
export const WANTS = 4.5;
// Large display type is legible at a lower ratio, and holding a picture down to 4.5 behind a headline the size of
// a poster is turning the picture off for no reason.
export const WANTS_BIG = 3.0;

// One channel of sRGB, straightened out. Everything below is the standard relative-luminance formula.
const straight = (channel: number): number => {
  const part = channel / 255;
  return part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
};
export const luminance = (rgb: [number, number, number]): number =>
  0.2126 * straight(rgb[0]) + 0.7152 * straight(rgb[1]) + 0.0722 * straight(rgb[2]);

export const ratio = (one: [number, number, number], other: [number, number, number]): number => {
  const [a, b] = [luminance(one), luminance(other)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

// A picture with a wash of one colour over it, at one opacity, per channel. This is what the renderer really
// draws, so it is what the measurement has to work on.
export const washed = (under: [number, number, number], wash: [number, number, number], hold: number): [number, number, number] =>
  [0, 1, 2].map((at) => Math.round(under[at] * (1 - hold) + wash[at] * hold)) as [number, number, number];

// The smallest hold that gets the type over the line, to two decimal places. Nothing here goes past 0.92: a film
// whose pictures are entirely covered by their own scrim is a film with no pictures in it, and at that point the
// honest answer is a different picture rather than a heavier wash.
export const MOST = 0.92;
export function holdFor(under: [number, number, number], ink: string, wash: string, wants = WANTS, floor = 0): number {
  const type = rgbOf(ink) ?? [255, 255, 255];
  const over = rgbOf(wash) ?? [0, 0, 0];
  for (let hold = Math.max(0, floor); hold <= MOST + 0.001; hold = Math.round((hold + 0.02) * 100) / 100) {
    if (ratio(type, washed(under, over, hold)) >= wants) return Math.round(hold * 100) / 100;
  }
  return MOST;
}

// Where on a frame the words sit, as fractions of the frame, so the same numbers work at any size. These are read
// off the stylesheet's own boxes rather than invented: the block of type sits in the lower half of a picture
// scene, at the head of the frame in a captioned one, and the caption band is its own strip near the foot.
export type Box = { x: number; y: number; w: number; h: number };
export const BOXES: Record<'foot' | 'top' | 'caps', Box> = {
  foot: { x: 0, y: 0.58, w: 1, h: 0.42 },
  top: { x: 0, y: 0, w: 1, h: 0.42 },
  caps: { x: 0.06, y: 0.62, w: 0.88, h: 0.2 },
};

// The brightest part of a region, rather than its average. An average hides the white window in the corner of an
// otherwise dark room, and the white window is exactly where the line of type stops being readable. The ninetieth
// percentile is the compromise: one bright pixel does not decide the whole frame, and a bright quarter of it does.
export function brightest(pixels: [number, number, number][], part = 0.9): [number, number, number] {
  if (!pixels.length) return [128, 128, 128];
  const sorted = [...pixels].sort((a, b) => luminance(a) - luminance(b));
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * part))];
}

// The picture itself, sampled. `sharp` is asked for at the moment it is needed rather than at the top of the file,
// because a machine without it should lose the measurement and keep the film: a scrim that falls back to the
// pack's own number is what every film had until now.
export async function sampleOf(file: string, box: Box, wide = 24): Promise<[number, number, number][] | null> {
  try {
    const { default: sharp } = await import('sharp');
    const image = sharp(file);
    const { width, height } = await image.metadata();
    if (!width || !height) return null;
    const left = Math.max(0, Math.min(width - 1, Math.round(box.x * width)));
    const top = Math.max(0, Math.min(height - 1, Math.round(box.y * height)));
    const region = {
      left, top,
      width: Math.max(1, Math.min(width - left, Math.round(box.w * width))),
      height: Math.max(1, Math.min(height - top, Math.round(box.h * height))),
    };
    const { data, info } = await image.extract(region).resize(wide, wide, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels: [number, number, number][] = [];
    for (let at = 0; at + 2 < data.length; at += info.channels) pixels.push([data[at], data[at + 1], data[at + 2]]);
    return pixels;
  } catch { return null; }
}

// The whole job, for one picture: how hard it has to be held down for the words on it to be read. `null` means
// nothing could look at it, and the caller keeps the pack's own number.
export async function scrimFor(file: string, where: 'foot' | 'top' | 'caps', ink: string, wash: string, opts: { big?: boolean; floor?: number } = {}): Promise<number | null> {
  const pixels = await sampleOf(file, BOXES[where]);
  if (!pixels?.length) return null;
  return holdFor(brightest(pixels), ink, wash, opts.big ? WANTS_BIG : WANTS, opts.floor ?? 0);
}

// How dark a graded still has come out, as a number between nought and one. The documentary pack wears a grade as
// a declared format, and a grade over an already dark photograph is how "dim and murky, subjects unreadable"
// happens: the fix is to lift the picture, not to drop the grade, because the grade is the house look.
export async function meanLight(file: string): Promise<number | null> {
  const pixels = await sampleOf(file, { x: 0, y: 0, w: 1, h: 1 }, 32);
  if (!pixels?.length) return null;
  return pixels.reduce((sum, one) => sum + luminance(one), 0) / pixels.length;
}

// A picture too dark to read a subject out of, lifted until it is. The numbers are small on purpose: this is a
// correction to one still, not a look, and anything past a quarter is a different photograph.
export const LIFT_BELOW = 0.16;
export const liftFor = (light: number): number =>
  (light >= LIFT_BELOW ? 1 : Math.min(1.28, Math.round((LIFT_BELOW / Math.max(0.04, light)) * 100) / 100));

// --- the lift, done properly --------------------------------------------------------------------------------

// `liftFor` above is a gain: every pixel multiplied by one number, in the page, by a CSS filter. It is the
// fallback, and it is a blunt one — a gain strong enough to open up a dark room burns out the one lamp in it.
// What a colourist does instead is raise the shadows and leave the highlights where they are, which is a gamma
// curve, and a curve is something only the file can carry. So a still that came back too dark is rewritten
// through one, once, before anything measures it: the scrim is then solved against the picture a viewer will
// really see, and the gain in the page has nothing left to do.
//
// The target is a mean a viewer reads as "a dim room" rather than "a black frame". It is deliberately under a
// well-lit photograph's: this look is available light, and a lift that turned dusk into noon would be a
// different picture. The exponent has a floor for the same reason.
export const LIGHT_ENOUGH = 0.10;
export const LIFT_TO = 0.13;
export const LEAST_GAMMA = 0.62;

// The exponent that takes a picture of this mean light to the target. The mean of a curve is not the curve of
// the mean, so this is a first guess and `lighten` measures what it really did.
export const gammaFor = (light: number): number =>
  (light >= LIGHT_ENOUGH ? 1 : Math.max(LEAST_GAMMA, Math.round((Math.log(LIFT_TO) / Math.log(Math.max(0.004, light))) * 100) / 100));

// Rewrites one still through the curve, in place, and says what it did. `null` means nothing here could open
// the file, and the page's own gain stands in, as it always has.
export async function lighten(file: string): Promise<{ from: number; gamma: number } | null> {
  const from = await meanLight(file);
  if (from === null) return null;
  const gamma = gammaFor(from);
  if (gamma >= 1) return { from, gamma: 1 };
  try {
    const { default: sharp } = await import('sharp');
    const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const curve = Uint8Array.from({ length: 256 }, (_one, value) => Math.round(255 * (value / 255) ** gamma));
    for (let at = 0; at < data.length; at += 1) data[at] = curve[data[at]];
    const lifted = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
    const out = /\.jpe?g$/i.test(file) ? lifted.jpeg({ quality: 92 }) : /\.webp$/i.test(file) ? lifted.webp({ quality: 92 }) : lifted.png();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, await out.toBuffer());
    return { from, gamma };
  } catch { return null; }
}

// --- a picture with nothing in it --------------------------------------------------------------------------------

// A picture model asked for something quiet sometimes hands back a sheet of paper: a white frame, or a black one,
// with nothing on it. Nothing downstream of it could tell — the scrim was solved, the words were set — and a frame
// of plain white went out in the site's own hero film. It is measured here the way an eye would: how light the whole
// frame is, and how little it changes across itself. Very light or very dark is not enough on its own, a snowfield
// or a night sky are both real; very light or very dark *and* flat is nothing.
export const BLANK_LIGHT = 0.92;
export const BLANK_DARK = 0.05;
export const BLANK_SPREAD = 0.04;
export type Blankness = { light: number; spread: number };

export async function blankness(file: string): Promise<Blankness | null> {
  try {
    const { default: sharp } = await import('sharp');
    const { data } = await sharp(file).removeAlpha().resize(48, 27, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    if (!data.length) return null;
    let sum = 0;
    for (const value of data) sum += value / 255;
    const light = sum / data.length;
    let spread = 0;
    for (const value of data) spread += (value / 255 - light) ** 2;
    return { light, spread: Math.sqrt(spread / data.length) };
  } catch { return null; }
}

// A picture that could not be read is not called blank: that is somebody else's failure to report.
export const isBlank = (seen: Blankness | null | undefined): boolean =>
  !!seen && (seen.light > BLANK_LIGHT || seen.light < BLANK_DARK) && seen.spread < BLANK_SPREAD;
