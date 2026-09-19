import { describe, expect, it } from 'vitest';
import { criticise, repair, type Want } from './critic.ts';
import type { Material } from './director.ts';
import { figureSaid, fillerIn, namesIn, ownWords, preciseFigures, saysIt, sentencesIn, sourcesOf, spellOut, unfill } from './grounding.ts';
import { LAYOUTS, type Layout, type Scene, type Spec } from './spec.ts';

// The launch film made from this repository said the product had live cursor tracking, zero email clutter and made
// a team ten times more productive. None of that is in the repository. Everything here is that failure, and the
// rules that stop it.

const repo: Material = {
  lines: [
    'What it says it is: the founder accelerator where your whole company is on one canvas.',
    'README of cubicle:\nRooms hold people. Wires carry context. A board holds the work and the founder runs it.\nEverything is made on this machine and nothing leaves it unless you wired it.',
  ],
  assets: [], using: ['cubicle project'], brand: { colours: ['#e8b04b'], name: 'cubicle' },
};
const bare: Material = { lines: [], assets: [], using: [] };
const want = (material: Material, brief: string, over: Partial<Want> = {}): Want => ({
  seconds: 30, pace: 'punchy', purpose: 'launch', captions: true, bible: 'studio photography',
  layouts: [...LAYOUTS] as Layout[], reel: false, product: material.lines.length > 0,
  sources: sourcesOf(material, brief), ...over,
});
const spec = (scenes: Scene[]): Spec => ({ title: 'One canvas', scenes });
const rules = (found: { rule: string }[]) => [...new Set(found.map((one) => one.rule))].sort();
const words = (one?: Scene) => [one?.heading, one?.text, ...(one?.bullets ?? []), one?.say].filter(Boolean).join(' ');

describe('what the material really says', () => {
  it('finds a quotation that is there and refuses one that is not', () => {
    const sources = sourcesOf(repo, 'a 30 second launch');
    expect(saysIt('Wires carry context', sources)).toBe(true);
    expect(saysIt('wires carry the context between rooms', sources)).toBe(true);
    expect(saysIt('live cursor tracking', sources)).toBe(false);
    expect(saysIt('zero email clutter', sources)).toBe(false);
    // Too short to be a quotation of anything.
    expect(saysIt('the', sources)).toBe(false);
  });

  it('reads a figure written either way round', () => {
    expect(spellOut(12)).toEqual(['twelve']);
    expect(spellOut(74)).toEqual(['seventy-four', 'seventy four']);
    const sources = sourcesOf({ ...bare, lines: ['Only twelve per cent of decks get a second meeting.'] }, '');
    expect(figureSaid('12%', sources)).toBe(true);
    expect(figureSaid('13%', sources)).toBe(false);
  });

  it('tells a measurement from a way of speaking', () => {
    expect(preciseFigures('10x more productive')).toEqual(['10x']);
    expect(preciseFigures('74% of founders')).toEqual(['74%']);
    expect(preciseFigures('$12k a month')).toEqual(['$12k']);
    expect(preciseFigures('1,200 teams')).toEqual(['1,200']);
    // Three steps and two founders are counts, and everybody may say one.
    expect(preciseFigures('three steps, two founders, one canvas')).toEqual([]);
  });

  it('knows the words that mean nothing, and takes them back out', () => {
    expect(fillerIn('Seamlessly unlock real-time synergy')).toEqual(['seamlessly', 'unlock', 'synergy']);
    expect(fillerIn('Your whole company on one canvas')).toEqual([]);
    expect(unfill('Seamlessly ship faster')).toBe('ship faster');
    expect(unfill('A robust, holistic platform')).toBe('A, platform'.replace('A,', 'A'));
  });

  it('spots a name the film has given something, and leaves a Title Case heading alone', () => {
    expect(namesIn('Meet TractionCheck today')).toEqual(['TractionCheck']);
    expect(namesIn('WireCanvas On Demand')).toEqual(['WireCanvas']);
    expect(namesIn('Investors want traction')).toEqual([]);
    // A model writes its headings in Title Case. Reading every capital as a name called "Instant" a company, took
    // it out of a real film's title, and told the founder their own heading did not exist.
    expect(namesIn('Instant Launch Film')).toEqual([]);
    expect(namesIn('Identify the Dynamics of Demand')).toEqual([]);
  });

  it('takes whole sentences out of a README, not the lines it happens to be wrapped on', () => {
    const said = sentencesIn('# What this is\nThe founder stays the\noperator: people speed the founder up, the founder decides.\n\n- A wire is access, and a person reads only what is wired to them\n- Short\nNothing runs while the app is closed.');
    // The sentence that was wrapped over two lines is one sentence again, and the heading above it is not part of it.
    expect(said).toContain('The founder stays the operator: people speed the founder up, the founder decides.');
    expect(said.some((one) => one === 'The founder stays the')).toBe(false);
    // A bullet is its own line, and a whole sentence comes before one that is not.
    expect(said).toContain('A wire is access, and a person reads only what is wired to them');
    expect(said.indexOf('Nothing runs while the app is closed.')).toBeLessThan(said.indexOf('A wire is access, and a person reads only what is wired to them'));
  });

  it('tells a line about the world from a line about this product', () => {
    const sources = sourcesOf(repo, 'a 30 second launch for cubicle');
    // Everyday English about how things generally are. The film may say this and has nothing to point at.
    expect(ownWords('A founder has to decide fast.', sources)).toEqual([]);
    expect(ownWords('Your whole company on one canvas', sources)).toEqual([]);
    // Its own vocabulary, which is a claim, and nothing in the material uses either word.
    expect(ownWords('Live cursor tracking', sources)).toEqual(['cursor', 'tracking']);
    expect(ownWords('Zero email clutter', sources)).toContain('clutter');
    // A word the founder themselves wrote in the brief is theirs, not the film's invention.
    expect(ownWords('Built for bootstrappers', sourcesOf(repo, 'a launch'))).toEqual(['bootstrappers']);
    expect(ownWords('Built for bootstrappers', sourcesOf(repo, 'a launch aimed at bootstrappers'))).toEqual([]);
  });
});

describe('a film that only says what is generally so', () => {
  it('lets a general line stand, even with a product wired to the card', () => {
    const general = spec([
      { layout: 'hook', text: 'Founders lose the room fast', say: 'Founders lose the room fast.' },
      { layout: 'statement', text: 'Rooms hold people', say: 'Rooms hold people.', source: 'Rooms hold people' },
      { layout: 'cta', text: 'Put it on one canvas', say: 'Put it on one canvas.' },
    ]);
    expect(rules(criticise(general, want(repo, 'a 30 second launch')))).not.toContain('invented');
  });
});

describe('a film that invents things about a product it was given', () => {
  // Scene for scene, what the launch film actually said.
  const invented = spec([
    { layout: 'hook', text: 'Your whole company on one canvas', say: 'Your whole company on one canvas.', source: 'the founder accelerator where your whole company is on one canvas' },
    { layout: 'checklist', heading: 'Real time team synergy', bullets: ['Live cursor tracking', 'Instant visual updates', 'Zero email clutter'], say: 'Live cursor tracking, instant visual updates, zero email clutter.' },
    { layout: 'stat', heading: '10x', text: 'faster than email', say: 'Teams move ten times faster.' },
    { layout: 'cta', text: 'Put your company on one canvas', say: 'Put your company on one canvas.', source: 'your whole company is on one canvas' },
  ]);

  it('names every invention and every empty word', () => {
    expect(rules(criticise(invented, want(repo, 'a 30 second launch for this repo')))).toEqual(expect.arrayContaining(['filler', 'invented']));
  });

  it('cuts what it cannot point at, keeps what it can, and says so', () => {
    const { spec: fixed, notes } = repair(invented, want(repo, 'a 30 second launch for this repo'));
    const all = fixed.scenes.map(words).join(' ').toLowerCase();
    for (const lie of ['cursor tracking', 'zero email clutter', 'instant visual updates', 'synergy', '10x']) expect(all).not.toContain(lie);
    // The two scenes that really came out of the material are untouched.
    expect(fixed.scenes[0].text).toBe('Your whole company on one canvas');
    expect(fixed.scenes.at(-1)!.text).toBe('Put your company on one canvas');
    expect(notes.join(' ')).toMatch(/could not be found in your material|replaced with your own words|taken out/);
    expect(rules(criticise(fixed, want(repo, 'a 30 second launch for this repo')))).not.toContain('invented');
    expect(rules(criticise(fixed, want(repo, 'a 30 second launch for this repo')))).not.toContain('filler');
  });

  it('puts the founder\'s own words in place of an invented line rather than leaving a hole', () => {
    const one = spec([
      { layout: 'statement', text: 'Live cursor tracking', say: 'It has live cursor tracking.' },
      { layout: 'statement', text: 'Wires carry context', say: 'Wires carry context.', source: 'Wires carry context' },
      { layout: 'cta', text: 'Try it', say: 'Try it.', source: 'the founder accelerator' },
    ]);
    const { spec: fixed } = repair(one, want(repo, 'a launch'));
    expect(fixed.scenes).toHaveLength(3);
    expect(words(fixed.scenes[0]).toLowerCase()).not.toContain('cursor');
    // What went in its place is a real sentence out of the material, word for word.
    expect(saysIt(fixed.scenes[0].say ?? '', sourcesOf(repo, ''))).toBe(true);
  });
});

describe('a film with nothing behind it at all', () => {
  const brief = '15 second clip of influencer talking abt what investors look for in a new company';
  const made = spec([
    { layout: 'hook', text: 'Investors ask one question', say: 'Investors ask one question.' },
    { layout: 'stat', heading: '22%', text: 'of pitches get funded', say: 'Only twenty-two per cent get funded.' },
    { layout: 'cta', text: 'Try TractionCheck today', say: 'Try TractionCheck today.' },
  ]);

  it('refuses a statistic nobody measured and a company nobody has', () => {
    const found = criticise(made, want(bare, brief, { reel: true, purpose: 'reel', product: false }));
    expect(rules(found)).toContain('invented');
    expect(found.filter((one) => one.rule === 'invented')).toHaveLength(2);
  });

  it('takes the number out and the invented company with it, and keeps the general truth', () => {
    const { spec: fixed, notes } = repair(made, want(bare, brief, { reel: true, purpose: 'reel', product: false }));
    const all = fixed.scenes.map(words).join(' ');
    expect(all).not.toContain('22%');
    expect(all).not.toContain('TractionCheck');
    expect(all).toContain('Investors ask one question');
    expect(notes.join(' ')).toContain('numbers');
    expect(notes.join(' ')).toContain('name');
    expect(rules(criticise(fixed, want(bare, brief, { reel: true, purpose: 'reel', product: false })))).not.toContain('invented');
  });

  it('leaves a general truth with a counting number alone, because that is how people talk', () => {
    const fine = spec([{ layout: 'statement', text: 'Three questions decide it', say: 'Three questions decide it.' }]);
    expect(rules(criticise(fine, want(bare, brief)))).not.toContain('invented');
  });
});
