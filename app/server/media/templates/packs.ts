// The looks a film can wear, and what each one actually means once it is moving. A pack is not a palette with a
// different accent in it: it is a whole way of behaving — which typeface carries the display line, whether words
// arrive one at a time or a block at a time, what happens between two scenes, how loud the grain is, how the
// captions are set. A motion designer picks one of these and everything else follows from it, which is the point:
// coherence is what separates a film from a slideshow.

// What was found in the product's own code: the colours it paints itself with and the typeface it sets itself in.
export type Brand = { colours: string[]; font?: string; fontFile?: string; name?: string };

// A hex colour as the three numbers a scrim is written with, and how bright it is: a palette read off a product does
// not say which of its colours is the page and which is the ink, so the film works that out from the colours alone.
export function rgbOf(hex: string): [number, number, number] | null {
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex.trim());
  const full = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (short) return [parseInt(short[1] + short[1], 16), parseInt(short[2] + short[2], 16), parseInt(short[3] + short[3], 16)];
  if (full) return [parseInt(full[1], 16), parseInt(full[2], 16), parseInt(full[3], 16)];
  return null;
}
export const lightOf = (hex: string): number => { const rgb = rgbOf(hex); return rgb ? (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255 : 0.5; };
// How much colour a colour actually has. A product's palette is mostly greys — the page, the panel, the rule, the
// muted label — and the brightest of those is white, which is no accent at all. The signal has to be the one with
// colour in it.
export const chromaOf = (hex: string): number => {
  const rgb = rgbOf(hex);
  if (!rgb) return 0;
  const [high, low] = [Math.max(...rgb), Math.min(...rgb)];
  return high ? (high - low) / high : 0;
};
const mix = (hex: string, towards: [number, number, number], amount: number): string => {
  const rgb = rgbOf(hex) ?? [128, 128, 128];
  return `#${rgb.map((one, at) => Math.round(one + (towards[at] - one) * amount).toString(16).padStart(2, '0')).join('')}`;
};

export type Paint = { ground: string; ink: string; quiet: string; signal: string; mark: string; scrim: string; font?: string };

// What happens between two scenes. Every one of these is written on the film's own clock and runs inside the two
// scenes' own windows, because the renderer hides a timed section outside its window and two scenes can only overlap
// by the leaving one being given a little longer to leave in.
export const CUTS = ['fade', 'whip', 'zoom', 'wipe', 'push', 'cut'] as const;
export type Cut = (typeof CUTS)[number];

// How the words arrive. `kinetic` sets them one word at a time and lets each one land; `settle` moves the block as a
// block; `glide` drifts it up from further away and slower; `snap` is a hard, short arrival; `hand` is the notebook,
// where the pen does the moving.
export type Motion = 'kinetic' | 'settle' | 'glide' | 'snap' | 'hand';

export type PackStyle = {
  name: string;
  paint: Paint;
  // The typeface files this pack needs copied beside the film, and the families they are set in.
  fonts: { file: string; family: string }[];
  display: string;
  body: string;
  // A display line set in capitals reads as a poster; set as written it reads as a sentence.
  shout: boolean;
  motion: Motion;
  cuts: Cut[];
  // How much of a second two scenes share while one leaves and the next arrives.
  overlap: number;
  // A declared format: the grade and the bars this pack wears on every frame of every film in the series, so they
  // read as a house look rather than as a filter somebody switched on. `letterbox` is the fraction of the frame
  // each bar covers; `grade` is a CSS filter, and it is applied **to the pictures only** — never over the type,
  // never over the whole composite.
  //
  // Almost every pack leaves this undefined, and that is the point. A vignette and a grain sat over the whole
  // timeline of every film this studio made until now, and the founder's verdict on it was "obvious filter". The
  // test a look has to pass is the one the research states plainly: if the viewer notices the effect before the
  // story, it is too strong — and an effect the viewer cannot switch off, applied to footage that is meant to read
  // as present-day, is always too strong.
  format?: { letterbox?: number; grade?: string };
  // A sweep of colour drawn behind a headline as it arrives — the one piece of decoration a reel earns.
  sweep: boolean;
  // How hard a background picture is held down so type can sit on it.
  scrim: number;
  radius: number;
  // How wide a caption line runs against the format's own measure: a creator reel says two or three words at a time.
  capScale: number;
};

// The six. `clean` and `sketch` are what the studio had; `brand` still takes the product's own colours. `creator`,
// `editorial` and `neon` are the three a motion designer would actually reach for.
export const PACKS = ['clean', 'creator', 'editorial', 'neon', 'sketch', 'brand'] as const;
export type Pack = (typeof PACKS)[number];

const INTER = { file: 'inter.woff2', family: 'Studio Sans' };
const ANTON = { file: 'anton.woff2', family: 'Studio Shout' };
const SERIF = { file: 'instrument-serif.woff2', family: 'Studio Serif' };
const GROTESK = { file: 'space-grotesk.woff2', family: 'Studio Tech' };

export const PACK: Record<Pack, PackStyle> = {
  clean: {
    name: 'Clean',
    paint: { ground: '#1C2530', ink: '#F2F5F8', quiet: '#AFBDCB', signal: '#E8B04B', mark: '#E8B04B', scrim: '28, 37, 48' },
    fonts: [INTER], display: "'Studio Sans', sans-serif", body: "'Studio Sans', sans-serif",
    shout: false, motion: 'settle', cuts: ['fade', 'push', 'wipe'], overlap: 0.42,
    sweep: false, scrim: 0.66, radius: 22, capScale: 1,
  },
  creator: {
    // The reel: near-black, one acid accent, a condensed display face shouting, words landing two and three at a
    // time. Everything here is loud on purpose — a phone held at arm's length in daylight forgives nothing.
    name: 'Creator',
    paint: { ground: '#0C0D12', ink: '#FFFFFF', quiet: '#AEB3C4', signal: '#D6FF3E', mark: '#D6FF3E', scrim: '12, 13, 18' },
    fonts: [INTER, ANTON], display: "'Studio Shout', 'Studio Sans', sans-serif", body: "'Studio Sans', sans-serif",
    shout: true, motion: 'kinetic', cuts: ['whip', 'zoom', 'cut', 'whip', 'wipe'], overlap: 0.30,
    sweep: true, scrim: 0.74, radius: 18, capScale: 0.62,
  },
  editorial: {
    // The quiet one: a serif that has something to say, a great deal of air, pictures doing the arguing, and cuts you
    // barely notice. Nothing in it shouts, which is why the one thing that moves is believed.
    name: 'Editorial',
    paint: { ground: '#14120F', ink: '#F4EFE6', quiet: '#BDB2A4', signal: '#E4B45C', mark: '#D8A54A', scrim: '20, 18, 15' },
    fonts: [INTER, SERIF], display: "'Studio Serif', Georgia, serif", body: "'Studio Sans', sans-serif",
    shout: false, motion: 'glide', cuts: ['fade', 'wipe', 'fade', 'push'], overlap: 0.62,
    sweep: false, scrim: 0.62, radius: 4, capScale: 1.05,
  },
  neon: {
    // Tech: an almost-black ground, cyan against magenta, a grotesk with real character, and cuts that snap.
    name: 'Neon',
    paint: { ground: '#06070C', ink: '#E9F6FF', quiet: '#97A9C2', signal: '#3BE3FF', mark: '#FF42D6', scrim: '6, 7, 12' },
    fonts: [GROTESK, INTER], display: "'Studio Tech', 'Studio Sans', sans-serif", body: "'Studio Tech', 'Studio Sans', sans-serif",
    shout: true, motion: 'snap', cuts: ['zoom', 'wipe', 'cut', 'whip'], overlap: 0.26,
    sweep: true, scrim: 0.70, radius: 8, capScale: 0.78,
  },
  sketch: {
    name: 'Sketch',
    paint: { ground: '#F4F0E6', ink: '#1F1D1A', quiet: '#6B6660', signal: '#2B54C8', mark: '#FFD24A', scrim: '244, 240, 230' },
    fonts: [INTER], display: "'Studio Sans', sans-serif", body: "'Studio Sans', sans-serif",
    shout: false, motion: 'hand', cuts: ['fade', 'push'], overlap: 0.40,
    sweep: false, scrim: 0.50, radius: 16, capScale: 1,
  },
  brand: {
    // The product's own colours, over the clean pack's manners. What `paintOf` finds replaces the palette below.
    name: 'Brand',
    paint: { ground: '#1C2530', ink: '#F2F5F8', quiet: '#93A3B4', signal: '#E8B04B', mark: '#E8B04B', scrim: '28, 37, 48' },
    fonts: [INTER], display: "'Studio Sans', sans-serif", body: "'Studio Sans', sans-serif",
    shout: false, motion: 'settle', cuts: ['fade', 'push', 'zoom'], overlap: 0.40,
    sweep: false, scrim: 0.66, radius: 20, capScale: 1,
  },
};

export const isPack = (value: unknown): value is Pack => typeof value === 'string' && (PACKS as readonly string[]).includes(value);

// The product's palette made into a film's palette. The darkest colour that is dark enough becomes the ground (a film
// is watched, not read, and a bright ground on a screen is a lamp); the brightest saturated one becomes the signal.
export function paintOf(pack: Pack, brand?: Brand): Paint {
  if (pack !== 'brand') return PACK[pack].paint;
  const colours = (brand?.colours ?? []).map((one) => one.trim()).filter((one) => rgbOf(one));
  if (!colours.length) return PACK.clean.paint;
  const sorted = [...colours].sort((a, b) => lightOf(a) - lightOf(b));
  // The lightest colour that is still dark enough to be a ground: a product's palette usually holds both its page and
  // a pure black somewhere, and the page is the one it actually looks like.
  const dark = [...sorted].reverse().find((one) => lightOf(one) < 0.30);
  const ground = dark ?? mix(sorted[0], [16, 20, 26], 0.72);
  // The accent is the most coloured colour the product has, bright enough to be seen against its own ground; failing
  // that, the brightest. A near-white "signal" would make the whole film one flat grey.
  const colourful = colours.filter((one) => one !== ground && chromaOf(one) > 0.22 && lightOf(one) > 0.26)
    .sort((a, b) => chromaOf(b) * (0.4 + lightOf(b)) - chromaOf(a) * (0.4 + lightOf(a)));
  const bright = [...sorted].reverse().find((one) => lightOf(one) > 0.42 && one !== ground);
  const signal = colourful[0] ?? bright ?? sorted.at(-1)!;
  const ink = lightOf(ground) < 0.5 ? '#F6F8FA' : '#15181C';
  const rgb = rgbOf(ground)!;
  return { ground, ink, signal, mark: signal, quiet: mix(ink, rgb, 0.42), scrim: rgb.join(', '), font: brand?.font };
}

// Which cut this scene arrives on. The pack's list goes round, so the same film always cuts the same way and no two
// neighbours are the same move; the opening scene has nothing to arrive from, so it always fades up.
export const cutAt = (pack: Pack, index: number): Cut => (index === 0 ? 'fade' : PACK[pack].cuts[(index - 1) % PACK[pack].cuts.length]);
