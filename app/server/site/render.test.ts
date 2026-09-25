import { describe, expect, it } from 'vitest';
import type { Section } from '../../shared/site.ts';
import { WANTS } from '../media/contrast.ts';
import { buttonBottom, contrastOf, faqOf, FOLD, foldHero, paletteOf, planOf, readable, renderSite } from './render.ts';

const hero = (headline: string, lines: string[] = []): Section => ({ id: 'x1', kind: 'hero', headline, lines, button: 'Join the waitlist' });

describe('the site renderer', () => {
  it('paints every look with all text at 4.5:1 or better', () => {
    for (const look of ['clean', 'editorial', 'brand'] as const) expect(paletteOf(look).lowest).toBeGreaterThanOrEqual(WANTS);
  });

  it('moves a brand colour that cannot be read just far enough, and says so', () => {
    const { palette, said, lowest } = paletteOf('brand', { colours: ['#101418', '#FFE45C', '#2A2F36'] });
    expect(lowest).toBeGreaterThanOrEqual(WANTS);
    expect(contrastOf(palette.on, palette.signal)).toBeGreaterThanOrEqual(WANTS);
    expect(Array.isArray(said)).toBe(true);
    const fixed = readable('#9AA0A6', ['#FFFFFF'], '#000000');
    expect(contrastOf(fixed, '#FFFFFF')).toBeGreaterThanOrEqual(WANTS);
    expect(contrastOf(fixed, '#FFFFFF')).toBeLessThan(5.2);
  });

  it('works out where the hero button lands on a phone, and cuts words until it is above the fold', () => {
    expect(buttonBottom(hero('Relay'), 'clean')).toBeLessThan(FOLD);
    const long = hero('Relay is the calm invoicing tool that small creative agencies use to bill clients on time', [
      'It reads your timesheets, drafts every invoice, chases the late ones politely and tells you each Monday who still owes you what, so nothing slips.',
      'It works with the tools you already use, from the timesheet app your team opens every morning to the accounting package your bookkeeper insists on keeping.',
    ]);
    expect(buttonBottom(long, 'clean')).toBeGreaterThan(FOLD);
    const folded = foldHero(long, 'clean');
    expect(folded.bottom).toBeLessThanOrEqual(FOLD);
    expect(folded.said.length).toBeGreaterThan(0);
    expect(foldHero(hero('Relay', ['Short']), 'clean').said).toEqual([]);
  });

  it('reads a pricing line as a plan and a faq line as a question and answer', () => {
    expect(planOf('Team: $12 a seat · for five or more')).toEqual({ name: 'Team', price: '$12 a seat', detail: 'for five or more' });
    expect(planOf('Free for one person')).toMatchObject({ price: 'Free' });
    expect(faqOf('Is it free? Yes, in early access.')).toEqual({ q: 'Is it free?', a: 'Yes, in early access.' });
  });

  it('writes one H1, no script, escaped words, and buttons that go where the brief said', async () => {
    const sections: Section[] = [hero('Bill <on> time', ['Calm']), { id: 'x2', kind: 'faq', headline: 'Questions', lines: ['Free? Yes.'] }, { id: 'x3', kind: 'cta', headline: 'Start', lines: [], button: 'Join the waitlist' }];
    const page = await renderSite('Relay', sections, { look: 'editorial', link: 'hello@relay.app', year: 2026 });
    expect(page.html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(page.html).not.toMatch(/<script/i);
    expect(page.html).toContain('Bill &lt;on&gt; time');
    expect(page.html).toContain('href="mailto:hello@relay.app"');
    expect(page.html).toContain('<details><summary>Free?</summary><p>Yes.</p></details>');
    expect(page.files.map((file) => file.name)).toEqual(['sans.woff2', 'serif.woff2']);
    expect(page.css).toContain("font-family:'Site Serif'");
    const plain = await renderSite('Relay', sections, { look: 'clean' });
    expect(plain.html).toContain('href="#join"');
    expect(plain.html).toContain('point them at your waitlist form');
  });
});
