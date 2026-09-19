import { describe, expect, it } from 'vitest';
import { carriesVisual, criticise, echoes, figureIn, keywords, repair, trimTo, type Want } from './critic.ts';
import { countWords, LAYOUTS, saidWords, type Layout, type Scene, type Spec } from './spec.ts';

// Every rule here is written the same way round: a lazy storyboard of the kind a free model really hands back goes
// in, and what comes out is a film. The founder's own run is the case they all descend from — three identical
// scenes, the whole of the narration set on screen, eighteen and a half seconds where fifteen were asked for.

const reelWant = (over: Partial<Want> = {}): Want => ({
  seconds: 15, pace: 'punchy', purpose: 'reel', captions: true,
  bible: 'high-contrast editorial photography, deep shadows', layouts: [...LAYOUTS] as Layout[], reel: true, ...over,
});
const spec = (scenes: Scene[], title = 'What investors look for'): Spec => ({ title, scenes });
const rules = (found: { rule: string }[]) => [...new Set(found.map((one) => one.rule))].sort();

describe('reading a line of writing', () => {
  it('knows when one line is another line said twice', () => {
    expect(echoes('Investors look for traction', 'Investors look for traction above all else.')).toBe(1);
    expect(echoes('Traction beats vision', 'Investors want to see real usage.')).toBeLessThan(0.4);
    expect(echoes('', 'anything')).toBe(0);
  });

  it('cuts a sentence to a headline at a clause rather than mid-thought', () => {
    expect(trimTo('Investors look for traction, not a beautiful deck', 7)).toBe('Investors look for traction');
    expect(trimTo('Short enough', 7)).toBe('Short enough');
    expect(countWords(trimTo('one two three four five six seven eight nine ten', 4))).toBe(4);
  });

  it('finds the number a scene is really about, and the words worth showing', () => {
    expect(figureIn('about 74% of decks')).toBe('74%');
    expect(figureIn('$12k a month')).toBe('$12k');
    expect(figureIn('no numbers here')).toBeNull();
    expect(keywords('So the thing is, investors really want traction', 3)).toBe('thing investors want');
  });

  it('counts a drawn background as something to look at, because it is', () => {
    expect(carriesVisual({ layout: 'statement', text: 'x' })).toBe(false);
    expect(carriesVisual({ layout: 'statement', text: 'x', bg_prompt: 'a desk' })).toBe(true);
    expect(carriesVisual({ layout: 'picture', image_prompt: 'a desk' })).toBe(true);
  });
});

describe('the critic', () => {
  // This is, scene for scene, the shape of what the founder was actually handed.
  const lazy = spec([
    { layout: 'statement', text: 'Investors look at whether there is a real problem being solved and whether the team can ship.', say: 'Investors look at whether there is a real problem being solved and whether the team can ship.' },
    { layout: 'statement', text: 'They also want to see traction, which means real people using the thing every single week.', say: 'They also want to see traction, which means real people using the thing every single week.' },
    { layout: 'statement', text: 'And finally they look at the market, the timing and whether you are the person to do it.', say: 'And finally they look at the market, the timing and whether you are the person to do it.' },
  ]);

  it('reads the founder\'s own failure and names every one of its faults', () => {
    expect(rules(criticise(lazy, reelWant()))).toEqual(['close', 'echo', 'headline', 'length', 'open', 'pace', 'shape', 'visuals']);
  });

  it('mends it into a film, and then has nothing left to say', () => {
    const { spec: fixed, notes } = repair(lazy, reelWant());
    expect(criticise(fixed, reelWant())).toEqual([]);
    expect(notes.length).toBeGreaterThan(2);
    // A reel opens on a hook and closes on a call to action.
    expect(fixed.scenes[0].layout).toBe('hook');
    expect(fixed.scenes.at(-1)!.layout).toBe('cta');
    // Three scenes is under the four the variety rule bites at, but none of them is the same shape twice.
    expect(new Set(fixed.scenes.map((one) => one.layout)).size).toBe(fixed.scenes.length);
    // Nothing on screen is the sentence being said under it.
    for (const scene of fixed.scenes) {
      const mayRepeat = ['hook', 'cta', 'logo', 'title', 'stat', 'quote'].includes(scene.layout);
      if (scene.text && scene.say && !mayRepeat) expect(echoes(scene.text, scene.say)).toBeLessThan(0.6);
      expect(countWords(scene.text)).toBeLessThanOrEqual(12);
      expect(countWords(scene.heading)).toBeLessThanOrEqual(7);
    }
    // Every scene has something to look at.
    expect(fixed.scenes.every(carriesVisual)).toBe(true);
    // And it is fifteen seconds of narration, not thirty.
    expect(saidWords(fixed)).toBeLessThanOrEqual(Math.round(15 * 2.4));
  });
});

describe('one rule at a time', () => {
  it('headline: a paragraph on screen becomes a headline', () => {
    const wordy = spec([{ layout: 'statement', heading: 'Here is the one thing that really matters most of all', text: 'Investors care far more about whether real people are using the product every single week than they do about the deck', bg_prompt: 'x' }]);
    expect(rules(criticise(wordy, reelWant({ captions: false, reel: false })))).toContain('headline');
    const { spec: fixed } = repair(wordy, reelWant({ captions: false, reel: false }));
    expect(countWords(fixed.scenes[0].heading)).toBeLessThanOrEqual(7);
    expect(countWords(fixed.scenes[0].text)).toBeLessThanOrEqual(12);
  });

  it('echo: a captioned scene that writes out its own narration shows a picture instead', () => {
    const twice = spec([{ layout: 'statement', text: 'Traction beats a beautiful deck', say: 'Traction beats a beautiful deck.', bg_prompt: 'x' }]);
    expect(rules(criticise(twice, reelWant({ reel: false })))).toContain('echo');
    const { spec: fixed } = repair(twice, reelWant({ reel: false }));
    expect(fixed.scenes[0].layout).toBe('picture');
    expect(fixed.scenes[0].text).toBeUndefined();
    expect(fixed.scenes[0].image_prompt).toContain('high-contrast editorial photography');
    // With no captions under it, the same scene keeps its words: there is nothing else saying them.
    const { spec: kept } = repair(twice, reelWant({ reel: false, captions: false }));
    expect(kept.scenes[0].text).toBe('Traction beats a beautiful deck');
  });

  it('echo: a hook is allowed to be the line it says, because that is what a hook is', () => {
    const hook = spec([{ layout: 'hook', text: 'Your deck is the problem', say: 'Your deck is the problem.', bg_prompt: 'x' }]);
    expect(rules(criticise(hook, reelWant({ reel: false })))).not.toContain('echo');
  });

  it('open and close: a reel gets a hook at the front and a call to action at the back', () => {
    const flat = spec([
      { layout: 'title', heading: 'Investor advice', text: 'What they look for', bg_prompt: 'x' },
      { layout: 'picture', image_prompt: 'a desk', say: 'They want usage.' },
      { layout: 'statement', text: 'Build the thing', say: 'So build it.', bg_prompt: 'x' },
    ]);
    expect(rules(criticise(flat, reelWant()))).toEqual(expect.arrayContaining(['open', 'close']));
    const { spec: fixed } = repair(flat, reelWant());
    expect(fixed.scenes[0].layout).toBe('hook');
    expect(fixed.scenes.at(-1)!.layout).toBe('cta');
    // An explainer is not held to it: it may open on a title and close on a logo.
    expect(rules(criticise(flat, reelWant({ reel: false, purpose: 'explainer' })))).not.toContain('open');
  });

  it('variety: four layouts at the least in anything over ten seconds', () => {
    const same = spec([
      { layout: 'statement', text: 'Traction is the whole game', bg_prompt: 'x', say: 'Traction is the whole game.' },
      { layout: 'statement', text: 'Only 12% get a second meeting', bg_prompt: 'x', say: 'Only 12% get a second meeting.' },
      { layout: 'statement', text: 'A problem, a team, some pull', bg_prompt: 'x', say: 'A problem, a team, some pull.' },
      { layout: 'statement', text: 'They hear a vision but they fund a product', bg_prompt: 'x', say: 'They hear a vision but they fund a product.' },
      { layout: 'statement', text: 'That is the meeting', bg_prompt: 'x', say: 'That is the meeting.' },
    ]);
    expect(rules(criticise(same, reelWant({ seconds: 30, reel: false })))).toContain('variety');
    const { spec: fixed } = repair(same, reelWant({ seconds: 30, reel: false }));
    expect(new Set(fixed.scenes.map((one) => one.layout)).size).toBeGreaterThanOrEqual(4);
    // Words that carry no shape of their own cannot make four, but they never stay five of the same either.
    const bland = spec(Array.from({ length: 5 }, (_, at) => ({ layout: 'statement' as const, text: `Point ${at}`, bg_prompt: 'x', say: `A word about number ${at}.` })));
    expect(new Set(repair(bland, reelWant({ seconds: 30, reel: false })).spec.scenes.map((one) => one.layout)).size).toBeGreaterThanOrEqual(2);
    // A film of eight seconds is allowed to be one idea.
    expect(rules(criticise(same, reelWant({ seconds: 8, reel: false })))).not.toContain('variety');
  });

  it('pace: no scene holds longer than a breath', () => {
    const long = spec([
      { layout: 'statement', text: 'One thing', bg_prompt: 'x', say: 'Investors look for a real problem worth solving. They look for a team that can ship it. They look for people already using the thing.' },
      { layout: 'picture', image_prompt: 'a desk', say: 'That is it.' },
    ]);
    expect(rules(criticise(long, reelWant({ reel: false })))).toContain('pace');
    const { spec: fixed } = repair(long, reelWant({ reel: false }));
    for (const scene of fixed.scenes) expect(countWords(scene.say) / 2.4).toBeLessThanOrEqual(4.01);
  });

  it('visuals: a scene with nothing to look at is given a picture out of the film\'s own style bible', () => {
    const bare = spec([{ layout: 'statement', text: 'Ship it', say: 'Ship it.' }, { layout: 'statement', text: 'Then ship again', say: 'Then again.' }]);
    expect(rules(criticise(bare, reelWant({ reel: false })))).toContain('visuals');
    const { spec: fixed } = repair(bare, reelWant({ reel: false }));
    for (const scene of fixed.scenes) expect(scene.bg_prompt ?? scene.image_prompt).toContain('high-contrast editorial photography');
  });

  it('shape: a number is a figure, a list is a list, a before and an after are two cards', () => {
    const number = spec([{ layout: 'statement', text: 'About 74% never get a second meeting', bg_prompt: 'x', say: 'About 74% never get a second meeting.' }]);
    expect(rules(criticise(number, reelWant({ reel: false, captions: false })))).toContain('shape');
    expect(repair(number, reelWant({ reel: false, captions: false })).spec.scenes[0]).toMatchObject({ layout: 'stat', heading: '74%' });

    const list = spec([{ layout: 'statement', text: 'A problem, a team, some early pull', bg_prompt: 'x', say: 'A problem, a team, some early pull.' }]);
    const listed = repair(list, reelWant({ reel: false, captions: false })).spec.scenes[0];
    expect(listed.layout).toBe('checklist');
    expect(listed.bullets).toHaveLength(3);

    const turn = spec([{ layout: 'statement', text: 'They hear a big idea but they fund a working thing', bg_prompt: 'x', say: 'They hear a big idea but they fund a working thing.' }]);
    const turned = repair(turn, reelWant({ reel: false, captions: false })).spec.scenes[0];
    expect(turned.layout).toBe('compare');
    expect(turned.bullets).toHaveLength(2);
  });

  it('length: the narration is cut to what fifteen seconds really holds, not what thirty does', () => {
    const over = spec(Array.from({ length: 5 }, () => ({ layout: 'picture' as const, image_prompt: 'a desk', say: 'Investors look for a real problem and a team that can ship it fast.' })));
    expect(rules(criticise(over, reelWant({ reel: false })))).toContain('length');
    const { spec: fixed } = repair(over, reelWant({ reel: false }));
    expect(saidWords(fixed)).toBeLessThanOrEqual(Math.round(15 * 2.4));
    expect(saidWords(fixed)).toBeGreaterThan(10);
  });

  it('never invents a layout the film could not fill', () => {
    const narrow = reelWant({ layouts: ['statement', 'picture', 'hook', 'cta'] });
    const number = spec([{ layout: 'statement', text: 'About 74% fail', bg_prompt: 'x', say: 'About 74% fail.' }, { layout: 'picture', image_prompt: 'a desk', say: 'That is the number.' }]);
    const { spec: fixed } = repair(number, narrow);
    for (const scene of fixed.scenes) expect(narrow.layouts).toContain(scene.layout);
  });

  it('leaves a storyboard that is already good exactly as it is', () => {
    const good = spec([
      { layout: 'hook', text: 'Your deck is the problem', say: 'Your deck is the problem.', bg_prompt: 'a founder at a desk' },
      { layout: 'stat', heading: '74%', text: 'never get a second meeting', bg_prompt: 'an empty meeting room', say: 'Most never get a second meeting.' },
      { layout: 'checklist', heading: 'What they check', bullets: ['A real problem', 'A team that ships'], bg_prompt: 'a whiteboard', say: 'A real problem and a team that ships.' },
      { layout: 'cta', text: 'Follow for more', heading: '@founder', bg_prompt: 'a phone in a hand', say: 'Follow for more.' },
    ]);
    expect(criticise(good, reelWant())).toEqual([]);
    const { spec: fixed, notes } = repair(good, reelWant());
    expect(notes).toEqual([]);
    expect(fixed.scenes.map((one) => one.layout)).toEqual(['hook', 'stat', 'checklist', 'cta']);
    expect(fixed.scenes[0].text).toBe('Your deck is the problem');
  });
});
