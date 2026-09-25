import { describe, expect, it } from 'vitest';
import type { Section } from '../../shared/site.ts';
import { applyEdits, kindOf, readNotes } from './notes.ts';

const page: Section[] = (['hero', 'problem', 'how', 'proof', 'pricing', 'faq', 'cta'] as const).map((kind, index) => ({ id: `x${index + 1}`, kind, headline: kind, lines: [], ...(kind === 'hero' || kind === 'cta' ? { button: 'Join' } : {}) }));

describe('notes on a site', () => {
  it('names a section by what the founder calls it, the first one named', () => {
    expect(kindOf('shorter hero')).toBe('hero');
    expect(kindOf('pricing: say how much')).toBe('pricing');
    expect(kindOf('the how it works steps')).toBe('how');
    expect(kindOf('something else')).toBeNull();
  });

  it('reads plain edits and hands the rest on as rewrites of one section', () => {
    const read = readNotes('drop pricing, move proof after hero; swap faq and how. hero headline: Bill on time. button: Book a demo. shorter hero. make it pop', page);
    expect(read.edits).toEqual([
      { kind: 'drop', id: 'x5' },
      { kind: 'move', id: 'x4', after: 'x1' },
      { kind: 'swap', a: 'x6', b: 'x3' },
      { kind: 'headline', id: 'x1', text: 'Bill on time' },
      { kind: 'button', text: 'Book a demo' },
      { kind: 'rewrite', id: 'x1', ask: 'shorter hero' },
    ]);
    expect(read.unread).toEqual(['make it pop']);
  });

  it('says so when a note names a section the page does not have', () => {
    const read = readNotes('drop pricing', page.filter((one) => one.kind !== 'pricing'));
    expect(read.edits).toEqual([]);
    expect(read.unread[0]).toMatch(/there is no pricing section/);
  });

  it('applies them in order and marks what changed words', () => {
    const read = readNotes('drop pricing, move proof to the top, button: Book a demo', page);
    const done = applyEdits(page, read.edits);
    expect(done.sections.map((one) => one.kind)).toEqual(['proof', 'hero', 'problem', 'how', 'faq', 'cta']);
    expect([...done.touched].sort()).toEqual(['x1', 'x7']);
    expect(done.sections.find((one) => one.kind === 'cta')!.button).toBe('Book a demo');
    expect(done.said).toEqual(['dropped the pricing', 'moved the proof to the top', 'the button now says "Book a demo"']);
    expect(page[0].button).toBe('Join');
  });
});
