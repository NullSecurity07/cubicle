import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { Slide } from '../../shared/deck.ts';
import { deckToPptx, fitSize } from './pptx.ts';

// The zip's central directory read by hand, so the test needs nothing the app does not already have.
function unzip(zip: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = zip.readUInt32LE(end + 16);
  for (let count = zip.readUInt16LE(end + 10); count > 0; count -= 1) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const skip = nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString();
    const local = zip.readUInt32LE(at + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    files.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString());
    at += 46 + skip;
  }
  return files;
}

const slides: Slide[] = [
  { id: 's1', shape: 'title', headline: 'Relay for agencies', lines: ['Billing that runs itself'], notes: 'Open with the late invoice story.' },
  { id: 's2', shape: 'problem', headline: 'Agencies bill late', lines: ['Invoices wait on timesheets', 'Cash arrives a month late'] },
  { id: 's3', shape: 'chart', headline: 'Where the week goes', lines: ['Email: 40%', 'Meetings: 20%', 'Billing: 15%'], source: 'Founder survey, 40 agencies' },
  { id: 's4', shape: 'quote', headline: 'We got paid in a week for the first time.', lines: ['Dana, studio owner'] },
  { id: 's5', shape: 'ask', headline: 'Raising a seed round to reach 200 agencies', lines: ['18 months of runway'], figure: { value: '$1.5M', label: 'seed' }, source: 'Plan v3' },
];

describe('the deck as a PowerPoint file', () => {
  it('is a zip with a slide per slide, the words on them, a native chart and the speaker notes', async () => {
    const buffer = await deckToPptx({ title: 'Relay', slides }, { look: 'editorial' });
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    const files = unzip(buffer);
    expect(files.has('ppt/slides/slide5.xml')).toBe(true);
    expect(files.has('ppt/slides/slide6.xml')).toBe(false);
    expect(files.get('ppt/slides/slide1.xml')).toContain('Relay for agencies');
    expect(files.get('ppt/slides/slide5.xml')).toContain('Raising a seed round to reach 200 agencies');
    expect(files.get('ppt/slides/slide5.xml')).toContain('$1.5M');
    expect(files.get('ppt/slides/slide5.xml')).toContain('Source: Plan v3');
    expect(files.get('ppt/slides/slide5.xml')).toContain('5 / 5');
    // The editorial look: its ground, its signal, its serif.
    expect(files.get('ppt/slideLayouts/slideLayout2.xml') ?? [...files.entries()].find(([name]) => name.startsWith('ppt/slideLayouts/'))![1]).toContain('14120F');
    expect(files.get('ppt/slides/slide2.xml')).toContain('E4B45C');
    expect(files.get('ppt/slides/slide2.xml')).toContain('Instrument Serif');
    // The chart slide carries a real chart with the numbers from its lines.
    const chart = [...files.entries()].find(([name]) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
    expect(chart?.[1]).toContain('<c:barDir val="bar"/>');
    expect(chart?.[1]).toContain('<c:v>40</c:v>');
    expect(chart?.[1]).toContain('Email');
    const notes = [...files.entries()].filter(([name]) => name.startsWith('ppt/notesSlides/')).map(([, text]) => text).join('');
    expect(notes).toContain('Open with the late invoice story.');
  });

  it('wears the product\'s own colours in the brand look, and a chart of words stays words', async () => {
    const files = unzip(await deckToPptx({ title: 'x', slides: [{ id: 's1', shape: 'chart', headline: 'Why now', lines: ['Rules changed', 'Tools got cheap'] }] }, { look: 'brand', brand: { colours: ['#0b1020', '#ff5a36', '#ffffff'], font: 'Söhne' } }));
    expect(files.get('ppt/slides/slide1.xml')).toContain('FF5A36');
    expect(files.get('ppt/slides/slide1.xml')).toContain('Rules changed');
    expect(files.get('ppt/slides/slide1.xml')).toContain('Söhne');
    expect([...files.keys()].some((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name))).toBe(false);
  });

  it('shrinks a long headline and leaves a short one alone', () => {
    expect(fitSize('Short', 43.5, 34, 2)).toBe(43.5);
    expect(fitSize('x'.repeat(136), 43.5, 34, 2)).toBeLessThan(43.5);
    expect(fitSize('x'.repeat(1000), 43.5, 34, 2)).toBeCloseTo(26.1);
  });
});
