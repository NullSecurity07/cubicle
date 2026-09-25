import { describe, expect, it } from 'vitest';
import type { Slide } from '../../shared/deck.ts';
import { barOf, deckHtml, escape, stubPdf } from './render.ts';

const slides: Slide[] = [
  { id: 's1', shape: 'title', headline: 'Relay <for> agencies', lines: ['Calmer'] },
  { id: 's2', shape: 'market', headline: 'A real market', lines: ['4,200 agencies'], figure: { value: '4,200', label: 'agencies' }, source: 'Brand doc' },
  { id: 's3', shape: 'chart', headline: 'Where time goes', lines: ['Email: 40%', 'Meetings: 20%'] },
];

describe('the deck page', () => {
  it('is one 16:9 section a slide, escaped, with its sources at the foot', async () => {
    const html = await deckHtml(slides, { look: 'clean' }, 'Relay');
    expect(html.match(/<section class="slide/g)).toHaveLength(3);
    expect(html).toContain('@page{size:1280px 720px;margin:0}');
    expect(html).toContain('Relay &lt;for&gt; agencies');
    expect(html).toContain('Source: Brand doc');
    expect(html).toContain('2 / 3');
    expect(html).toContain('<div class="bar"><span>Email</span><i style="width:100%"></i><em>40%</em></div>');
    // Nothing is fetched: the typeface is written into the page.
    expect(html).toContain("src:url(data:font/woff2;base64,");
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('wears the film looks and the product\'s own colours', async () => {
    expect(await deckHtml(slides, { look: 'editorial' }, 'x')).toContain('--ground:#14120F');
    expect(await deckHtml(slides, { look: 'brand', brand: { colours: ['#0b1020', '#ff5a36', '#ffffff'] } }, 'x')).toContain('--signal:#ff5a36');
  });

  it('draws one slide on its own for a thumbnail', async () => {
    const one = await deckHtml(slides, { look: 'clean' }, 'Relay', 1);
    expect(one.match(/<section /g)).toHaveLength(1);
    expect(one).toContain('id="s2"');
    expect(await deckHtml(slides, { look: 'clean' }, 'Relay', 9)).not.toContain('<section');
  });

  it('reads a chart line and escapes text', () => {
    expect(barOf('Email: 40%')).toEqual({ label: 'Email', value: 40, shown: '40%' });
    expect(barOf('Just words')).toBeNull();
    expect(escape(`"<a & b>'`)).toBe('&quot;&lt;a &amp; b&gt;&#39;');
  });

  it('writes a stand-in PDF with a page a slide', () => {
    const pdf = stubPdf(4).toString();
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('/Count 4');
    expect(pdf.trim().endsWith('%%EOF')).toBe(true);
  });
});
