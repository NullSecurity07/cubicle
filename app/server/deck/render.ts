import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SHAPE_NAMES, type DeckLook, type Slide } from '../../shared/deck.ts';
import { CHROMES } from '../browser.ts';
import { paintOf, type Brand, type Paint } from '../media/templates/packs.ts';

// A deck is one HTML page with every slide a 16:9 section, in the film looks' own palettes and typefaces, and the PDF
// is that page printed by the same headless Chrome the video studio renders with. Nothing here reaches the network:
// the fonts and the logo are written into the page itself, so the file opens anywhere and prints the same.
export const WIDTH = 1280;
export const HEIGHT = 720;
const VENDOR = resolve(import.meta.dirname, '../media/templates/vendor');
export const chromePath = (): string | null => CHROMES.find((path) => existsSync(path)) ?? null;
export const NO_CHROME = 'No PDF printer is set up. The founder installs Chrome (free) and restarts the app.';

// What a deck wears, beyond its slides: the look, the product's own colours and typeface when a project is wired,
// its logo, and a line at the foot of every slide.
export type Dress = { look: DeckLook; brand?: Brand; logo?: { name: string; bytes: Buffer }; font?: { name: string; bytes: Buffer }; footer?: string };

const FACES: Record<DeckLook, { display: string; body: string; files: [family: string, file: string][] }> = {
  clean: { display: "'Deck Sans'", body: "'Deck Sans'", files: [['Deck Sans', 'inter.woff2']] },
  editorial: { display: "'Deck Serif'", body: "'Deck Sans'", files: [['Deck Sans', 'inter.woff2'], ['Deck Serif', 'instrument-serif.woff2']] },
  brand: { display: "'Deck Sans'", body: "'Deck Sans'", files: [['Deck Sans', 'inter.woff2']] },
};

const fontCache = new Map<string, string>();
async function fontData(file: string): Promise<string> {
  const known = fontCache.get(file);
  if (known) return known;
  const data = (await readFile(join(VENDOR, file))).toString('base64');
  fontCache.set(file, data);
  return data;
}
const MIME: Record<string, string> = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

export const escape = (text: string) => text.replace(/[&<>"']/g, (letter) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[letter]!);

// "Label: 40%" read as a bar, for a chart slide. A line that is not one is just a line.
export function barOf(line: string): { label: string; value: number; shown: string } | null {
  const found = /^(.{1,60}?)\s*[:–-]\s*([$€£]?\s?\d[\d,.]*\s?(?:%|k|m|bn|x)?)\s*$/i.exec(line.trim());
  if (!found) return null;
  const value = Number(found[2].replace(/[^\d.]/g, ''));
  return Number.isFinite(value) ? { label: found[1], value, shown: found[2] } : null;
}

async function styleOf(dress: Dress, paint: Paint): Promise<string> {
  const faces = FACES[dress.look];
  const own = dress.look === 'brand' && dress.font ? [`@font-face{font-family:'Deck Brand';src:url(data:${mimeOf(dress.font.name)};base64,${dress.font.bytes.toString('base64')});font-display:block}`] : [];
  const loaded = await Promise.all(faces.files.map(async ([family, file]) => `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${await fontData(file)}) format('woff2');font-weight:100 900;font-display:block}`));
  const display = own.length ? `'Deck Brand', ${faces.display}` : faces.display;
  const serif = dress.look === 'editorial';
  return `${[...own, ...loaded].join('\n')}
:root{--ground:${paint.ground};--ink:${paint.ink};--quiet:${paint.quiet};--signal:${paint.signal};--mark:${paint.mark};--display:${display}, Georgia, sans-serif;--body:${faces.body}, system-ui, sans-serif}
@page{size:${WIDTH}px ${HEIGHT}px;margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--ground)}
body{font-family:var(--body);color:var(--ink);-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact;font-synthesis:none}
.slide{position:relative;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;padding:84px 96px 96px;display:flex;flex-direction:column;background:var(--ground);break-after:page;page-break-after:always}
.slide:last-child{break-after:auto;page-break-after:auto}
.slide::before{content:'';position:absolute;inset:0;background:radial-gradient(120% 90% at 100% 0%, color-mix(in srgb, var(--signal) 9%, transparent), transparent 60%);pointer-events:none}
.eyebrow{position:relative;margin:0 0 22px;font-size:17px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--signal)}
h1,h2{position:relative;margin:0;font-family:var(--display);font-weight:${serif ? 400 : 650};letter-spacing:${serif ? '-.01em' : '-.025em'};line-height:1.06;text-wrap:balance}
h2{font-size:${serif ? 66 : 58}px;max-width:1000px}
.body{position:relative;flex:1;display:flex;gap:64px;align-items:center;margin-top:40px;min-height:0}
.lines{flex:1;margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:22px}
.lines li{position:relative;padding-left:30px;font-size:29px;line-height:1.35;color:var(--quiet);text-wrap:pretty}
.lines li::before{content:'';position:absolute;left:0;top:.62em;width:12px;height:3px;border-radius:2px;background:var(--signal)}
.figure{flex:none;display:flex;flex-direction:column;gap:10px;max-width:460px}
.figure b{font-family:var(--display);font-size:150px;font-weight:${serif ? 400 : 700};line-height:.95;letter-spacing:-.04em;color:var(--signal);font-variant-numeric:tabular-nums}
.figure span{font-size:24px;line-height:1.35;color:var(--quiet)}
.foot{position:absolute;left:96px;right:96px;bottom:40px;display:flex;align-items:center;gap:24px;font-size:15px;color:var(--quiet);opacity:.78}
.foot .source{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.foot .page{margin-left:auto;font-variant-numeric:tabular-nums}
.foot img{height:22px;width:auto;opacity:.9}
.slide--title{justify-content:center;padding-top:96px}
.slide--title h1{font-size:${serif ? 104 : 92}px;max-width:1040px}
.slide--title .sub{position:relative;margin:34px 0 0;max-width:880px;font-size:32px;line-height:1.4;color:var(--quiet)}
.slide--title .rule{position:relative;width:72px;height:5px;margin:0 0 40px;border-radius:3px;background:var(--signal)}
.slide--title .logo{position:absolute;top:80px;left:96px;height:44px;width:auto}
.slide--quote{justify-content:center}
.slide--quote blockquote{position:relative;margin:0;font-family:var(--display);font-size:${serif ? 64 : 54}px;font-weight:${serif ? 400 : 550};line-height:1.18;letter-spacing:-.015em;max-width:1030px;text-wrap:balance}
.slide--quote blockquote::before{content:'\\201C';position:absolute;left:-.55em;top:-.12em;color:var(--signal)}
.slide--quote cite{position:relative;display:block;margin-top:36px;font-style:normal;font-size:24px;color:var(--quiet)}
.slide--ask .figure b{font-size:170px}
.bars{flex:1;display:flex;flex-direction:column;gap:20px}
.bar{display:grid;grid-template-columns:260px 1fr 110px;align-items:center;gap:20px;font-size:24px;color:var(--quiet)}
.bar i{display:block;height:26px;border-radius:6px;background:var(--signal)}
.bar em{font-style:normal;color:var(--ink);font-variant-numeric:tabular-nums;text-align:right}
.empty{color:var(--quiet);opacity:.7}`;
}

function slideHtml(slide: Slide, index: number, count: number, dress: Dress, logo: string | null): string {
  const eyebrow = `<p class="eyebrow">${escape(SHAPE_NAMES[slide.shape])}</p>`;
  const foot = `<footer class="foot">${logo && slide.shape !== 'title' ? `<img src="${logo}" alt="">` : ''}<span class="source">${slide.source ? `Source: ${escape(slide.source)}` : escape(dress.footer ?? '')}</span><span class="page">${index + 1} / ${count}</span></footer>`;
  const figure = slide.figure ? `<div class="figure"><b>${escape(slide.figure.value)}</b>${slide.figure.label ? `<span>${escape(slide.figure.label)}</span>` : ''}</div>` : '';
  const list = slide.lines.length ? `<ul class="lines">${slide.lines.map((line) => `<li>${escape(line)}</li>`).join('')}</ul>` : '';
  const section = (body: string) => `<section class="slide slide--${slide.shape}" id="s${index + 1}" data-shape="${slide.shape}">${body}${foot}</section>`;
  if (slide.shape === 'title') {
    return section(`${logo ? `<img class="logo" src="${logo}" alt="">` : ''}<div class="rule"></div><h1>${escape(slide.headline)}</h1>${slide.lines[0] ? `<p class="sub">${escape(slide.lines.slice(0, 2).join(' '))}</p>` : ''}`);
  }
  if (slide.shape === 'quote') {
    return section(`${eyebrow}<blockquote>${escape(slide.headline)}</blockquote>${slide.lines[0] ? `<cite>${escape(slide.lines.join(' · '))}</cite>` : ''}`);
  }
  if (slide.shape === 'chart') {
    const bars = slide.lines.map(barOf);
    if (bars.length && bars.every(Boolean)) {
      const most = Math.max(...bars.map((bar) => bar!.value), 1);
      const drawn = bars.map((bar) => `<div class="bar"><span>${escape(bar!.label)}</span><i style="width:${Math.max(2, Math.round((bar!.value / most) * 100))}%"></i><em>${escape(bar!.shown)}</em></div>`).join('');
      return section(`${eyebrow}<h2>${escape(slide.headline)}</h2><div class="body"><div class="bars">${drawn}</div>${figure}</div>`);
    }
  }
  const body = list || figure ? `<div class="body">${list}${figure}</div>` : '';
  return section(`${eyebrow}<h2>${escape(slide.headline)}</h2>${body}`);
}

// The whole deck as one page, or one slide of it on its own (for a thumbnail). Pure but for reading the font files.
export async function deckHtml(slides: Slide[], dress: Dress, title: string, only?: number): Promise<string> {
  const paint = paintOf(dress.look === 'brand' ? 'brand' : dress.look === 'editorial' ? 'editorial' : 'clean', dress.brand);
  const logo = dress.logo ? `data:${mimeOf(dress.logo.name)};base64,${dress.logo.bytes.toString('base64')}` : null;
  const shown = only === undefined ? slides.map((slide, index) => [slide, index] as const) : slides[only] ? [[slides[only], only] as const] : [];
  const style = await styleOf(dress, paint);
  const thumb = only === undefined ? '' : `html,body{width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title><style>${style}${thumb}</style></head><body>${shown.map(([slide, index]) => slideHtml(slide, index, slides.length, dress, logo)).join('\n')}</body></html>`;
}

// The page printed to PDF by headless Chrome, one slide a page, in a profile of its own that is thrown away after, so
// it never touches the founder's own browser. A minute is far more than it needs; a hung Chrome is stopped.
export async function printPdf(html: string, signal?: AbortSignal): Promise<Buffer> {
  const chrome = chromePath();
  if (!chrome) throw new Error(NO_CHROME);
  const at = await mkdtemp(join(tmpdir(), 'deck-print-'));
  try {
    await writeFile(join(at, 'deck.html'), html);
    const out = join(at, 'deck.pdf');
    await new Promise<void>((done, fail) => {
      const child = execFile(chrome, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
        `--user-data-dir=${join(at, 'profile')}`, '--no-pdf-header-footer', '--run-all-compositor-stages-before-draw', '--virtual-time-budget=4000',
        `--print-to-pdf=${out}`, `file://${join(at, 'deck.html')}`,
      ], { timeout: 60_000 }, (error) => (error && !existsSync(out) ? fail(new Error(`Chrome could not print the deck: ${error.message.split('\n')[0]}`)) : done()));
      signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    });
    if (signal?.aborted) throw new Error('stopped');
    return await readFile(out);
  } finally {
    await rm(at, { recursive: true, force: true }).catch(() => {});
  }
}

// A small PDF written by hand, one blank page a slide, for fake mode on a machine with no Chrome: the journey still
// gets a real file to link to, and nothing pretends it is the deck.
export function stubPdf(pages: number): Buffer {
  const count = Math.max(1, pages);
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, index) => `${index + 3} 0 R`).join(' ')}] /Count ${count} >>`];
  for (let index = 0; index < count; index += 1) objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] >>`);
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
