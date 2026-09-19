import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { projectDir } from '../coder.ts';
import { CAPS, coloursOf, copyOf, fontOf, looksLikeScreen, pitchOf, readProject, sizeOf } from './sources.ts';
import { lightOf, paintOf } from './templates/looks.ts';

const dir = await mkdtemp(join(tmpdir(), 'product-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

// A small product, written the way a real one is: a README, a package, a landing page, a stylesheet, a mark.
await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@acme/relay', description: 'Handover, without the handover.' }));
await writeFile(join(dir, 'README.md'), '# Relay\n\nRelay keeps the context with the work, so nothing is explained twice.\n\n```bash\nnpm i relay\n```\n\n- Rooms that remember what was said\n- Documents that stay wired to the people who read them\n');
await mkdir(join(dir, 'src'), { recursive: true });
await writeFile(join(dir, 'src/page.tsx'), 'import { Hero } from "./hero";\nexport default function Page() {\n  return (<main><h1>Stop explaining the same thing twice</h1><p>Relay carries the context from the brief to the build.</p></main>);\n}\n');
await writeFile(join(dir, 'src/index.css'), ':root { --brand-primary: #4E8CFF; --brand-ink: #0E1117; --brand-accent: #E8B04B; }\n@font-face { font-family: Satoshi; src: url("/fonts/Satoshi.woff2") format("woff2"); }\nbody { font-family: Satoshi, sans-serif; }\n');
await mkdir(join(dir, 'public/fonts'), { recursive: true });
await writeFile(join(dir, 'public/fonts/Satoshi.woff2'), Buffer.alloc(2048, 7));
await writeFile(join(dir, 'public/logo.png'), Buffer.alloc(512, 3));
// A PNG says how big it is in the twenty-four bytes it opens with, which is all anybody here needs to read.
const png = (width: number, height: number): Buffer => {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};
// The product's own screens: one the README shows off, one in a folder that says what is in it, and two that are
// neither — a wallpaper the size of a screen, and an icon that is not the size of anything.
await mkdir(join(dir, '.shots'), { recursive: true });
await writeFile(join(dir, '.shots/02-board.png'), png(1920, 1200));
await writeFile(join(dir, 'public/screenshot-home.png'), png(1600, 900));
await writeFile(join(dir, 'public/wallpaper.png'), png(2400, 1400));
await writeFile(join(dir, 'public/badge.png'), png(88, 20));

// The things that must never be read: somebody else's dependencies, and a file far too big to be copy.
await mkdir(join(dir, 'node_modules/left-pad'), { recursive: true });
await writeFile(join(dir, 'node_modules/left-pad/README.md'), '# left-pad\n\nThis is not the product.\n');
await writeFile(join(dir, 'src/data.css'), `/* ${'x'.repeat(CAPS.file + 100)} */`);

describe('reading a product', () => {
  it('takes its real words: what it calls itself, what it says it is, and what its landing page says', async () => {
    const product = await readProject(dir);
    expect(product.name).toBe('relay');
    expect(product.about).toBe('Handover, without the handover.');
    expect(product.words).toContain('Relay keeps the context with the work');
    expect(product.words).toContain('Stop explaining the same thing twice');
    // Code is not copy, and a fenced block is not a claim.
    expect(product.words).not.toContain('npm i relay');
    expect(product.words).not.toContain('import { Hero }');
    // Nothing from anybody else's folder, ever.
    expect(product.words).not.toContain('This is not the product');
    expect(product.words.length).toBeLessThanOrEqual(CAPS.words);
  });

  it('takes its palette, its typeface and its mark, and leaves a file too big to be copy alone', async () => {
    const product = await readProject(dir);
    expect(product.brand.colours).toContain('#4e8cff');
    expect(product.brand.colours).toContain('#0e1117');
    expect(product.brand.font).toBe('Satoshi');
    expect(product.brand.fontFile).toBe('Satoshi.woff2');
    expect(product.font?.bytes.length).toBe(2048);
    expect(product.logo?.name).toBe('logo.png');
    expect(product.words).not.toContain('xxxxxxxxxx');
  });

  it('refuses a folder too broad to read at all, the same way the coding agent does', () => {
    // The app's own workspace and the app itself are never material.
    expect(() => projectDir(dir, [join(dir, 'src')])).toThrow(/too broad/);
    expect(() => projectDir('/', [])).toThrow(/too broad/);
    expect(() => projectDir('relative/path', [])).toThrow(/full folder path/);
    expect(() => projectDir(join(dir, 'nowhere'), [])).toThrow(/there is no folder at/);
  });
});

describe('what the copy reader keeps', () => {
  it('keeps sentences and drops markup, imports and class names', () => {
    expect(copyOf('<h1>A real headline</h1><script>alert(1)</script>', 'index.html')).toBe('A real headline');
    expect(copyOf('import x from "y";\nexport const A = 1;\n', 'page.tsx')).toBe('');
    expect(copyOf('<p>One two three four</p><p>One two three four</p>', 'page.html')).toBe('One two three four');
  });

  it('cuts a page of copy down to what a prompt can carry', () => {
    expect(copyOf('A sentence worth keeping. '.repeat(500), 'a.md').length).toBeLessThanOrEqual(CAPS.copy);
  });
});

describe('what the palette reader keeps', () => {
  it('counts a named colour for more than a stray one, and never black or white', () => {
    const found = coloursOf(':root { --primary: #123456; }\n.a { color: #abcdef; }\n.b { color: #ffffff; }\n.c { color: #000000; }');
    expect(found[0]).toBe('#123456');
    expect(found).toContain('#abcdef');
    expect(found).not.toContain('#ffffff');
    expect(found).not.toContain('#000000');
    expect(coloursOf('nothing here')).toEqual([]);
  });

  it('takes a typeface by name, and its file when the product keeps one', () => {
    expect(fontOf('@font-face { font-family: Satoshi; src: url("/f/Satoshi.woff2"); }')).toEqual({ name: 'Satoshi', src: '/f/Satoshi.woff2' });
    expect(fontOf('body { font-family: "Space Grotesk", sans-serif; }')).toEqual({ name: 'Space Grotesk' });
    // A fallback stack names no typeface at all.
    expect(fontOf('body { font-family: system-ui, sans-serif; }')).toEqual({});
  });
});

describe('the brand look', () => {
  it('makes a film palette out of a product one: the dark colour is the ground, the bright one the signal', () => {
    const paint = paintOf('brand', { colours: ['#4e8cff', '#0e1117', '#e8b04b'] });
    expect(paint.ground).toBe('#0e1117');
    expect(lightOf(paint.signal)).toBeGreaterThan(0.42);
    // A dark ground takes light ink, and the scrim over a picture is the ground itself.
    expect(lightOf(paint.ink)).toBeGreaterThan(0.8);
    expect(paint.scrim).toBe('14, 17, 23');
  });

  it('darkens a product with no dark colour rather than shining a lamp at the viewer', () => {
    const paint = paintOf('brand', { colours: ['#dfe6ef', '#8fb4ff'] });
    expect(lightOf(paint.ground)).toBeLessThan(0.35);
  });

  it('takes the most coloured colour as the accent, never the brightest grey', () => {
    // A real palette is mostly greys: the page, the panel, the rule, the muted label, and one colour that means
    // something. The brightest of those is near white, which is no accent at all.
    const paint = paintOf('brand', { colours: ['#16181d', '#0a0a0a', '#e8eaf0', '#f0b35a', '#8fb5ff'] });
    expect(paint.signal).toBe('#f0b35a');
    // And the ground is the product's own page, not the pure black it also happens to define.
    expect(paint.ground).toBe('#16181d');
  });

  it('falls back to the clean look when the product said nothing about colour', () => {
    expect(paintOf('brand', { colours: [] }).ground).toBe(paintOf('clean').ground);
    expect(paintOf('brand', { colours: ['not a colour'] }).ground).toBe(paintOf('clean').ground);
  });
});

describe('the pictures a project has of itself', () => {
  it('reads how big a picture is out of its own first bytes', () => {
    expect(sizeOf(png(1600, 900))).toEqual({ width: 1600, height: 900 });
    expect(sizeOf(Buffer.alloc(40, 9))).toBe(null);
    expect(looksLikeScreen({ width: 1600, height: 900 })).toBe(true);
    // A badge, and a banner six times wider than it is tall. Neither is a picture of a product.
    expect(looksLikeScreen({ width: 88, height: 20 })).toBe(false);
    expect(looksLikeScreen({ width: 1280, height: 200 })).toBe(false);
    expect(looksLikeScreen(null)).toBe(false);
  });

  it('takes the screenshots and leaves the wallpaper, the badge and the mark', async () => {
    const product = await readProject(dir);
    const names = product.screens.map((one) => one.name);
    expect(names).toContain('02-board.png');
    expect(names).toContain('screenshot-home.png');
    expect(names).not.toContain('wallpaper.png');
    expect(names).not.toContain('badge.png');
    expect(names).not.toContain('logo.png');
    expect(product.screens.every((one) => one.what.includes('out of the project itself'))).toBe(true);
  });
});

describe('what a product says it is', () => {
  it('takes the line in its package and the sentences its README opens on', () => {
    const said = pitchOf('Handover, without the handover.', 'Relay keeps the context with the work, so nothing is explained twice.\nIt is built for teams who brief each other all day long.\n- A bullet, which is a list and not a pitch');
    expect(said).toContain('Handover, without the handover.');
    expect(said).toContain('Relay keeps the context with the work');
    // A bullet is a feature list; a pitch is prose.
    expect(said).not.toContain('A bullet');
  });

  it('is what the film argues, so it comes off a real project', async () => {
    const product = await readProject(dir);
    expect(product.pitch).toContain('Handover, without the handover.');
    expect(product.pitch.length).toBeLessThanOrEqual(480);
  });
});
