import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import type { Brand } from './templates/index.ts';

// What is wired to a Video studio card, or dropped on it, is what the film is made of. Nothing here invents a fact:
// it reads the product's own words, its own colours and its own screens, and hands them to the storyboard as
// material. The caps are tight on purpose — a storyboard prompt is not a place to paste a codebase.
export const CAPS = {
  files: 28, file: 160_000, words: 9000, readme: 4500, copy: 2600, css: 90_000, logo: 600_000, font: 500_000, colours: 8,
  screens: 4, screen: 6_000_000,
};

// A folder is walked only this deep, and never into any of these.
const DEPTH = 3;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'target', 'vendor', '.cache', '.turbo', '.venv', '__pycache__', 'tmp']);
const COPY_FILE = /^(index|page|home|landing|hero|app)\.(html|tsx|jsx|astro|svelte|vue|md|mdx)$/i;
const CSS_FILE = /\.(css|scss)$/i;
const THEME_FILE = /^tailwind\.config\.[cm]?[jt]s$/i;
const LOGO_FILE = /^(logo|logomark|wordmark|icon|favicon|apple-touch-icon)[^/]*\.(svg|png|jpg|jpeg|webp)$/i;
const FONT_FILE = /\.(woff2|woff|ttf|otf)$/i;
const PICTURE_FILE = /\.(png|jpe?g|webp)$/i;
// What a picture has to be named, or live in, to be a picture of the product rather than a wallpaper or a badge.
const SHOT_NAME = /(screenshot|screengrab|preview|demo|og[-_]?image|social[-_]?card|hero|dashboard)/i;
// A folder whose name says what is in it: a picture in one of these is a picture of the product, whatever it is
// called. A picture in `public` or `assets` is as likely to be a wallpaper, so those only break a tie.
const SHOT_DIR = /^\.?(screenshots?|shots|docs?|\.github)$/i;
const PICTURE_DIR = /^(public|static|assets|images?|img|media|marketing|website|www)$/i;

type Found = { path: string; name: string; dir: string };
// Everything worth looking at in a project folder, found once, shallow, and capped before anything is read.
async function walk(dir: string, depth = 0, into: Found[] = []): Promise<Found[]> {
  if (depth > DEPTH || into.length > 900) return into;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    // A folder is skipped for beginning with a dot, except the kind that is there to be read: `.shots` and the
    // like, which is where a project keeps the pictures it has of itself.
    if (entry.name.startsWith('.') && entry.name !== '.env.example' && !SHOT_DIR.test(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP.has(entry.name)) await walk(path, depth + 1, into); continue; }
    into.push({ path, name: entry.name, dir });
  }
  return into;
}

const read = async (path: string, limit = CAPS.file): Promise<string> => {
  const size = await stat(path).then((one) => one.size, () => Infinity);
  if (size > limit) return '';
  return readFile(path, 'utf8').catch(() => '');
};

// The words on a page, out of whatever the page is written in. Tags, braces, imports and class names are not copy;
// what is left between them is.
export function copyOf(text: string, from: string): string {
  const kind = extname(from).toLowerCase();
  let body = text;
  if (kind === '.md' || kind === '.mdx') body = body.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, ' ').replace(/[#*_>`[\]()]/g, ' ');
  else if (kind === '.html' || kind === '.astro') body = body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, '\n');
  else {
    // In a component the copy is what sits between the tags and inside the long quoted strings; everything else is code.
    const between = [...body.matchAll(/>([^<>{}\n][^<>{}]{6,})</g)].map((hit) => hit[1]);
    const quoted = [...body.matchAll(/["'`]([A-Z][^"'`\n]{14,140})["'`]/g)].map((hit) => hit[1]);
    body = [...between, ...quoted].join('\n');
  }
  return body.split('\n').map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 8 && /[a-z]{3}/.test(line) && !/^(import|export|const|function|return|className|https?:)/.test(line))
    .filter((line, at, all) => all.indexOf(line) === at).join('\n').slice(0, CAPS.copy);
}

// The product's palette, out of its CSS variables and its Tailwind theme. Only real hex colours count, the ones it
// names most often come first, and pure black and pure white are left out — everything has those.
export function coloursOf(text: string): string[] {
  const counted = new Map<string, number>();
  for (const hit of text.matchAll(/(?:--[\w-]+\s*:\s*|['"]?(?:primary|accent|brand|background|foreground|surface|ink|secondary)[\w-]*['"]?\s*:\s*['"]?)(#[0-9a-fA-F]{3,8})\b/g)) {
    const hex = hit[1].slice(0, 7).toLowerCase();
    if (hex.length < 4 || /^#(fff|000)$/.test(hex) || /^#(ffffff|000000)$/.test(hex)) continue;
    counted.set(hex, (counted.get(hex) ?? 0) + 3);
  }
  for (const hit of text.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
    const hex = hit[0].toLowerCase();
    if (/^#(ffffff|000000)$/.test(hex)) continue;
    counted.set(hex, (counted.get(hex) ?? 0) + 1);
  }
  return [...counted.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex).slice(0, CAPS.colours);
}

// The typeface the product sets itself in: the first family it names that is not a fallback stack.
export function fontOf(text: string): { name?: string; src?: string } {
  const face = /@font-face\s*{[^}]*?font-family\s*:\s*['"]?([^;'"}]+)['"]?[^}]*?src\s*:[^;}]*?url\(\s*['"]?([^'")]+)/is.exec(text);
  if (face) return { name: face[1].trim(), src: face[2].trim() };
  const named = /font-family\s*:\s*([^;}\n]+)/i.exec(text) ?? /fontFamily\s*:\s*\[?\s*['"]([^'"]+)/i.exec(text);
  const first = named?.[1]?.split(',')[0]?.replace(/^var\(.*$/, '').replace(/['"]/g, '').trim();
  if (!first || /^(sans-serif|serif|monospace|system-ui|inherit|ui-sans-serif)$/i.test(first)) return {};
  return { name: first };
}

// How big a picture is, read out of its own first bytes. A project is full of pictures and only some of them are
// pictures of the product: a 48-pixel icon, a badge, a sponsor's logo. Nothing here decodes anything — it reads the
// header the format is obliged to put at the front — because the only question is whether this is the size of a
// screen.
export function sizeOf(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length > 24 && bytes.toString('ascii', 1, 4) === 'PNG') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: (bytes.readUIntLE(24, 3) & 0xffffff) + 1, height: (bytes.readUIntLE(27, 3) & 0xffffff) + 1 };
    if (kind === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // The size lives in whichever start-of-frame marker this file happens to use, so the markers are walked until one
    // of them turns up. Anything that is not a marker means the file is not what it says it is.
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1];
      const size = bytes.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
      }
      at += 2 + size;
    }
  }
  return null;
}

// Whether a picture in a project folder is a picture of the product. A screen is wide enough to be one and shaped
// like one: a badge is 88 pixels across, a banner is six times wider than it is tall, and neither is a film.
export const looksLikeScreen = (size: { width: number; height: number } | null): boolean => {
  if (!size || !size.width || !size.height) return false;
  const ratio = size.width / size.height;
  return size.width >= 640 && size.height >= 360 && ratio >= 0.35 && ratio <= 3.2;
};

// The product's own screens, when nobody wired a browser or an address to the card: a repository with a README that
// shows the thing off has the pictures in it already, and a film about a product that never shows the product is a
// film about an idea. Named first, because a file called `screenshot.png` is somebody saying what it is; then the
// ones the README itself puts on the page; then whatever else is the size of a screen.
export async function screensOf(found: Found[], readme: string, skip: Set<string>): Promise<Screens> {
  const shown = new Set([...readme.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g)].map((hit) => basename(hit[1].split(/[?#]/)[0]).toLowerCase()));
  const score = (one: Found) => (shown.has(one.name.toLowerCase()) ? 6 : 0) + (SHOT_NAME.test(one.name) ? 4 : 0)
    + (SHOT_DIR.test(basename(one.dir)) ? 3 : 0) + (PICTURE_DIR.test(basename(one.dir)) ? 1 : 0);
  const maybe = found.filter((one) => PICTURE_FILE.test(one.name) && !LOGO_FILE.test(one.name) && !skip.has(one.name) && score(one) >= 3);
  // The newest first among equals: a project keeps the screenshots of the design before last as well, and a film
  // that shows those is telling the truth about a product that no longer exists.
  const dated = await Promise.all(maybe.map(async (one) => ({ one, when: await stat(one.path).then((file) => file.mtimeMs, () => 0) })));
  const order = dated.sort((a, b) => score(b.one) - score(a.one) || b.when - a.when).map((entry) => entry.one).slice(0, CAPS.screens * 4);
  const screens: Screens = [];
  for (const one of order) {
    if (screens.length >= CAPS.screens) break;
    const size = await stat(one.path).then((file) => file.size, () => Infinity);
    if (size > CAPS.screen) continue;
    const bytes = await readFile(one.path).catch(() => null);
    if (!bytes || !looksLikeScreen(sizeOf(bytes))) continue;
    screens.push({ name: one.name, bytes, what: `a screenshot of the product, out of the project itself (${basename(one.dir)}/${one.name})` });
  }
  return screens;
}

// What one wired project card is worth to a film: the product's real words, its palette, its typeface and its mark.
export type Product = { name?: string; about?: string; pitch: string; words: string; brand: Brand; logo?: { name: string; bytes: Buffer }; font?: { name: string; bytes: Buffer }; screens: Screens };

// What the product says it is, before it says how it is built: the line in its package and the first sentences a
// README opens with, which is where anybody writing about it would look first. A film argues this; the rest of the
// material is only there to check the film against. Without it a launch film reads down a feature list, which is
// how one came to open on "Read-only project card".
export function pitchOf(about: string | undefined, readme: string): string {
  const said = readme.split(/\n+/).map((one) => one.replace(/\s+/g, ' ').trim())
    .filter((one) => countWordsIn(one) >= 6 && /[a-z]{3}/.test(one) && !/^[-*+>|#]/.test(one))
    .flatMap((one) => one.split(/(?<=[.!?])\s+/))
    .filter((one) => countWordsIn(one) >= 6)
    .slice(0, 3);
  return [about, ...said].filter(Boolean).join(' ').slice(0, 480);
}
const countWordsIn = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

export async function readProject(dir: string): Promise<Product> {
  const found = await walk(resolve(dir));
  const pick = (test: (one: Found) => boolean, limit = CAPS.files) => found.filter(test).slice(0, limit);
  let name: string | undefined;
  let about: string | undefined;

  const pkg = found.find((one) => one.name === 'package.json' && one.dir === resolve(dir));
  if (pkg) {
    try {
      const read = JSON.parse(await readFile(pkg.path, 'utf8')) as { name?: string; description?: string };
      name = read.name?.replace(/^@[^/]+\//, '');
      about = read.description;
    } catch { /* a package.json that will not parse says nothing */ }
  }

  const words: string[] = [];
  const readme = found.find((one) => /^readme\.mdx?$/i.test(one.name));
  let readmeBody = '';
  if (readme) {
    readmeBody = await read(readme.path);
    words.push(`README of ${name ?? basename(dir)}:\n${copyOf(readmeBody, readme.path).slice(0, CAPS.readme)}`);
    // A README's own title is the product's name when package.json did not give one.
    name ??= /^#\s+(.{2,60})$/m.exec(readmeBody)?.[1]?.trim();
  }
  if (about) words.unshift(`What it says it is: ${about}`);

  for (const one of pick((entry) => COPY_FILE.test(entry.name), 6)) {
    const copy = copyOf(await read(one.path), one.path);
    if (copy.length > 60) words.push(`Copy from ${basename(one.dir)}/${one.name}:\n${copy}`);
  }

  const styles = pick((one) => CSS_FILE.test(one.name) || THEME_FILE.test(one.name), 8);
  let css = '';
  for (const one of styles) { if (css.length < CAPS.css) css += `\n${await read(one.path)}`; }
  const colours = coloursOf(css);
  const face = fontOf(css);

  // The typeface itself travels with the film when the product keeps its own copy of the file; otherwise only its name
  // does, and the film's own face stands behind it.
  let font: Product['font'];
  if (face.name) {
    const wanted = face.src ? basename(face.src.split(/[?#]/)[0]) : '';
    const file = found.find((one) => FONT_FILE.test(one.name) && (wanted ? one.name === wanted : one.name.toLowerCase().startsWith(face.name!.toLowerCase().replace(/\s+/g, ''))));
    if (file) {
      const bytes = await readFile(file.path).catch(() => null);
      if (bytes && bytes.length <= CAPS.font) font = { name: file.name, bytes };
    }
  }

  let logo: Product['logo'];
  const mark = found.find((one) => LOGO_FILE.test(one.name) && !/favicon\.ico$/i.test(one.name));
  if (mark) {
    const bytes = await readFile(mark.path).catch(() => null);
    if (bytes && bytes.length <= CAPS.logo) logo = { name: mark.name, bytes };
  }

  // The product's own screens, out of the project itself. The mark is not one of them: a logo on a slide is a title
  // card, and a film that cuts to one thinking it is showing the product is showing nothing.
  const screens = await screensOf(found, readmeBody, new Set([logo?.name ?? ''].filter(Boolean)));
  const pitch = pitchOf(about, readme ? copyOf(readmeBody, readme.path) : '');

  return {
    name, about, pitch, logo, font, screens,
    words: words.join('\n\n').slice(0, CAPS.words),
    brand: { colours, name, font: face.name, fontFile: font?.name },
  };
}

// The screens a product actually has, as pictures. `scrolls` is how far down the page each shot is taken from, so a
// film shows the top of the page and then what is under it rather than the same hero three times.
export type Screens = { name: string; bytes: Buffer; what: string }[];
// Bigger than the frame will ever show them, because a device scene pushes into the screenshot: `agent-browser` has
// no device-scale-factor of its own, so the only way to keep a 1.35x push sharp is to photograph more pixels than
// the film needs. A desktop page is still laid out as a desktop page at this width, and 560 is still a phone.
export const VIEWPORTS = { desktop: { width: 1920, height: 1200 }, mobile: { width: 560, height: 1240 } };
