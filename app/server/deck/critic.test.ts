import { describe, expect, it } from 'vitest';
import type { Slide } from '../../shared/deck.ts';
import { faults, mend, moneyIn, normal, numbersIn, parseStoryboard, sourceOf, type Material } from './critic.ts';

const slide = (shape: Slide['shape'], headline: string, lines: string[] = [], extra: Partial<Slide> = {}): Slide => ({ id: `s-${shape}-${headline.length}`, shape, headline, lines, ...extra });
const bare: Material = { brief: 'A seed deck for Relay. We are raising $1.5M.', sources: [{ name: 'Brand doc', text: 'The market is 4,200 agencies in the UK.' }] };
const withMetrics: Material = { ...bare, metrics: { name: 'Metrics card', text: 'MRR 12,400 · 38% month on month · 212 customers' } };

describe('numbers', () => {
  it('finds claims and leaves years and small counts alone', () => {
    expect(numbersIn('Founded 2024 by 3 people; $1.5M raised, 38% growth, 4,200 agencies, 10x faster')).toEqual(['$1.5M', '38%', '4,200', '10x']);
    expect(normal('$1.5 million')).toBe('1.5m');
    expect(normal('4,200')).toBe('4200');
    expect(moneyIn('Raising $1.5M for 18 months')).toEqual(['$1.5M']);
  });
  it('says where a number came from, and only from the material', () => {
    expect(sourceOf('4200', bare)).toBe('Brand doc');
    expect(sourceOf('$1.5 million', bare)).toBe('your brief');
    expect(sourceOf('38%', withMetrics)).toBe('Metrics card');
    expect(sourceOf('99%', withMetrics)).toBeNull();
    expect(sourceOf('4,200', withMetrics, 'metrics')).toBeNull();
  });
});

describe('the critic', () => {
  it('passes a deck that keeps the rules', () => {
    const good = [slide('title', 'Relay'), slide('market', 'Every agency needs this', ['4,200 agencies in the UK']), slide('traction', 'Early days', ['No numbers yet.']), slide('ask', 'Raising $1.5M')];
    expect(faults(good, bare)).toEqual([]);
  });

  it('names every broken rule in words a model can act on', () => {
    const bad = [
      slide('problem', 'This headline is far too long for any slide at all', ['a', 'b', 'c', 'd', 'e']),
      slide('market', 'A huge market', ['900,000 buyers worldwide']),
      slide('traction', 'Growing fast', []),
      slide('ask', 'Raising $3M'),
    ];
    const found = faults(bad, bare).join('\n');
    expect(found).toContain('slide 1 (problem): the headline has 11 words');
    expect(found).toContain('at most 4 lines, not 5');
    expect(found).toContain('900,000 is not in the material');
    expect(found).toContain('the traction slide says "No numbers yet."');
    expect(found).toContain('the founder did not name $3M');
  });

  it('mends what the model left wrong and says so, keeping a passing slide exactly as it was', () => {
    const kept = slide('solution', 'One stage for the company', ['People and numbers together']);
    const { slides, said } = mend([
      kept,
      slide('market', 'A 900,000 buyer market worldwide', ['4,200 agencies in the UK', '900,000 buyers worldwide'], { figure: { value: '$40B', label: 'total market' } }),
      slide('traction', 'Growing fast', ['212 customers'], { figure: { value: '38%', label: 'month on month' } }),
      slide('ask', 'Raising $3M', ['18 months of runway']),
    ], bare);
    expect(slides[0]).toEqual(kept);
    expect(slides[1].headline).toBe('A buyer market worldwide');
    expect(slides[1].lines).toEqual(['4,200 agencies in the UK']);
    expect(slides[1].figure).toBeUndefined();
    expect(slides[1].source).toBe('Brand doc');
    expect(slides[1].notes).toContain('Needs a source: $40B total market');
    expect(slides[2].lines).toEqual(['No numbers yet.']);
    expect(slides[2].figure).toBeUndefined();
    expect(slides[3].headline).toBe('The ask');
    expect(slides[3].notes).toContain('Name an amount in the brief');
    expect(said.join('\n')).toContain('slide 3: no Metrics card is wired');
    expect(faults(slides, bare)).toEqual([]);
  });

  it('takes traction numbers from the Metrics card and nowhere else', () => {
    const { slides } = mend([slide('traction', 'Customers are staying', ['212 customers', '4,200 agencies'], { figure: { value: '38%', label: 'month on month' } })], withMetrics);
    expect(slides[0].lines).toEqual(['212 customers']);
    expect(slides[0].figure?.value).toBe('38%');
    expect(slides[0].source).toBe('Metrics card');
  });

  it('keeps one idea a slide and a headline under nine words', () => {
    const { slides, said } = mend([slide('list', 'one two three four five six seven eight nine ten', ['a', 'b', 'c', 'd', 'e', 'f'])], bare);
    expect(slides[0].headline).toBe('one two three four five six seven eight');
    expect(slides[0].lines).toEqual(['a', 'b', 'c', 'd']);
    expect(slides[0].notes).toContain('Cut for one idea a slide: e');
    expect(said).toContain('slide 1: kept 4 of 6 lines, one idea a slide');
  });
});

describe('a storyboard as a model wrote it', () => {
  it('is read into slides, or refused with the reason', () => {
    let next = 0;
    const ids = () => `s${++next}`;
    const made = parseStoryboard({ title: 'Relay', slides: [{ shape: 'title', headline: 'Relay', lines: ['x', 3] }, { shape: 'problem', headline: ' Too  much ' }, { shape: 'ask', headline: 'Join', figure: { value: '', label: '' } }] }, ids);
    expect(made.slides.map((one) => one.id)).toEqual(['s1', 's2', 's3']);
    expect(made.slides[0].lines).toEqual(['x']);
    expect(made.slides[1].headline).toBe('Too much');
    expect(made.slides[2].figure).toBeUndefined();
    expect(() => parseStoryboard({ slides: [{ shape: 'title', headline: 'a' }] }, ids)).toThrow('at least 3');
    expect(() => parseStoryboard({ slides: [{ shape: 'x', headline: 'a' }, {}, {}] }, ids)).toThrow('"shape" must be one of');
  });
});
