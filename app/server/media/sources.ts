import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import type { Brand } from './templates/index.ts';

// What is wired to a Video studio card, or dropped on it, is what the film is made of. Nothing here invents a fact:
// it reads the product's own words, its own colours and its own screens, and hands them to the storyboard as
// material. The caps are tight on purpose — a storyboard prompt is not a place to paste a codebase.
export const CAPS = {
  files: 28, file: 160_000, words: 9000, readme: 4500, copy: 2600, css: 90_000, logo: 600_000, font: 500_000, colours: 8,
};

// A folder is walked only this deep, and never into any of these.
const DEPTH = 3;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'target', 'vendor', '.cache', '.turbo', '.venv', '__pycache__', 'tmp']);
const COPY_FILE = /^(index|page|home|landing|hero|app)\.(html|tsx|jsx|astro|svelte|vue|md|mdx)$/i;
const CSS_FILE = /\.(css|scss)$/i;
const THEME_FILE = /^tailwind\.config\.[cm]?[jt]s$/i;
const LOGO_FILE = /^(logo|logomark|wordmark|icon|favicon|apple-touch-icon)[^/]*\.(svg|png|jpg|jpeg|webp)$/i;
const FONT_FILE = /\.(woff2|woff|ttf|otf)$/i;

type Found = { path: string; name: string; dir: string };
// Everything worth looking at in a project folder, found once, shallow, and capped before anything is read.
async function walk(dir: string, depth = 0, into: Found[] = []): Promise<Found[]> {
  if (depth > DEPTH || into.length > 900) return into;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
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

// What one wired project card is worth to a film: the product's real words, its palette, its typeface and its mark.
export type Product = { name?: string; about?: string; words: string; brand: Brand; logo?: { name: string; bytes: Buffer }; font?: { name: string; bytes: Buffer } };

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
  if (readme) {
    const body = await read(readme.path);
    words.push(`README of ${name ?? basename(dir)}:\n${copyOf(body, readme.path).slice(0, CAPS.readme)}`);
    // A README's own title is the product's name when package.json did not give one.
    name ??= /^#\s+(.{2,60})$/m.exec(body)?.[1]?.trim();
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

  return {
    name, about, logo, font,
    words: words.join('\n\n').slice(0, CAPS.words),
    brand: { colours, name, font: face.name, fontFile: font?.name },
  };
}

// The screens a product actually has, as pictures. `scrolls` is how far down the page each shot is taken from, so a
// film shows the top of the page and then what is under it rather than the same hero three times.
export type Screens = { name: string; bytes: Buffer; what: string }[];
export const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 420, height: 900 } };
