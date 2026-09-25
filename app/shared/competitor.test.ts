import { describe, expect, it } from 'vitest';
import { agoText, changePhrase, competitorLine, hostOf, pageKey, pageLabel, samePage, siteUrl, suggestedPages, type ChangeRow } from './competitor.ts';

const at = (day: string) => new Date(`${day}T12:00:00`).getTime();
const change = (day: string, label: string, phrase: string): ChangeRow => ({ id: `${label}:${day}`, url: '', label, at: at(day), lines: [], phrase });

describe('a rival\'s addresses', () => {
  it('makes a typed site whole, and refuses what is not one', () => {
    expect(siteUrl('acme.com')).toBe('https://acme.com/');
    expect(siteUrl(' http://acme.com/pricing ')).toBe('http://acme.com/pricing');
    expect(siteUrl('')).toBeNull();
    expect(siteUrl(undefined)).toBeNull();
    expect(siteUrl('acme')).toBeNull();
    expect(siteUrl('ftp://acme.com')).toBeNull();
    expect(hostOf('https://www.acme.com/x')).toBe('acme.com');
  });

  it('counts two spellings of one page as one page', () => {
    expect(samePage('acme.com/pricing/', 'https://ACME.com/pricing#plans')).toBe(true);
    expect(samePage('acme.com/pricing', 'acme.com/pricing?annual=1')).toBe(false);
    expect(pageKey('https://acme.com')).toBe('acme.com/');
  });

  it('suggests home, pricing and changelog, and names a page by its path', () => {
    expect(suggestedPages('acme.com/about')).toEqual([
      { url: 'https://acme.com/', label: 'Home' }, { url: 'https://acme.com/pricing', label: 'Pricing' }, { url: 'https://acme.com/changelog', label: 'Changelog' },
    ]);
    expect(suggestedPages('')).toEqual([]);
    expect(pageLabel('https://acme.com/')).toBe('Home');
    expect(pageLabel('https://acme.com/company/careers-at-acme')).toBe('Careers at acme');
    expect(pageLabel('https://acme.com/docs/changelog.html')).toBe('Changelog');
  });
});

describe('a change in a few words', () => {
  it('says a replaced line as before → after, keeping only what differs', () => {
    expect(changePhrase('+ Pro $39\n− Pro $29')).toBe('Pro $29 → $39');
    expect(changePhrase('+ Team is $14 a month per seat\n− Team is $12 a month per seat')).toBe('Team is $12 → $14 a month per seat');
    expect(changePhrase('+ Enterprise: talk to us\n+ Starter: free')).toBe('Enterprise: talk to us');
    expect(changePhrase('− Free plan for one person')).toBe('removed: Free plan for one person');
    expect(changePhrase('The words moved around, but no line was added or taken out.')).toBe('The words moved around, but no line was added or taken out.');
    expect(changePhrase(`+ ${'x'.repeat(300)}`).length).toBe(120);
  });
});

describe('the line a wired person reads', () => {
  const card = { name: 'Acme', url: 'https://acme.com/' };
  const watched = [{ url: 'https://acme.com/pricing', label: 'Pricing', watch: { id: 'w1', title: 'Pricing', owner: 'Maya' } }];
  const now = at('2026-09-25');

  it('is the brief\'s line: changes this month, and the latest one dated', () => {
    const changes = [change('2026-09-22', 'Pricing', 'Pro $29 → $39'), change('2026-09-10', 'Changelog', 'v2 is out'), change('2026-09-02', 'Home', 'New tagline'), change('2026-08-30', 'Home', 'Old')];
    expect(competitorLine(card, { pages: watched, changes, lastRead: now, overdue: false }, now))
      .toBe('- Competitor Acme (acme.com): 3 changes this month, latest 2026-09-22 pricing page: Pro $29 → $39.');
  });

  it('says when nothing is watched, when nothing changed, and when the reads are stale', () => {
    expect(competitorLine({ name: '', url: 'acme.com' }, { pages: [], changes: [], lastRead: null, overdue: false }, now)).toBe('- Competitor acme.com (acme.com): no page watched yet.');
    expect(competitorLine(card, { pages: watched, changes: [], lastRead: at('2026-09-24'), overdue: true }, now))
      .toBe('- Competitor Acme (acme.com): 1 page watched, no change seen yet, last read 2026-09-24. Last read 2026-09-24, so newer changes may not be seen yet.');
    expect(competitorLine(card, { pages: watched, changes: [change('2026-08-30', 'Home', 'Old.')], lastRead: now, overdue: false }, now))
      .toBe('- Competitor Acme (acme.com): 0 changes this month, latest 2026-08-30 home page: Old.');
  });

  it('says how long ago the way the app does', () => {
    expect(agoText(now - 20_000, now)).toBe('just now');
    expect(agoText(now - 3 * 3600_000, now)).toBe('3 h ago');
    expect(agoText(now - 2 * 86_400_000, now)).toBe('2 d ago');
  });
});
