import { describe, expect, it } from 'vitest';
import type { Slide } from '../../shared/deck.ts';
import { faults, inventedIn, mend, moneyIn, normal, numbersIn, parseStoryboard, sourceOf, type Material } from './critic.ts';

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

  // Journey 13: traction said "No numbers yet." while another slide listed the brief's numbers.
  it('fills a traction slide that says no numbers from the brief\'s Numbers, with the brief as its source', () => {
    const fromBrief: Material = { ...bare, metrics: { name: 'the Company brief', text: '- Paying offices: 3 (since September 2026)\n- MRR: €720\n- Cash: €12,000' } };
    const empty = [slide('traction', 'Early and honest about it', ['No numbers yet.'])];
    expect(faults(empty, fromBrief)).toEqual(['slide 1 (traction): the Company brief has numbers, so the traction slide states them rather than none']);
    const { slides, said } = mend(empty, fromBrief);
    expect(slides[0].lines).toEqual(['Paying offices: 3 (since September 2026)', 'MRR: €720', 'Cash: €12,000']);
    expect(slides[0].source).toBe('the Company brief');
    expect(said).toContain('slide 1: traction said no numbers, so it now reads them from the Company brief');
    expect(faults(slides, fromBrief)).toEqual([]);
    // A traction number the brief does not give is still taken out.
    expect(mend([slide('traction', 'Growing', ['MRR: €720', '40 offices waiting'])], fromBrief).slides[0].lines).toEqual(['MRR: €720']);
  });

  it('keeps one idea a slide and a headline under nine words', () => {
    const { slides, said } = mend([slide('list', 'one two three four five six seven eight nine ten', ['a', 'b', 'c', 'd', 'e', 'f'])], bare);
    expect(slides[0].headline).toBe('one two three four five six seven eight');
    expect(slides[0].lines).toEqual(['a', 'b', 'c', 'd']);
    expect(slides[0].notes).toContain('Cut for one idea a slide: e');
    expect(said).toContain('slide 1: kept 4 of 6 lines, one idea a slide');
  });
});

// Journey 14: slide 8 asked the brief's open question and its speaker notes answered it with a pilot nobody ran.
describe('claims on slides and in speaker notes', () => {
  const callback: Material = { brief: 'Callback texts a patient back when the practice misses a call. €49 a month per practice. Open question: will practices trust automatic texts?', sources: [] };
  const trust = slide('problem', 'Will practices trust automatic texts?', ['Staff stay in control of every text'], { notes: 'This is the question we hear most. Early pilot results suggest they do. Every text can be edited first.' });

  it('names an unbacked claim in the notes, a line or a headline, and a number in the notes nobody gave', () => {
    const found = faults([trust, slide('market', 'Users love it', ['Customers love the replies']), slide('solution', 'One text', [], { notes: 'Saves 14 hours a week.' })], callback).join('\n');
    expect(found).toContain('slide 1 (problem): the speaker notes say "Early pilot results suggest"');
    expect(found).toContain('slide 2 (market): "Users love" is not on record');
    expect(found).toContain('slide 2 (market): "Customers love" is not on record');
    expect(found).toContain('slide 3 (solution): the speaker notes give 14, which is not in the material');
  });

  it('mends by taking the claim out rather than shipping it, and keeps the rest of the notes', () => {
    const { slides, said } = mend([trust, slide('market', 'Every practice misses calls', ['Customers love the replies', 'Missed calls cost bookings'])], callback);
    expect(slides[0].notes).toBe('This is the question we hear most. Every text can be edited first.');
    expect(slides[0].notes).not.toMatch(/pilot/i);
    expect(slides[1].lines).toEqual(['Missed calls cost bookings']);
    expect(slides[1].notes).not.toMatch(/love/i);
    expect(said).toContain('slide 1: took a sentence nothing on record backs out of the speaker notes');
    expect(said).toContain('slide 2: dropped a line with a claim nothing on record backs');
    expect(faults(slides, callback)).toEqual([]);
    // Mended once, kept exactly as it is on the next mend.
    expect(mend(slides, callback).slides).toEqual(slides);
  });

  it('keeps a finding the material records', () => {
    const recorded: Material = { ...callback, sources: [{ name: 'Pilot notes', text: 'Dr. Weber said the pilot results show her staff trust the texts.' }] };
    expect(faults([trust], recorded)).toEqual([]);
    expect(mend([trust], recorded).slides[0]).toEqual(trust);
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

// Journey 15: the PrintNear deck's invented lines, against the brief the founder wrote.
describe('what a slide may not invent', () => {
  const brief = '# PrintNear\n\nA marketplace for renting out idle 3D printers to local makers.\n\n## Numbers\n- Price: €12 per print job\n- 9 printers listed\n- 4 print jobs done\n- 1 paying host\n- 60 makers contacted\n\n## Open questions\n- Will makers trust a stranger\'s printer?';
  const printNear: Material = { brief: 'Pre-seed deck for PrintNear', sources: [{ name: 'Company', text: brief }], metrics: { name: 'the Company brief', text: '- 9 printers listed\n- 4 print jobs done\n- 1 paying host\n- 60 makers contacted' } };
  it.each([
    ['thousands of printers sit unused nearby', 'thousands'],
    ['Trust built via local reviews and collection', 'reviews'],
    ['Solo founder with sales and product background', 'background'],
    ['No dominant local player exists yet', 'No dominant local player'],
    ['Four completed jobs prove makers will use local hosts.', 'prove'],
    ['3 printers already rented weekly', '3 printers'],
  ])('finds "%s"', (line, hit) => {
    expect(inventedIn(line, printNear)).toContain(hit);
  });
  it.each([
    'Rent out idle 3D printers to local makers',
    '9 printers listed, 4 print jobs done',
    '60 makers contacted',
    'Will makers trust a stranger\'s printer?',
    'We need to prove makers trust local hosts',
  ])('passes "%s"', (line) => {
    expect(inventedIn(line, printNear)).toEqual([]);
  });
  it('takes a background the Team section gives', () => {
    const withTeam: Material = { ...printNear, sources: [{ name: 'Company', text: `${brief}\n\n## Team\n- Lena: six years at Ultimaker, sales lead` }] };
    expect(inventedIn('Lena: ex-Ultimaker sales lead', withTeam)).toEqual([]);
    expect(inventedIn('Lena: former Google PhD', withTeam)).not.toEqual([]);
  });
  it('names each in the faults and the mend drops or cuts it', () => {
    const slides = [
      slide('problem', 'Idle printers everywhere', ['thousands of printers sit unused nearby', 'Makers wait days for a print']),
      slide('solution', 'Rent a printer next door', ['Trust built via local reviews and collection', 'Rent out idle 3D printers to local makers']),
      slide('team', 'The team', ['Solo founder with sales and product background']),
      slide('market', 'Open field', ['No dominant local player exists yet']),
      slide('traction', 'Early jobs', ['60 makers contacted, 9 printers listed'], { notes: 'Four completed jobs prove makers will use local hosts. Next: ten jobs.' }),
    ];
    const found = faults(slides, printNear).join('\n');
    for (const hit of ['"thousands"', '"reviews"', '"background"', '"No dominant local player"', '"prove"']) expect(found).toContain(hit);
    const { slides: mended } = mend(slides, printNear);
    const text = mended.map((one) => [one.headline, ...one.lines].join('\n')).join('\n');
    expect(text).not.toMatch(/thousands|reviews|background|dominant/);
    expect(text).toContain('Makers wait days for a print');
    expect(text).toContain('Rent out idle 3D printers to local makers');
    expect(text).toContain('60 makers contacted, 9 printers listed');
    expect(mended[4].notes).not.toMatch(/prove makers/);
    expect(mended[4].notes).toContain('Next: ten jobs.');
  });
});

// Journey 19: slide 4 was a "quote" whose words were a Metrics row, attributed to Tom Becker.
describe('a quote slide', () => {
  const tom: Material = {
    brief: 'A seed pitch for QuoteSnap. As the founder I say: plumbers should never write a quote at night again.',
    sources: [{ name: 'Tom Becker at Becker Sanitär (Leads card)', text: 'Two of my lads would use it too. Does it work with photos from my old Android phone?' }],
    metrics: { name: 'Metrics card', text: 'Paying plumbers: 14 on 2026-10-11' },
  };
  it('stands only on words on record, with who said them', () => {
    const real = slide('quote', '“Two of my lads would use it too.”', ['Tom Becker at Becker Sanitär']);
    const founder = slide('quote', 'Never write a quote at night again', ['The founder']);
    expect(faults([real, founder], tom)).toEqual([]);
    const metric = slide('quote', 'Paying plumbers: 14 on 2026-10-11', ['Tom Becker at Becker Sanitär']);
    const madeUp = slide('quote', 'QuoteSnap saves me every evening', ['Tom Becker at Becker Sanitär']);
    const wrongPerson = slide('quote', 'Two of my lads would use it too', ['Jana Wolf']);
    const nobody = slide('quote', 'Two of my lads would use it too', []);
    for (const one of [metric, madeUp, wrongPerson, nobody]) expect(faults([one], tom).join(' ')).toContain('is not a quote on record with who said it');
  });
  it('is dropped when there is no quote on record, and the card is told', () => {
    const title = slide('title', 'QuoteSnap');
    const metric = slide('quote', 'Paying plumbers: 14 on 2026-10-11', ['Tom Becker at Becker Sanitär']);
    const mended = mend([title, metric], tom);
    expect(mended.slides.map((one) => one.shape)).toEqual(['title']);
    expect(mended.said).toContain('slide 2: dropped a quote slide, since "Paying plumbers: 14 on 2026-10-11" is not a quote anyone on record said');
  });
});

// Journey 20: the traction rows read "Paying cafés: 9 on 2026-10-11" and the big figure beside them said 6.
describe('a traction figure and its rows', () => {
  const metrics: Material = { brief: 'FixSlot books repair slots.', sources: [], metrics: { name: 'Metrics card', text: '- Paying cafés: 9 on 2026-10-11 (from meeting notes)\n- Customer conversations: 1 on 2026-10-11' } };
  it('says the same reading in the figure, a line and the headline, and the critic names the gap', () => {
    const given = slide('traction', '6 paying cafés so far', ['Paying cafés: 6 on 2026-10-09', 'Customer conversations: 1 on 2026-10-11'], { figure: { value: '6', label: 'paying cafés' } });
    expect(faults([given], metrics).join('\n')).toContain('the figure says 6 paying cafés and Metrics card reads 9');
    const { slides, said } = mend([given], metrics);
    expect(slides[0].figure).toEqual({ value: '9', label: 'paying cafés' });
    expect(slides[0].lines[0]).toMatch(/^Paying cafés: 9 on /);
    expect(slides[0].headline).toBe('9 paying cafés so far');
    expect(said.join('\n')).toContain('the figure now reads 9 paying cafés');
    // A figure that already reads the rows is kept as it was.
    const right = slide('traction', 'Paying cafés so far', ['Paying cafés: 9 on 2026-10-11 (from meeting notes)', 'Customer conversations: 1 on 2026-10-11'], { figure: { value: '9', label: 'paying cafés' } });
    expect(mend([right], metrics).slides[0]).toEqual(right);
  });
});

// Journey 21: "Six cafés pay for FixSlot today" over rows of 8, and "Goal is 8" with the brief's goal of 12.
describe('a traction headline in words and the goal slide', () => {
  const material: Material = { brief: 'FixSlot books repair slots.\n\n## Goal\n\nGoal: 12 paying cafés by 30 November 2026.', sources: [], metrics: { name: 'Metrics card', text: '- Paying cafés: 8 on 2026-10-11 (from meeting notes)\n- Cafés contacted: 40 on 2026-10-10' } };
  it('says the rows\' count and the brief\'s goal, from the same source as the rows', () => {
    const traction = slide('traction', 'Six cafés pay for FixSlot today', ['Paying cafés: 8 on 2026-10-11', 'Cafés contacted: 40 on 2026-10-10'], { notes: 'We have six paying cafés today, from 40 cafés contacted.' });
    const goal = slide('list', 'Goal is 8 paying cafés', ['Goal of 8 by 30 November'], { figure: { value: '8', label: 'goal' } });
    const { slides, said } = mend([traction, goal], material);
    expect(slides[0].headline).toBe('8 cafés pay for FixSlot today');
    // The notes say 8 too, and are then held to the record as any notes are.
    expect(slides[0].notes ?? '').not.toMatch(/\bsix\b/i);
    expect(said.join('\n')).toContain('slide 1: the notes now say the count Metrics card reads');
    expect(slides[1].headline).toBe('Goal is 12 paying cafés');
    expect(slides[1].lines).toEqual(['Goal of 12 by 30 November']);
    expect(slides[1].figure).toEqual({ value: '12', label: 'goal' });
    expect(said.join('\n')).toContain('the goal figure now reads 12');
  });
});
