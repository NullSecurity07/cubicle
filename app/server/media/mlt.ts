// A finished film written out as one MLT XML file, which Shotcut and Kdenlive both open as a project. The studio's
// film is rendered from a web page, and nobody can move a cut in a web page. This file is the same film laid out as
// tracks: the shots in order, the rendered film beside them to compare against, the narration, the bed, the sounds
// and the captions. A founder who wants one shot shorter drags one edge instead of asking for the whole film again.
//
// Nothing here reads a disk or runs a program. It is handed what the studio already knows and returns the text.

// The renderer's own frame rate, which it keeps unless a composition names another. Ours never does.
export const FPS = 30;

// One shot as an editor sees it: how long it holds, and what fills the frame. `image` and `video` are file names in
// the film's parts folder. `from` is where a moving picture starts inside its own file. `move` names a camera move the
// film made on a still, which this file cannot carry. `ground` is the look's own colour, for a shot with no picture.
export type EditShot = { seconds: number; image?: string; video?: string; from?: number; move?: string; ground: string; words?: string };
// A sound placed on the film's clock, and how loud the film played it.
export type EditSound = { file: string; at: number; seconds: number; gain?: number };
export type EditCaption = { text: string; at: number; seconds: number };
// Everything the file is written from. `film` is the rendered film's own file name, and `parts` the folder beside it
// that holds the pictures and the sound. Both are relative to where the `.mlt` sits, so the folder can be moved.
export type EditFilm = {
  title: string; width: number; height: number; fps: number;
  film: string; parts: string;
  shots: EditShot[];
  narration?: EditSound[]; bed?: EditSound; sounds?: EditSound[]; captions?: EditCaption[];
  // How the captions were set, as near as plain text gets: the look's ink and its type size in pixels.
  ink?: string; capSize?: number; capFoot?: number;
};

// What the studio hands the file maker: the film minus the two names only known once it is saved.
export type EditPlan = { film: Omit<EditFilm, 'film' | 'parts'>; files: { name: string; bytes: Buffer }[] };

// Every character XML cares about, in text and in quoted attributes alike.
export const xml = (text: string): string => text
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // A control character is not allowed in XML at all, even escaped.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
// Two dashes end a comment early, so a comment never carries them.
const remark = (text: string): string => text.replace(/-{2,}/g, '–').replace(/[<>&]/g, ' ');
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
// MLT reads "#RRGGBB" and "#AARRGGBB". Anything else the look might hold is read as black rather than guessed at.
export const colourOf = (hex: string, alpha = 'ff'): string => {
  const clean = /^#?([0-9a-f]{6})$/i.exec(hex.trim())?.[1] ?? /^#?([0-9a-f]{3})$/i.exec(hex.trim())?.[1]?.replace(/./g, (one) => one + one);
  return `#${alpha}${(clean ?? '000000').toLowerCase()}`;
};
// Dynamic text reads "#name#" as a field to fill in, so a caption keeps its words and loses its hashes.
const plain = (text: string): string => text.replace(/#/g, '').replace(/\s+/g, ' ').trim();

type Entry = { producer: string; in: number; out: number } | { blank: number };
// `length` is only for what has no length of its own: a still or a colour. A file with a clock keeps its own.
type Producer = { id: string; props: [string, string | number][]; filters?: [string, string | number][][]; note?: string; length?: number };

// A still or a colour is given four hours, as Shotcut gives one, so an edge can be dragged longer by hand.
const ENDLESS = 4 * 60 * 60;

// The shots' edges on the frame grid. Each edge is rounded once from the film's own clock, so a long film never
// drifts by a frame a shot the way rounding each length on its own would.
export function framesOf(seconds: number[], fps: number): number[] {
  const edges = [0];
  let clock = 0;
  for (const one of seconds) { clock += one; edges.push(Math.round(clock * fps)); }
  return edges.slice(1).map((edge, index) => Math.max(1, edge - edges[index]));
}

export function mltOf(film: EditFilm): string {
  const { fps } = film;
  const frames = (seconds: number) => Math.max(1, Math.round(seconds * fps));
  const at = (seconds: number) => Math.max(0, Math.round(seconds * fps));
  const part = (name: string) => `${film.parts}/${name}`;
  const endless = ENDLESS * fps;
  const producers: Producer[] = [];
  const add = (one: Producer) => { producers.push(one); return one.id; };

  // Video track 1: every shot, cut where the film cut it.
  const lengths = framesOf(film.shots.map((one) => one.seconds), fps);
  const total = lengths.reduce((sum, one) => sum + one, 0);
  const pictures: Entry[] = film.shots.map((shot, index) => {
    const length = lengths[index];
    const id = `shot${index + 1}`;
    if (shot.video) {
      const from = at(shot.from ?? 0);
      add({ id, props: [['resource', part(shot.video)]], note: shot.words });
      return { producer: id, in: from, out: from + length - 1 };
    }
    if (shot.image) {
      const note = [shot.words, shot.move ? `the film moved this still (${shot.move}); the move is not in this file, only the cut` : ''].filter(Boolean).join(' · ');
      add({ id, length: endless, props: [['resource', part(shot.image)], ['length', endless], ['ttl', 1]], note });
      return { producer: id, in: 0, out: length - 1 };
    }
    add({ id, length: endless, props: [['resource', colourOf(shot.ground)], ['mlt_service', 'color'], ['length', endless]], note: shot.words });
    return { producer: id, in: 0, out: length - 1 };
  });

  // Video track 2: the rendered film itself, hidden and silent, to lay beside the cut and compare.
  add({ id: 'film', props: [['resource', film.film]], note: 'the finished film, hidden and muted' });
  const rendered: Entry[] = [{ producer: 'film', in: 0, out: total - 1 }];

  // A track of things placed on the clock: a blank up to each, then the thing.
  const placed = (sounds: EditSound[], name: string): Entry[] => {
    const entries: Entry[] = [];
    let clock = 0;
    [...sounds].sort((a, b) => a.at - b.at).forEach((sound, index) => {
      const start = Math.max(clock, at(sound.at));
      const length = Math.min(frames(sound.seconds), Math.max(1, total - start));
      if (start >= total) return;
      if (start > clock) entries.push({ blank: start - clock });
      const id = `${name}${index + 1}`;
      const gain = sound.gain === undefined ? undefined : [['mlt_service', 'volume'], ['gain', sound.gain.toFixed(2)]] as [string, string | number][];
      add({ id, props: [['resource', part(sound.file)]], filters: gain ? [gain] : [] });
      entries.push({ producer: id, in: 0, out: length - 1 });
      clock = start + length;
    });
    return entries;
  };

  // Video track 3: one clear clip a caption line, with the line written on it. Plain text, in the look's ink.
  const lines = (film.captions ?? []).filter((one) => plain(one.text));
  const captions: Entry[] = [];
  let clock = 0;
  lines.forEach((line, index) => {
    const start = Math.max(clock, at(line.at));
    if (start >= total) return;
    const length = Math.min(frames(line.seconds), total - start);
    if (start > clock) captions.push({ blank: start - clock });
    const id = `caption${index + 1}`;
    const size = Math.round(film.capSize ?? film.height * 0.07);
    const foot = Math.round(film.capFoot ?? film.height * 0.12);
    add({
      id, length: endless, props: [['resource', '#00000000'], ['mlt_service', 'color'], ['length', endless]], filters: [[
        ['mlt_service', 'dynamictext'], ['argument', plain(line.text)],
        ['geometry', `0 ${film.height - foot - size * 2} ${film.width} ${size * 2} 1`],
        ['family', 'Sans'], ['size', size], ['weight', 700], ['fgcolour', colourOf(film.ink ?? '#ffffff')],
        ['olcolour', '#cc000000'], ['outline', 2], ['bgcolour', '#00000000'], ['halign', 'centre'], ['valign', 'bottom'], ['pad', 0],
      ]],
    });
    captions.push({ producer: id, in: 0, out: length - 1 });
    clock = start + length;
  });

  const narration = placed(film.narration ?? [], 'voice');
  const bed = film.bed ? placed([film.bed], 'bed') : [];
  const sounds = placed(film.sounds ?? [], 'sound');

  // The tracks, bottom first. An editor reads video tracks upward and audio tracks as sound only.
  type Track = { id: string; name: string; entries: Entry[]; hide?: 'video' | 'audio' | 'both'; audio?: boolean };
  const all: Track[] = [
    { id: 'pictures', name: 'V1 shots', entries: pictures },
    { id: 'rendered', name: 'V2 the finished film', entries: rendered, hide: 'both' },
    { id: 'captions', name: 'V3 captions', entries: captions },
    { id: 'narration', name: 'A1 narration', entries: narration, hide: 'video', audio: true },
    { id: 'music', name: 'A2 music', entries: bed, hide: 'video', audio: true },
    { id: 'sounds', name: 'A3 sounds', entries: sounds, hide: 'video', audio: true },
  ];
  const tracks = all.filter((one) => one.entries.length);

  const out: string[] = [];
  const line = (depth: number, text: string) => out.push(`${'  '.repeat(depth)}${text}`);
  const prop = (depth: number, name: string, value: string | number) => line(depth, `<property name="${xml(name)}">${xml(String(value))}</property>`);
  const divide = gcd(film.width, film.height);

  line(0, '<?xml version="1.0" encoding="utf-8"?>');
  line(0, `<mlt LC_NUMERIC="C" version="7.0.0" title="${xml(film.title)}" producer="main">`);
  line(1, `<!-- ${remark(film.title)}: made in the video studio. Open it in Shotcut or Kdenlive. -->`);
  line(1, '<!-- V1 is every shot as a plain clip, cut where the film cut it. V2 is the finished film, hidden and muted, to compare. -->');
  line(1, '<!-- V3 is the captions as plain text. A1 is the narration, A2 the music bed with the film\'s own level, A3 the sounds. -->');
  line(1, '<!-- The camera moves and the type the film drew on its pictures are not in this file: they belong to the renderer. -->');
  line(1, `<profile description="${film.width}x${film.height} ${fps}fps" width="${film.width}" height="${film.height}" progressive="1"`
    + ` sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="${film.width / divide}" display_aspect_den="${film.height / divide}"`
    + ` frame_rate_num="${fps}" frame_rate_den="1" colorspace="709"/>`);
  for (const one of producers) {
    if (one.note) line(1, `<!-- ${remark(one.note)} -->`);
    line(1, one.length ? `<producer id="${one.id}" in="0" out="${one.length - 1}">` : `<producer id="${one.id}">`);
    for (const [name, value] of one.props) prop(2, name, value);
    for (const filter of one.filters ?? []) {
      line(2, '<filter>');
      for (const [name, value] of filter) prop(3, name, value);
      line(2, '</filter>');
    }
    line(1, '</producer>');
  }
  for (const track of tracks) {
    line(1, `<playlist id="${track.id}">`);
    prop(2, 'shotcut:name', track.name);
    if (track.audio) prop(2, 'shotcut:audio', 1);
    for (const entry of track.entries) {
      if ('blank' in entry) line(2, `<blank length="${entry.blank}"/>`);
      else line(2, `<entry producer="${entry.producer}" in="${entry.in}" out="${entry.out}"/>`);
    }
    line(1, '</playlist>');
  }
  line(1, `<tractor id="main" title="${xml(film.title)}" in="0" out="${total - 1}">`);
  prop(2, 'shotcut', 1);
  line(2, '<multitrack>');
  for (const track of tracks) line(3, `<track producer="${track.id}"${track.hide ? ` hide="${track.hide}"` : ''}/>`);
  line(2, '</multitrack>');
  // How the tracks become one frame and one sound: the captions laid over the shots, every sound track mixed in.
  const index = (id: string) => tracks.findIndex((one) => one.id === id);
  if (index('captions') > 0) {
    line(2, '<transition>');
    for (const [name, value] of [['mlt_service', 'affine'], ['a_track', 0], ['b_track', index('captions')], ['always_active', 1], ['distort', 0], ['fill', 1]] as const) prop(3, name, value);
    line(2, '</transition>');
  }
  for (const track of tracks.filter((one) => one.audio)) {
    line(2, '<transition>');
    for (const [name, value] of [['mlt_service', 'mix'], ['a_track', 0], ['b_track', index(track.id)], ['always_active', 1], ['sum', 1]] as const) prop(3, name, value);
    line(2, '</transition>');
  }
  line(1, '</tractor>');
  line(0, '</mlt>');
  return `${out.join('\n')}\n`;
}
