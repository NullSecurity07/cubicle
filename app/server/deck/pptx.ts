import PptxGenJS from 'pptxgenjs';
import { SHAPE_NAMES, type Slide } from '../../shared/deck.ts';
import { paintOf, rgbOf } from '../media/templates/packs.ts';
import { barOf, HEIGHT, WIDTH, type Dress } from './render.ts';

// The same deck as a PowerPoint file, for the founder whose investor asks for "the deck, editable". It mirrors the
// HTML slides: the same 16:9 page, the same look's palette and typefaces, the same layout per shape. The page is
// 1280×720 and PowerPoint's wide page is 13.333×7.5 inches, so a CSS pixel is 1/96 inch and a font pixel is 3/4 of
// a point; every measure below is the HTML one carried over. A chart slide whose lines are all numbers becomes a
// native bar chart the founder can edit; anything else stays text. Speaker notes go where a presenter looks for them.
// Typefaces are named, not embedded: PowerPoint uses them where they are installed and its own sans where not.

const px = (value: number) => value / 96;
const pt = (value: number) => Math.round(value * 0.75 * 10) / 10;
const hex = (colour: string, fallback: string) => {
  const rgb = rgbOf(colour);
  return rgb ? rgb.map((part) => part.toString(16).padStart(2, '0')).join('').toUpperCase() : fallback;
};
const IMAGE = /\.(png|jpe?g|gif)$/i;
const IMAGE_TYPE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };

// A headline shrinks as it grows, the way the HTML's balanced wrap keeps a long one on the page.
export function fitSize(text: string, base: number, perLine: number, lines: number): number {
  const needed = Math.ceil(text.length / perLine);
  return needed <= lines ? base : Math.max(base * 0.6, Math.round((base * lines) / needed));
}

export type PptxDeck = { title: string; slides: Slide[] };

export async function deckToPptx(deck: PptxDeck, dress: Dress): Promise<Buffer> {
  const paint = paintOf(dress.look === 'brand' ? 'brand' : dress.look === 'editorial' ? 'editorial' : 'clean', dress.brand);
  const colour = { ground: hex(paint.ground, '1C2530'), ink: hex(paint.ink, 'F2F5F8'), quiet: hex(paint.quiet, 'AFBDCB'), signal: hex(paint.signal, 'E8B04B') };
  const serif = dress.look === 'editorial';
  const sans = 'Inter';
  const display = dress.look === 'brand' && dress.brand?.font ? dress.brand.font : serif ? 'Instrument Serif' : sans;
  const heavy = !serif;

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = deck.title;
  pptx.company = dress.brand?.name ?? '';
  pptx.theme = { headFontFace: display, bodyFontFace: sans };
  pptx.defineSlideMaster({ title: 'DECK', background: { color: colour.ground }, objects: [] });

  const logoExt = dress.logo && IMAGE.test(dress.logo.name) ? dress.logo.name.split('.').pop()!.toLowerCase() : null;
  const logo = logoExt ? `${IMAGE_TYPE[logoExt]};base64,${dress.logo!.bytes.toString('base64')}` : null;
  const left = px(96);
  const inner = px(WIDTH - 192);

  deck.slides.forEach((slide, index) => {
    const page = pptx.addSlide({ masterName: 'DECK' });
    if (slide.notes) page.addNotes(slide.notes);

    // The foot of every slide: where its numbers came from (or the deck's own line), and which page this is.
    const footY = px(HEIGHT - 40 - 22);
    const footText = slide.source ? `Source: ${slide.source}` : dress.footer ?? '';
    const footLeft = logo && slide.shape !== 'title' ? left + px(34) : left;
    if (logo && slide.shape !== 'title') page.addImage({ data: logo, x: left, y: footY, h: px(22), w: px(22), sizing: { type: 'contain', w: px(22), h: px(22) } });
    if (footText) page.addText(footText, { x: footLeft, y: footY, w: inner - px(140) - (footLeft - left), h: px(22), fontFace: sans, fontSize: pt(15), color: colour.quiet, transparency: 22, margin: 0, valign: 'middle', fit: 'shrink' });
    page.addText(`${index + 1} / ${deck.slides.length}`, { x: left + inner - px(120), y: footY, w: px(120), h: px(22), fontFace: sans, fontSize: pt(15), color: colour.quiet, transparency: 22, align: 'right', margin: 0, valign: 'middle' });

    const eyebrow = () => page.addText(SHAPE_NAMES[slide.shape].toUpperCase(), { x: left, y: px(84), w: inner, h: px(24), fontFace: sans, fontSize: pt(17), bold: true, charSpacing: 2, color: colour.signal, margin: 0, valign: 'top' });

    if (slide.shape === 'title') {
      if (logo) page.addImage({ data: logo, x: left, y: px(80), h: px(44), w: px(44), sizing: { type: 'contain', w: px(44), h: px(44) } });
      page.addShape(pptx.ShapeType.roundRect, { x: left, y: px(250), w: px(72), h: px(5), fill: { color: colour.signal }, line: { color: colour.signal, width: 0 }, rectRadius: 0.02 });
      // The headline and the line under it are one box, so the line always sits just under however many lines it took.
      const size = fitSize(slide.headline, pt(serif ? 104 : 92), 22, 2);
      const sub = slide.lines.slice(0, 2).join(' ');
      page.addText([
        { text: slide.headline, options: { fontFace: display, fontSize: size, bold: heavy, color: colour.ink, lineSpacingMultiple: 0.95, breakLine: true, paraSpaceAfter: 26 } },
        ...(sub ? [{ text: sub, options: { fontFace: sans, fontSize: pt(32), color: colour.quiet, lineSpacingMultiple: 1.2 } }] : []),
      ], { x: left, y: px(290), w: px(1040), h: px(HEIGHT - 290 - 96), margin: 0, valign: 'top' });
      return;
    }

    eyebrow();
    if (slide.shape === 'quote') {
      const size = fitSize(slide.headline, pt(serif ? 64 : 54), 34, 4);
      page.addText([{ text: '“', options: { color: colour.signal } }, { text: slide.headline }], { x: left, y: px(170), w: px(1030), h: px(330), fontFace: display, fontSize: size, bold: heavy, color: colour.ink, margin: 0, valign: 'middle', lineSpacingMultiple: 1.1 });
      if (slide.lines.length) page.addText(slide.lines.join(' · '), { x: left, y: px(530), w: inner, h: px(40), fontFace: sans, fontSize: pt(24), color: colour.quiet, margin: 0 });
      return;
    }

    const headSize = fitSize(slide.headline, pt(serif ? 66 : 58), 34, 2);
    page.addText(slide.headline, { x: left, y: px(124), w: px(1000), h: px(140), fontFace: display, fontSize: headSize, bold: heavy, color: colour.ink, margin: 0, valign: 'top', lineSpacingMultiple: 1 });

    // The body sits under the headline, the big number (if any) at its right, as on the HTML slide.
    const bodyY = px(290);
    const bodyH = px(HEIGHT - 96 - 290);
    const figureW = slide.figure ? px(slide.shape === 'ask' ? 460 : 420) : 0;
    const gap = slide.figure ? px(64) : 0;
    const bodyW = inner - figureW - gap;
    if (slide.figure) {
      // The number stays on one line: a figure glyph is about 0.62 of its size wide, so the size is what fits the column.
      const size = pt(Math.min(slide.shape === 'ask' ? 170 : 150, (figureW * 96) / (Math.max(1, slide.figure.value.length) * 0.62)));
      page.addText([
        { text: slide.figure.value, options: { fontFace: display, fontSize: size, bold: heavy, color: colour.signal, breakLine: true } },
        ...(slide.figure.label ? [{ text: slide.figure.label, options: { fontFace: sans, fontSize: pt(24), color: colour.quiet } }] : []),
      ], { x: left + bodyW + gap, y: bodyY, w: figureW, h: bodyH, margin: 0, valign: 'middle', paraSpaceAfter: 6 });
    }

    const bars = slide.shape === 'chart' ? slide.lines.map(barOf) : [];
    if (bars.length && bars.every(Boolean)) {
      // PowerPoint draws a bar chart's first category at the bottom; the list is turned over so it reads top down.
      const found = bars.map((bar) => bar!).reverse();
      page.addChart(pptx.ChartType.bar, [{ name: slide.headline, labels: found.map((bar) => bar.label), values: found.map((bar) => bar.value) }], {
        x: left, y: bodyY, w: bodyW, h: bodyH, barDir: 'bar', chartColors: [colour.signal], barGapWidthPct: 60,
        catAxisLabelColor: colour.quiet, catAxisLabelFontFace: sans, catAxisLabelFontSize: pt(24), catAxisLineShow: false,
        valAxisHidden: true, valGridLine: { style: 'none' }, catGridLine: { style: 'none' },
        showValue: true, dataLabelColor: colour.ink, dataLabelFontFace: sans, dataLabelFontSize: pt(22), dataLabelPosition: 'outEnd',
        dataLabelFormatCode: found.every((bar) => bar.shown.trim().endsWith('%')) ? '0"%"' : 'General',
        plotArea: { fill: { color: colour.ground } }, showLegend: false,
      });
      return;
    }

    if (slide.lines.length) {
      const size = slide.lines.length > 5 ? pt(24) : pt(29);
      page.addText(slide.lines.map((line) => ({ text: line, options: { bullet: { code: '2013', indent: 22 }, breakLine: true } })), {
        x: left, y: bodyY, w: bodyW, h: bodyH, fontFace: sans, fontSize: size, color: colour.quiet, margin: 0, valign: 'middle', paraSpaceAfter: 14, fit: 'shrink',
      });
    }
  });

  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}
