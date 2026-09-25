import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PHONE, SECTION_NAMES, type Section, type SiteLook } from '../../shared/site.ts';
import { ratio, WANTS } from '../media/contrast.ts';
import { paintOf, rgbOf, type Brand } from '../media/templates/packs.ts';
import { clip } from './plan.ts';

// A site is one page of our own HTML and one stylesheet, in three looks. Nothing on it reaches the network: the
// typefaces and pictures sit in `media/` beside it, so the folder opens anywhere, from a USB stick or any static host,
// and looks the same. There is no script on the page at all; the questions open with <details>.
const VENDOR = resolve(import.meta.dirname, '../media/templates/vendor');

// The colours a page is painted in. `on` is the words on a button; `accent` is the signal colour when it is used as
// words (a step number, a price), which may have to be a shade darker than the button to be read.
export type Palette = { ground: string; surface: string; line: string; ink: string; quiet: string; signal: string; on: string; accent: string };
const LOOKS: Record<Exclude<SiteLook, 'brand'>, Palette> = {
  clean: { ground: '#FFFFFF', surface: '#F5F6F8', line: '#E3E6EB', ink: '#0E1116', quiet: '#4A5261', signal: '#2552E8', on: '#FFFFFF', accent: '#2552E8' },
  editorial: { ground: '#F7F3EC', surface: '#EFE8DC', line: '#E0D6C6', ink: '#1B1916', quiet: '#595147', signal: '#A63D26', on: '#FFFFFF', accent: '#A63D26' },
};

// What a page wears beyond its words: the look, a wired product's colours, typeface and logo, its name for the top
// bar, where its buttons go, and the pictures already made for its sections (file names under `media/`).
export type Dress = {
  look: SiteLook; brand?: Brand; logo?: { name: string; bytes: Buffer }; font?: { name: string; bytes: Buffer };
  name?: string; link?: string; year?: number;
  pictures?: Record<string, { file: string; width: number; height: number; hold?: number }>;
};

export const escape = (text: string) => text.replace(/[&<>"']/g, (letter) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[letter]!);
const rgb = (hex: string): [number, number, number] => rgbOf(hex) ?? [128, 128, 128];
export const blend = (hex: string, toward: string, amount: number): string => {
  const [from, to] = [rgb(hex), rgb(toward)];
  return `#${from.map((one, at) => Math.round(one + (to[at] - one) * amount).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
};
export const contrastOf = (one: string, other: string) => Math.round(ratio(rgb(one), rgb(other)) * 100) / 100;

// Moves `colour` toward `toward` in small steps until it reads at 4.5:1 on every ground given. The least change that
// works, so a brand's own colour is kept as near to itself as the rule allows.
export function readable(colour: string, grounds: string[], toward: string, wants = WANTS): string {
  for (let amount = 0; amount <= 1.0001; amount += 0.04) {
    const tried = blend(colour, toward, Math.min(1, amount));
    if (grounds.every((ground) => contrastOf(tried, ground) >= wants)) return tried;
  }
  return toward;
}

// The page's palette with every pair of words and ground at 4.5:1 or better. What had to move is said, and the
// lowest ratio left on the page is measured, not assumed.
export function paletteOf(look: SiteLook, brand?: Brand): { palette: Palette; said: string[]; lowest: number } {
  let palette: Palette;
  if (look === 'brand') {
    const paint = paintOf('brand', brand);
    const dark = contrastOf(paint.ground, '#000000') < contrastOf(paint.ground, '#FFFFFF');
    palette = {
      ground: paint.ground, surface: blend(paint.ground, paint.ink, 0.05), line: blend(paint.ground, paint.ink, 0.14),
      ink: paint.ink, quiet: paint.quiet, signal: paint.signal, on: dark ? '#FFFFFF' : '#111111', accent: paint.signal,
    };
  } else palette = { ...LOOKS[look] };
  const said: string[] = [];
  const grounds = [palette.ground, palette.surface];
  const away = contrastOf(palette.ground, '#000000') > contrastOf(palette.ground, '#FFFFFF') ? '#000000' : '#FFFFFF';
  const fix = (key: 'ink' | 'quiet' | 'accent', what: string) => {
    if (grounds.every((ground) => contrastOf(palette[key], ground) >= WANTS)) return;
    palette[key] = readable(palette[key], grounds, key === 'ink' ? away : palette.ink);
    said.push(`${what} darkened to ${palette[key]} to read at 4.5:1`);
  };
  fix('ink', 'the text');
  fix('quiet', 'the quieter text');
  fix('accent', 'the accent, where it is words,');
  // The button: whichever of white and near-black reads better on it, and the button itself moved if neither does.
  const best = (fill: string) => (contrastOf('#FFFFFF', fill) >= contrastOf('#111111', fill) ? '#FFFFFF' : '#111111');
  palette.on = best(palette.signal);
  if (contrastOf(palette.on, palette.signal) < WANTS) {
    const toward = palette.on === '#FFFFFF' ? '#000000' : '#FFFFFF';
    palette.signal = readable(palette.signal, [palette.on], toward);
    said.push(`the button colour moved to ${palette.signal} so its words read at 4.5:1`);
  }
  const lowest = Math.min(
    ...grounds.flatMap((ground) => [contrastOf(palette.ink, ground), contrastOf(palette.quiet, ground), contrastOf(palette.accent, ground)]),
    contrastOf(palette.on, palette.signal),
  );
  return { palette, said, lowest };
}

// ---------------------------------------------------------------- the fold

// Where the hero's button lands on a phone, worked out from the stylesheet's own numbers rather than a browser:
// the top bar, the hero's padding, the headline and the line under it wrapped at the phone's width, then the button.
// The widths are an average letter of each face at its weight, measured once and kept a little wide so the guess
// errs toward "too low". The fold is what a phone shows with its browser bars in, not the screen's full height.
export const FOLD = 700;
export const PHONE_TYPE = {
  bar: 64, top: 36, gutter: 22, gap: 16, beforeButton: 28, button: 52,
  headline: { clean: [40, 1.08, 0.56], editorial: [46, 1.04, 0.46], brand: [40, 1.08, 0.56] } as Record<SiteLook, [size: number, leading: number, letter: number]>,
  lede: [18, 1.5, 0.52] as [number, number, number],
};
export function linesAt(text: string, width: number, size: number, letter: number): number {
  const fits = Math.max(4, Math.floor(width / (size * letter)));
  let lines = 0;
  let used = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!lines || used + 1 + word.length > fits) { lines += 1; used = word.length; } else used += 1 + word.length;
  }
  return lines;
}
export function buttonBottom(hero: Section, look: SiteLook, width = PHONE.width): number {
  const inner = width - PHONE_TYPE.gutter * 2;
  const [size, leading, letter] = PHONE_TYPE.headline[look];
  const [ledeSize, ledeLeading, ledeLetter] = PHONE_TYPE.lede;
  const lede = ledeOf(hero);
  const headline = linesAt(hero.headline, inner, size, letter) * size * leading;
  const under = lede ? PHONE_TYPE.gap + linesAt(lede, inner, ledeSize, ledeLetter) * ledeSize * ledeLeading : 0;
  return Math.round(PHONE_TYPE.bar + PHONE_TYPE.top + headline + under + PHONE_TYPE.beforeButton + PHONE_TYPE.button);
}
const ledeOf = (hero: Section) => hero.lines.slice(0, 2).join(' ');

// The hero said in fewer words until its button is above the fold: the line under the headline first, then the
// headline itself. Each cut is said.
export function foldHero(hero: Section, look: SiteLook): { hero: Section; said: string[]; bottom: number } {
  const said: string[] = [];
  let next = { ...hero, lines: [...hero.lines] };
  const words = (text: string) => text.split(/\s+/).filter(Boolean);
  const steps: [string, (one: Section) => Section][] = [
    ['kept one line under the hero headline', (one) => ({ ...one, lines: one.lines.slice(0, 1) })],
    ['cut the line under the hero headline to 14 words', (one) => ({ ...one, lines: one.lines.slice(0, 1).map((line) => (words(line).length > 14 ? `${words(line).slice(0, 14).join(' ')}…` : line)) })],
    ['cut the hero headline to 7 words', (one) => ({ ...one, headline: clip(one.headline, 7) })],
    ['took the line under the hero headline out', (one) => ({ ...one, lines: [] })],
    ['cut the hero headline to 5 words', (one) => ({ ...one, headline: clip(one.headline, 5) })],
  ];
  for (const [what, step] of steps) {
    if (buttonBottom(next, look) <= FOLD) break;
    const after = step(next);
    if (JSON.stringify(after) === JSON.stringify(next)) continue;
    next = after;
    said.push(`${what}, so the button is above the fold on a phone`);
  }
  return { hero: next, said, bottom: buttonBottom(next, look) };
}

// ---------------------------------------------------------------- the page

// A pricing line as a plan: "Team: $12 a seat a month · for five or more" is a name, a price and what it is for.
export function planOf(line: string): { name: string; price: string; detail: string } {
  const colon = /^([^:]{1,40}):\s*(.+)$/.exec(line);
  const [name, rest] = colon ? [colon[1].trim(), colon[2].trim()] : ['', line.trim()];
  const price = /(?:[$€£]\s?\d[\d,.]*(?:\s?(?:k|m))?|\bfree\b)(?:\s*(?:\/|a|per)\s*(?:month|mo|year|yr|seat|user)(?:\s*(?:\/|a|per)\s*(?:month|mo|year|yr|seat|user))?)?/i.exec(rest)?.[0] ?? '';
  const detail = rest.replace(price, '').replace(/^[\s·,;:–—-]+|[\s·,;:–—-]+$/g, '');
  return { name, price, detail };
}
export const faqOf = (line: string): { q: string; a: string } => {
  const at = line.indexOf('?');
  return at < 0 ? { q: line, a: '' } : { q: line.slice(0, at + 1).trim(), a: line.slice(at + 1).trim() };
};

function hrefOf(link?: string): string {
  if (!link) return '#join';
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(link)) return `mailto:${link}`;
  return link;
}

function figureHtml(section: Section): string {
  if (!section.figure) return '';
  return `<div class="figure"><b>${escape(section.figure.value)}</b>${section.figure.label ? `<span>${escape(section.figure.label)}</span>` : ''}</div>`;
}
const sourceHtml = (section: Section) => (section.source ? `<p class="source">Source: ${escape(section.source)}</p>` : '');
const pictureHtml = (section: Section, dress: Dress, className: string) => {
  const picture = dress.pictures?.[section.id];
  return picture ? `<figure class="${className}"><img src="media/${escape(picture.file)}" alt="${escape(section.picture ?? '')}" width="${picture.width}" height="${picture.height}" loading="${className === 'hero__picture' ? 'eager' : 'lazy'}"></figure>` : '';
};

function sectionHtml(section: Section, dress: Dress): string {
  const href = escape(hrefOf(dress.link));
  const paragraphs = section.lines.map((line) => `<p>${escape(line)}</p>`).join('');
  const eyebrow = section.headline.trim().toLowerCase() === SECTION_NAMES[section.kind].toLowerCase() ? '' : `<p class="eyebrow">${escape(SECTION_NAMES[section.kind])}</p>`;
  const head = (tag = 'h2') => `${eyebrow}<${tag}>${escape(section.headline)}</${tag}>`;
  switch (section.kind) {
    case 'hero': {
      const lede = ledeOf(section);
      const picture = pictureHtml(section, dress, 'hero__picture');
      return `<section class="hero${picture ? ' hero--picture' : ''}" id="hero"><div class="wrap hero__in"><div class="hero__text"><h1>${escape(section.headline)}</h1>${lede ? `<p class="lede">${escape(lede)}</p>` : ''}`
        + `<p class="actions"><a class="button" href="${href}">${escape(section.button ?? '')}</a></p>${figureHtml(section)}</div>${picture}</div></section>`;
    }
    case 'how':
      return `<section class="band" id="how"><div class="wrap">${head()}<ol class="steps">${section.lines.map((line, index) => `<li><span class="steps__n">${String(index + 1).padStart(2, '0')}</span><p>${escape(line)}</p></li>`).join('')}</ol>${figureHtml(section)}${sourceHtml(section)}</div></section>`;
    case 'proof':
      return `<section class="band band--surface" id="proof"><div class="wrap">${head()}<div class="proof">${figureHtml(section)}<ul class="claims">${section.lines.map((line) => `<li>${escape(line)}</li>`).join('')}</ul></div>${sourceHtml(section)}</div></section>`;
    case 'pricing':
      return `<section class="band" id="pricing"><div class="wrap">${head()}<div class="plans">${section.lines.map((line) => {
        const plan = planOf(line);
        return `<div class="plan">${plan.name ? `<h3>${escape(plan.name)}</h3>` : ''}${plan.price ? `<p class="plan__price">${escape(plan.price)}</p>` : ''}${plan.detail ? `<p>${escape(plan.detail)}</p>` : ''}</div>`;
      }).join('')}</div>${sourceHtml(section)}</div></section>`;
    case 'faq':
      return `<section class="band band--surface" id="faq"><div class="wrap narrow">${head()}<div class="faq">${section.lines.map((line) => {
        const { q, a } = faqOf(line);
        return `<details><summary>${escape(q)}</summary>${a ? `<p>${escape(a)}</p>` : ''}</details>`;
      }).join('')}</div></div></section>`;
    case 'cta': {
      const picture = dress.pictures?.[section.id];
      const hold = picture?.hold ?? 0.9;
      return `<section class="closing${picture ? ' closing--picture' : ''}" id="join"${picture ? ` style="--hold:${hold}"` : ''}>${picture ? `<img class="closing__bg" src="media/${escape(picture.file)}" alt="" loading="lazy">` : ''}`
        + `<div class="wrap closing__in"><h2>${escape(section.headline)}</h2>${paragraphs}<p class="actions"><a class="button" href="${href}">${escape(section.button ?? '')}</a></p>${sourceHtml(section)}</div></section>`;
    }
    default:
      return `<section class="band" id="${section.kind}"><div class="wrap split"><div>${head()}</div><div class="split__body">${paragraphs}${figureHtml(section)}${pictureHtml(section, dress, 'band__picture')}${sourceHtml(section)}</div></div></section>`;
  }
}

// The whole page: its HTML, its stylesheet, and the font files it names (under `media/`). Pure but for reading the
// app's own vendored fonts. `buttons` says whether the buttons have somewhere to go.
export async function renderSite(title: string, sections: Section[], dress: Dress): Promise<{ html: string; css: string; files: { name: string; bytes: Buffer }[]; said: string[]; lowest: number }> {
  const { palette, said, lowest } = paletteOf(dress.look, dress.brand);
  const files: { name: string; bytes: Buffer }[] = [];
  files.push({ name: 'sans.woff2', bytes: await readFile(join(VENDOR, 'inter.woff2')) });
  if (dress.look === 'editorial') files.push({ name: 'serif.woff2', bytes: await readFile(join(VENDOR, 'instrument-serif.woff2')) });
  const own = dress.look === 'brand' && dress.font && /\.(woff2?|ttf|otf)$/i.test(dress.font.name) ? `brand.${dress.font.name.split('.').pop()!.toLowerCase()}` : null;
  if (own) files.push({ name: own, bytes: dress.font!.bytes });
  const logo = dress.logo && /\.(png|jpe?g|webp|svg)$/i.test(dress.logo.name) ? `logo.${dress.logo.name.split('.').pop()!.toLowerCase()}` : null;
  if (logo) files.push({ name: logo, bytes: dress.logo!.bytes });

  const name = dress.name?.trim() || title;
  const hero = sections.find((section) => section.kind === 'hero');
  const description = hero ? ledeOf(hero) || hero.headline : title;
  const nav = `<header class="bar"><div class="wrap bar__in"><a class="bar__name" href="#hero">${logo ? `<img src="media/${logo}" alt="" height="24">` : ''}<span>${escape(name)}</span></a>`
    + `${hero?.button ? `<a class="bar__button" href="${escape(hrefOf(dress.link))}">${escape(hero.button)}</a>` : ''}</div></header>`;
  const nowhere = dress.link ? '' : '\n<!-- The buttons go to #join until the brief names a link or an email: point them at your waitlist form. -->';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description.slice(0, 160))}">
<link rel="stylesheet" href="style.css">
</head>
<body>${nowhere}
${nav}
<main>
${sections.map((section) => sectionHtml(section, dress)).join('\n')}
</main>
<footer class="foot"><div class="wrap">© ${dress.year ?? new Date().getFullYear()} ${escape(name)}</div></footer>
</body>
</html>
`;
  return { html, css: styleOf(dress.look, palette, own), files, said, lowest };
}

function styleOf(look: SiteLook, p: Palette, own: string | null): string {
  const serif = look === 'editorial';
  const faces = [
    `@font-face{font-family:'Site Sans';src:url(media/sans.woff2) format('woff2');font-weight:100 900;font-display:swap}`,
    serif ? `@font-face{font-family:'Site Serif';src:url(media/serif.woff2) format('woff2');font-weight:400;font-display:swap}` : '',
    own ? `@font-face{font-family:'Site Brand';src:url(media/${own});font-display:swap}` : '',
  ].filter(Boolean).join('\n');
  const display = own ? "'Site Brand', 'Site Sans'" : serif ? "'Site Serif', Georgia" : "'Site Sans'";
  const [phoneSize, phoneLeading] = PHONE_TYPE.headline[look];
  const weight = serif ? 400 : 650;
  return `${faces}
:root{--ground:${p.ground};--surface:${p.surface};--line:${p.line};--ink:${p.ink};--quiet:${p.quiet};--signal:${p.signal};--on:${p.on};--accent:${p.accent};
--display:${display}, system-ui, sans-serif;--body:'Site Sans', system-ui, -apple-system, sans-serif;--radius:14px}
*{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font:17px/1.6 var(--body);-webkit-font-smoothing:antialiased;font-synthesis:none}
img{display:block;max-width:100%;height:auto}
a{color:inherit}
h1,h2,h3{margin:0;font-family:var(--display);font-weight:${weight};letter-spacing:${serif ? '-.01em' : '-.025em'};text-wrap:balance}
p{margin:0}
.wrap{width:100%;max-width:1120px;margin:0 auto;padding:0 40px}
.narrow{max-width:820px}
.bar{position:sticky;top:0;z-index:2;height:64px;background:color-mix(in srgb,var(--ground) 88%,transparent);backdrop-filter:saturate(1.6) blur(14px);-webkit-backdrop-filter:saturate(1.6) blur(14px);border-bottom:1px solid var(--line)}
.bar__in{height:100%;display:flex;align-items:center;justify-content:space-between;gap:16px}
.bar__name{display:flex;align-items:center;gap:10px;font-weight:650;letter-spacing:-.01em;text-decoration:none}
.bar__name img{height:24px;width:auto}
.bar__button{padding:8px 16px;border-radius:999px;background:var(--signal);color:var(--on);font-size:14px;font-weight:600;text-decoration:none}
.hero{padding:120px 0 104px}
.hero__in{display:grid;grid-template-columns:1fr;gap:56px;align-items:center}
.hero--picture .hero__in{grid-template-columns:1.05fr .95fr}
.hero h1{font-size:${serif ? 84 : 72}px;line-height:${serif ? 1.02 : 1.04};max-width:14ch}
.hero:not(.hero--picture) h1{max-width:18ch}
.lede{margin-top:24px;max-width:40ch;font-size:21px;line-height:1.5;color:var(--quiet)}
.actions{margin-top:36px}
.button{display:inline-flex;align-items:center;justify-content:center;min-height:52px;padding:0 28px;border-radius:999px;background:var(--signal);color:var(--on);font-weight:600;font-size:17px;text-decoration:none;transition:transform .15s ease,box-shadow .15s ease}
.button:hover{transform:translateY(-1px);box-shadow:0 8px 24px -8px color-mix(in srgb,var(--signal) 70%,transparent)}
.button:focus-visible,.bar__button:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.hero__picture{margin:0}
.hero__picture img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:calc(var(--radius) + 6px);box-shadow:0 30px 60px -30px rgba(0,0,0,.35)}
.band{padding:104px 0;border-top:1px solid var(--line)}
.band--surface{background:var(--surface)}
.eyebrow{margin-bottom:14px;font-size:13px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
.band h2,.closing h2{font-size:${serif ? 54 : 44}px;line-height:1.08;max-width:22ch}
.split{display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:start}
.split__body{display:flex;flex-direction:column;gap:18px;padding-top:34px;font-size:19px;color:var(--quiet)}
.band__picture{margin:8px 0 0}.band__picture img{border-radius:var(--radius)}
.steps{list-style:none;margin:48px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px;counter-reset:none}
.steps li{padding:28px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
.steps__n{display:block;margin-bottom:18px;font-family:var(--display);font-size:15px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums}
.steps p{font-size:18px;line-height:1.5}
.proof{display:flex;gap:56px;align-items:center;margin-top:44px}
.claims{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:18px;font-size:22px;line-height:1.45}
.claims li{padding-left:20px;border-left:3px solid var(--signal)}
.figure{display:flex;flex-direction:column;gap:6px;margin-top:28px}
.proof .figure{margin-top:0;flex:none}
.figure b{font-family:var(--display);font-size:88px;font-weight:${serif ? 400 : 700};line-height:.95;letter-spacing:-.04em;color:var(--accent);font-variant-numeric:tabular-nums}
.figure span{font-size:16px;color:var(--quiet);max-width:22ch}
.source{margin-top:28px;font-size:13px;color:var(--quiet)}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;margin-top:44px}
.plan{padding:32px;border:1px solid var(--line);border-radius:var(--radius);display:flex;flex-direction:column;gap:10px}
.plan h3{font-size:20px}
.plan__price{font-family:var(--display);font-size:40px;font-weight:${weight};letter-spacing:-.02em;color:var(--accent)}
.plan p{color:var(--quiet)}
.faq{margin-top:36px;border-top:1px solid var(--line)}
.faq details{border-bottom:1px solid var(--line)}
.faq summary{display:flex;justify-content:space-between;gap:24px;padding:22px 0;font-size:19px;font-weight:600;cursor:pointer;list-style:none}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:'+';flex:none;font-weight:400;color:var(--accent);transition:transform .2s ease}
.faq details[open] summary::after{transform:rotate(45deg)}
.faq details p{padding:0 0 24px;max-width:62ch;color:var(--quiet)}
.closing{position:relative;overflow:hidden;padding:128px 0;text-align:center;border-top:1px solid var(--line)}
.closing__bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.closing--picture::before{content:'';position:absolute;inset:0;z-index:1;background:var(--ground);opacity:var(--hold,.9)}
.closing__in{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;gap:18px}
.closing h2{max-width:20ch}
.closing p{max-width:52ch;color:var(--quiet);font-size:19px}
.closing .actions{margin-top:14px}
.foot{padding:40px 0 56px;border-top:1px solid var(--line);font-size:14px;color:var(--quiet)}
@media (max-width:760px){
.wrap{padding:0 ${PHONE_TYPE.gutter}px}
.hero{padding:${PHONE_TYPE.top}px 0 64px}
.hero__in,.hero--picture .hero__in{grid-template-columns:1fr;gap:40px}
.hero h1{font-size:${phoneSize}px;line-height:${phoneLeading};max-width:none}
.lede{margin-top:${PHONE_TYPE.gap}px;font-size:${PHONE_TYPE.lede[0]}px;line-height:${PHONE_TYPE.lede[1]}}
.actions{margin-top:${PHONE_TYPE.beforeButton}px}
.hero .button{width:100%}
.bar__button{display:none}
.band{padding:72px 0}
.band h2,.closing h2{font-size:${serif ? 38 : 32}px}
.split{grid-template-columns:1fr;gap:8px}
.split__body{padding-top:12px;font-size:17px}
.proof{flex-direction:column;align-items:flex-start;gap:28px}
.claims{font-size:19px}
.figure b{font-size:64px}
.closing{padding:88px 0}
}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}.button,.faq summary::after{transition:none}}
`;
}
