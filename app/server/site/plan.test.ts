import { describe, expect, it } from 'vitest';
import type { Section } from '../../shared/site.ts';
import { clip, DEFAULT_BUTTON, faults, fakePlan, mend, parsePlan, rewriteSection, shorter, traced, writePlan, type Material } from './plan.ts';

const material: Material = {
  brief: 'A waitlist page for Relay, $12 a seat a month',
  sources: [{ name: 'Customer notes', text: 'Maya at Northwind said "Relay gave us our Mondays back" in the pilot.' }],
  metrics: { name: 'the Metrics card', text: 'Weekly active teams: 340 last week.' },
};
const at = (kind: Section['kind'], headline: string, lines: string[] = [], extra: Partial<Section> = {}): Section => ({ id: `x-${kind}`, kind, headline, lines, ...extra });

describe('the page plan', () => {
  it('traces a claim to a number the material states, or to words a doc holds', () => {
    expect(traced('Used by 340 teams every week', material)).toBe(true);
    expect(traced('Used by 1,200 teams every week', material)).toBe(false);
    expect(traced('"Relay gave us our Mondays back"', material)).toBe(true);
    expect(traced('Loved by founders everywhere', material)).toBe(false);
  });

  it('cuts a proof line nobody wired, drops an empty proof section, and says so', () => {
    const { sections, said, cut } = mend([
      at('hero', 'Relay', ['Calm billing'], { button: 'Join' }),
      at('proof', 'Teams rely on it', ['Trusted by 5,000 agencies']),
      at('cta', 'Start', [], { button: 'Join' }),
    ], material);
    expect(sections.map((one) => one.kind)).toEqual(['hero', 'cta']);
    expect(cut).toBe(1);
    expect(said.join(' ')).toMatch(/cut "Trusted by 5,000 agencies"/);
    expect(said.join(' ')).toMatch(/dropped the proof section/);
  });

  it('keeps a sourced figure and names where it came from, and cuts an unsourced price', () => {
    const { sections } = mend([
      at('hero', 'Relay', [], { button: 'Join' }),
      at('proof', 'Teams use it weekly', [], { figure: { value: '340', label: 'weekly active teams' } }),
      at('pricing', 'Simple pricing', ['Team: $12 a seat a month', 'Enterprise: $99 a month']),
      at('cta', 'Start', [], { button: 'Join' }),
    ], material);
    expect(sections[1].source).toBe('the Metrics card');
    expect(sections[2].lines).toEqual(['Team: $12 a seat a month']);
    expect(sections[2].source).toBe('your brief');
  });

  it('puts the hero first and the call to action last, with buttons', () => {
    const { sections, said } = mend([at('problem', 'Pain', ['x']), at('hero', 'Relay')], material, () => 'x9');
    expect(sections.map((one) => one.kind)).toEqual(['hero', 'problem', 'cta']);
    expect(sections[0].button).toBe(DEFAULT_BUTTON);
    expect(sections[2].button).toBe(DEFAULT_BUTTON);
    expect(said).toContain('moved the hero to the top');
  });

  it('keeps a section that passes exactly as it was', () => {
    const good = [at('hero', 'Relay', ['Calm billing'], { button: 'Join' }), at('cta', 'Start', [], { button: 'Join' })];
    expect(mend(good, material).sections).toEqual(good);
    expect(faults(good, material)).toEqual([]);
  });

  it('names what is wrong for the model', () => {
    const found = faults([at('problem', 'A headline that goes on for far too many words to be read at once', ['x'])], material);
    expect(found.join('\n')).toMatch(/first section must be "hero"/);
    expect(found.join('\n')).toMatch(/headline has 15 words/);
  });

  it('refuses a plan with a section of an unknown kind', () => {
    let n = 0;
    expect(() => parsePlan({ sections: [{ kind: 'hero', headline: 'a' }, { kind: 'blog', headline: 'b' }] }, () => `x${++n}`)).toThrow(/"kind" must be one of/);
    const plan = parsePlan({ title: 'Relay', sections: [{ kind: 'hero', headline: ' a ', button: 'Go', picture: 'a desk' }, { kind: 'cta', headline: 'b', lines: ['', 'c'] }] }, () => `x${++n}`);
    expect(plan.sections[0]).toMatchObject({ headline: 'a', button: 'Go', picture: 'a desk' });
    expect(plan.sections[1].lines).toEqual(['c']);
  });

  it('asks a second time with the faults, then mends', async () => {
    const asked: string[] = [];
    const replies = [
      JSON.stringify({ title: 'Relay', sections: [{ kind: 'hero', headline: 'Relay', button: 'Join' }, { kind: 'proof', headline: 'Loved', lines: ['Used by 9,999 teams'] }, { kind: 'cta', headline: 'Go', button: 'Join' }] }),
      JSON.stringify({ title: 'Relay', sections: [{ kind: 'hero', headline: 'Relay', button: 'Join' }, { kind: 'proof', headline: 'Used weekly', lines: ['Used by 340 teams'] }, { kind: 'cta', headline: 'Go', button: 'Join' }] }),
    ];
    let n = 0;
    const made = await writePlan({ brief: 'x', material, think: async (prompt) => { asked.push(prompt); return replies[asked.length - 1]; }, ids: () => `x${++n}`, now: 0, report: () => {} });
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatch(/9,999 is not in the material/);
    expect(made.sections[1].lines).toEqual(['Used by 340 teams']);
    expect(made.cut).toBe(0);
  });

  it('makes the same fixed plan in fake mode, with its unsourced claim cut', async () => {
    let n = 0;
    const made = await writePlan({ brief: 'Relay helps agencies bill on time. hello@relay.app', material: { brief: '', sources: [] }, ids: () => `x${++n}`, now: 0, report: () => {} });
    expect(made.title).toBe('Relay helps agencies bill on time');
    expect(made.sections.map((one) => one.kind)).toEqual(['hero', 'problem', 'how', 'faq', 'cta']);
    expect(made.cut).toBe(1);
    expect(fakePlan('').title).toBe('Our product');
  });

  it('says a section in fewer words, and never leaves a sentence hanging', async () => {
    expect(clip('Relay helps small agencies bill on time', 6)).toBe('Relay helps small agencies bill');
    const hero = at('hero', 'Relay helps small agencies bill on time', ['One calm place for the work that keeps slipping, so the week runs itself.'], { button: 'Join' });
    const short = shorter(hero);
    expect(short.headline.split(' ').length).toBeLessThan(hero.headline.split(' ').length);
    expect(short.lines[0].split(' ').length).toBeLessThan(hero.lines[0].split(' ').length);
    expect((await rewriteSection(hero, 'shorter hero', { material, now: 0 })).done).toBe(true);
    expect((await rewriteSection(hero, 'hero: speak to buyers', { material, now: 0 })).done).toBe(false);
  });
});
