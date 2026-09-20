import { describe, expect, it } from 'vitest';
import { carriesVisual, criticise, opensADoor, plainClose, echoes, figureIn, headlineOf, inStyle, keywords, offStyle, repair, shorten, trimTo, worthAStat, type Want } from './critic.ts';
import { countWords, LAYOUTS, saidWords, saysWhatItShows, type Layout, type Scene, type Spec } from './spec.ts';

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
      // A scene that shows the line it says loses its captions when it is rendered, so it may show it — as a
      // headline. A sentence of it set in type is the narration written out, and that is still a transcript.
      if (scene.text && scene.say && !mayRepeat && echoes(scene.say, scene.text) >= 0.6) expect(countWords(scene.text)).toBeLessThanOrEqual(7);
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

  it('echo: a captioned scene that writes out its own narration is cut to the words it turns on', () => {
    const twice = spec([{ layout: 'statement', text: 'Traction beats a beautiful deck every single time', say: 'Traction beats a beautiful deck every single time.', bg_prompt: 'x' }]);
    expect(rules(criticise(twice, reelWant({ reel: false })))).toContain('echo');
    const { spec: fixed } = repair(twice, reelWant({ reel: false }));
    expect(countWords(fixed.scenes[0].text)).toBeLessThanOrEqual(7);
    expect(rules(criticise(fixed, reelWant({ reel: false })))).not.toContain('echo');
    // A line that will not make even a handful of words gives up its words altogether and shows a picture.
    const bare = spec([{ layout: 'statement', text: 'It is what it is and so on it goes', say: 'It is what it is and so on it goes.', bg_prompt: 'x' }]);
    expect(repair(bare, reelWant({ reel: false })).spec.scenes[0].layout).toBe('picture');
    // Three words of the line said over it is emphasis, not a transcript, and it is left alone.
    const kicker = spec([{ layout: 'statement', text: 'Traction wins', say: 'Traction beats a beautiful deck every single time.', bg_prompt: 'x' }]);
    expect(rules(criticise(kicker, reelWant({ reel: false })))).not.toContain('echo');
    // With no captions under it, the same scene keeps its whole line: there is nothing else saying them.
    const { spec: kept } = repair(twice, reelWant({ reel: false, captions: false }));
    expect(kept.scenes[0].text).toBe('Traction beats a beautiful deck every single time');
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

describe('a headline is a line of English', () => {
  it('keeps the small words a telegram would drop', () => {
    // The real run set "INVESTORS ASK BRUTAL QUESTION" across a frame. That is a sentence with its grammar removed.
    expect(headlineOf('Investors ask a brutal question first', 5)).toBe('Investors ask a brutal question first');
    expect(headlineOf('Wires carry context between rooms', 6)).toBe('Wires carry context between rooms');
    // A question mark is the headline; a full stop belongs to the sentence it came from.
    expect(headlineOf('Want investors to chase you?', 5)).toBe('Want investors to chase you?');
    expect(headlineOf('Wires carry context.', 5)).toBe('Wires carry context');
  });

  it('never stops between "a" and the thing it was about to name', () => {
    // A real reel set "I SOLVE A SINGLE" across a frame, which is the first half of a headline.
    expect(headlineOf('I solve a single, painful problem.', 5)).toBe('I solve a single, painful problem');
    expect(headlineOf('Traction beats a beautiful deck every single time.', 5)).toBe('Traction beats a beautiful deck');
  });

  it('drops the throat-clearing at the front and gives up where there is no headline to be had', () => {
    expect(headlineOf('So here is the thing: investors want traction', 5)).not.toMatch(/^So /);
    // Nothing in this line carries anything, so it has no headline and the scene shows a picture instead.
    expect(headlineOf('It is what it is and so on it goes', 4)).toBe('');
  });
});

describe('the words on screen and the words underneath', () => {
  it('turns the captions off for a scene whose own words are the line being said', () => {
    // A hook is the spoken line set large. Captioned as well, it is the same sentence twice on one frame.
    expect(saysWhatItShows({ layout: 'hook', text: 'Your whole company on one canvas', say: 'Your whole company on one canvas.' })).toBe(true);
    expect(saysWhatItShows({ layout: 'cta', text: 'Follow for more', say: 'Follow for more.' })).toBe(true);
  });

  it('keeps them where the screen shows a few words of a longer line', () => {
    expect(saysWhatItShows({ layout: 'statement', text: 'Investors ask a brutal question', say: 'Investors ask a brutal question first, and most founders get that answer wrong.' })).toBe(false);
    expect(saysWhatItShows({ layout: 'picture', say: 'Nothing is written on this one at all.' })).toBe(false);
  });
});

describe('a film about a product that has pictures of itself', () => {
  const screens = ['screen-repo-1', 'screen-repo-2'];
  const drawn = spec([
    { layout: 'hook', text: 'Your whole company on one canvas', say: 'Your whole company on one canvas.', bg_prompt: 'a desk' },
    { layout: 'statement', text: 'Rooms hold people', say: 'Rooms hold people.', bg_prompt: 'a room' },
    { layout: 'picture', image_prompt: 'a canvas of cards', say: 'Wires carry the context.' },
    { layout: 'cta', text: 'Put it on one canvas', say: 'Put it on one canvas.', bg_prompt: 'a laptop' },
  ]);

  it('says so when every scene is a drawing and the real screens are on the card', () => {
    expect(rules(criticise(drawn, reelWant({ screens })))).toContain('screens');
    expect(rules(criticise(drawn, reelWant()))).not.toContain('screens');
  });

  it('gives one scene a real screenshot to hold', () => {
    const { spec: fixed, notes } = repair(drawn, reelWant({ screens }));
    const shown = fixed.scenes.find((one) => one.layout === 'device');
    expect(shown?.asset).toBe('screen-repo-1');
    expect(notes.join(' ')).toContain('real pictures of the product');
    expect(rules(criticise(fixed, reelWant({ screens })))).not.toContain('screens');
  });

  it('leaves a film that already shows the product alone', () => {
    const already = spec([...drawn.scenes.slice(0, 2), { layout: 'device', asset: 'screen-repo-1', frame: 'browser', say: 'This is the stage.' }, drawn.scenes[3]]);
    expect(rules(criticise(already, reelWant({ screens })))).not.toContain('screens');
  });
});

describe('a line said aloud, made shorter', () => {
  it('cuts at a full stop, then at a clause, and never in the middle of a thought', () => {
    // The real film said "I'm a founder, I feel." because the fit was done with a headline's scissors.
    expect(shorten("I'm a founder, I feel the weight of every decision.", 6)).toBe("I'm a founder.");
    expect(shorten('A canvas where a founder works with a small workforce of people, each in their own room.', 9))
      .toBe('A canvas where a founder works with a small workforce of people.');
    // Two sentences: the second one goes whole before the first is touched.
    expect(shorten('Investors want traction. They fund what already works.', 4)).toBe('Investors want traction.');
  });

  it('stops on a word that carries something when there is no clause to stop at', () => {
    const cut = shorten('Investors look for a real problem and a team that can ship it fast.', 11);
    expect(cut).toBe('Investors look for a real problem.');
    // A line that cannot be cut without breaking stays as long as it is: a film a second over beats one that
    // stops mid-breath.
    expect(shorten('Investors fund traction.', 2)).toBe('Investors fund traction.');
  });
});

describe('a headline is a whole thought or it is nothing', () => {
  it('stops where the writer stopped, at the clause the line opens on', () => {
    // A real launch film set "The founder stays" across a frame: a subject, its verb, and nothing they did.
    expect(headlineOf('The founder stays the operator: people speed the founder up, the founder decides.', 5))
      .toBe('The founder stays the operator');
    expect(headlineOf('Everything is made on this machine and nothing leaves it unless you wired it.', 6))
      .toBe('Everything is made on this machine');
    // The opening clause, never a better-fitting one out of the middle, which loses whoever it was about.
    expect(headlineOf('Rooms hold people, wires carry context, and a board holds the work.', 5)).toBe('Rooms hold people');
  });

  it('writes nothing rather than half a thought', () => {
    // Two things said is a beginning; the scene is better off with the captions carrying the line.
    expect(headlineOf('It is what it is and so on it goes', 4)).toBe('');
  });
});

describe('a number worth the size of the frame', () => {
  it('knows a number a viewer gets from one that counts the product\'s own parts', () => {
    expect(worthAStat('74%', 'never get a second meeting')).toBe(true);
    expect(worthAStat('3', 'hours a week saved')).toBe(true);
    expect(worthAStat('$12k', 'a month')).toBe(true);
    // A real launch film set "17 — Shapes scene elements used" forty points high.
    expect(worthAStat('17', 'Shapes scene elements used')).toBe(false);
    expect(worthAStat('28', 'voices to choose from')).toBe(false);
  });

  it('says an inventory rather than setting it the size of the frame', () => {
    const inventory = spec([{ layout: 'stat', heading: '17', text: 'scene shapes', say: 'There are seventeen scene shapes.', bg_prompt: 'x' }]);
    expect(rules(criticise(inventory, reelWant({ reel: false })))).toContain('stat');
    const { spec: fixed, notes } = repair(inventory, reelWant({ reel: false }));
    expect(fixed.scenes[0].layout).not.toBe('stat');
    expect(notes.join(' ')).toContain("counts this product's own parts");
    expect(rules(criticise(fixed, reelWant({ reel: false })))).not.toContain('stat');
  });
});

describe('what a founder types and what a stranger reads', () => {
  it('takes a file path off the screen and leaves the line being said', () => {
    const typed = spec([{ layout: 'statement', text: 'workspace/files/media/', say: 'Everything you make lands in one folder.', bg_prompt: 'x' }]);
    expect(rules(criticise(typed, reelWant({ reel: false })))).toContain('headline');
    const { spec: fixed } = repair(typed, reelWant({ reel: false }));
    expect(fixed.scenes[0].text ?? '').not.toContain('/');
    expect(rules(criticise(fixed, reelWant({ reel: false })))).not.toContain('headline');
  });
});

describe('a film that was handed a picture', () => {
  const given = ['drawn-1'];
  const drawings = spec([
    { layout: 'hook', text: 'Investors want traction', say: 'Investors want traction.', bg_prompt: 'a desk' },
    { layout: 'statement', text: 'Show real usage', say: 'Show real usage.', bg_prompt: 'a laptop' },
    { layout: 'cta', text: 'Follow for more', say: 'Follow for more.', bg_prompt: 'a phone' },
  ]);

  it('says so when the picture is nowhere in it', () => {
    expect(rules(criticise(drawings, reelWant({ pictures: given })))).toContain('pictures');
    expect(rules(criticise(drawings, reelWant()))).not.toContain('pictures');
  });

  it('gives a scene the real picture rather than a drawing of something like it', () => {
    const { spec: fixed, notes } = repair(drawings, reelWant({ pictures: given }));
    expect(fixed.scenes.some((one) => one.asset === 'drawn-1' && one.layout === 'picture')).toBe(true);
    expect(notes.join(' ')).toContain('a picture you were given is in the film');
    expect(rules(criticise(fixed, reelWant({ pictures: given })))).not.toContain('pictures');
  });

  it('leaves a film that already shows it alone', () => {
    const already = spec([drawings.scenes[0], { layout: 'picture', asset: 'drawn-1', say: 'Here they are.' }, drawings.scenes[2]]);
    expect(rules(criticise(already, reelWant({ pictures: given })))).not.toContain('pictures');
  });
});

describe('a film that was asked for somebody on camera', () => {
  const still = spec([
    { layout: 'hook', text: 'Investors want traction', say: 'Investors want traction.', bg_prompt: 'a desk' },
    { layout: 'picture', asset: 'drawn-1', say: 'They watch what people do.' },
    { layout: 'cta', text: 'Follow for more', say: 'Follow for more.', bg_prompt: 'a phone' },
  ]);

  it('says so when nobody in it is moving and somebody could be', () => {
    // The founder's words were "it is a static image, no talking, no body and hand movement".
    expect(rules(criticise(still, reelWant({ person: true })))).toContain('person');
    // Where no moving shot can be made at all, a still is the honest best and this does not bite.
    expect(rules(criticise(still, reelWant({ person: true, layouts: ['hook', 'picture', 'cta', 'statement'] })))).not.toContain('person');
    expect(rules(criticise(still, reelWant()))).not.toContain('person');
  });

  it('makes one scene a person rather than a picture of one', () => {
    const { spec: fixed, notes } = repair(still, reelWant({ person: true }));
    expect(fixed.scenes.some((one) => one.layout === 'presenter' || one.layout === 'clip')).toBe(true);
    expect(notes.join(' ')).toContain('somebody on camera');
    expect(rules(criticise(fixed, reelWant({ person: true })))).not.toContain('person');
  });

  it('leaves a film that already has somebody moving alone', () => {
    const already = spec([still.scenes[0], { layout: 'presenter', portrait_prompt: 'a founder', say: 'They watch.' }, still.scenes[2]]);
    expect(rules(criticise(already, reelWant({ person: true })))).not.toContain('person');
  });
});

describe('one film, one look', () => {
  // The two kinds of film there are. The first is what five of the six packs are shot in; the second is the
  // notebook, which is drawn by hand on purpose.
  const photo = 'high-contrast editorial photography, deep shadows, one saturated accent light';
  const drawn = 'loose ink and watercolour illustration on warm paper, visible pencil under-drawing';
  const lookWant = (bible: string) => reelWant({ bible });

  it('names the word a scene used to ask for a look the film is not shot in', () => {
    // This is the real fault, word for word: one scene of a fifteen-second reel came back a 3-D cartoon character
    // standing beside four photographs, and the film had no single look.
    expect(offStyle('a 3d render of a founder at a desk', photo)).toBe('3d render');
    expect(offStyle('a 3-D rendered founder', photo)).toBe('3-D rendered');
    expect(offStyle('a cartoon founder waving', photo)).toBe('cartoon');
    expect(offStyle('an illustrated skyline, flat design', photo)).toBe('illustrated');
    expect(offStyle('a watercolor desk', photo)).toBe('watercolor');
    expect(offStyle('anime characters in an office', photo)).toBe('anime');
    // And says nothing about a picture that is already the film.
    expect(offStyle('a founder at a desk, deep shadows, shallow depth of field', photo)).toBeNull();
  });

  it('leaves alone the ordinary words that only look like a style', () => {
    // A founder drawing on experience is a person doing something, and rendering is what this tool does to every
    // film it makes. Either one read as a style would rewrite a scene that was never wrong.
    expect(offStyle('a founder drawing on years of experience', photo)).toBeNull();
    expect(offStyle('a laptop finishing the rendering of a film', photo)).toBeNull();
    expect(offStyle('a founder drawing up a list at a desk', photo)).toBeNull();
    // The noun itself is still the noun.
    expect(offStyle('a pencil drawing of a desk', photo)).toBe('drawing');
    expect(offStyle('a render of a phone', photo)).toBe('render');
  });

  it('allows every drawn word in a film whose own look is drawn', () => {
    for (const asked of ['a cartoon founder', 'a watercolour desk', 'a 3d render of a phone', 'a loose pencil drawing']) {
      expect(offStyle(asked, drawn)).toBeNull();
    }
  });

  it('shoots a stray prompt the way the rest of the film is shot, and changes nothing else about it', () => {
    expect(inStyle('a 3d render of a founder at a desk', photo)).toBe('a photograph of a founder at a desk');
    // "a photograph founder" is not English, so the word beside a subject is the one that describes it.
    expect(inStyle('a cartoon founder at a desk', photo)).toBe('a photographed founder at a desk');
    expect(inStyle('a cartoon illustration of a phone', photo)).toBe('a photograph of a phone');
    expect(inStyle('a founder at a desk', photo)).toBe('a founder at a desk');
    expect(inStyle('a cartoon founder', drawn)).toBe('a cartoon founder');
  });

  it('criticises the scene that wandered off, names it, and puts it back in the film', () => {
    const mixed = spec([
      { layout: 'hook', text: 'Investors want traction', say: 'Investors want traction.', bg_prompt: `${photo}. a founder at a desk` },
      { layout: 'statement', text: 'Show real usage', say: 'Show real usage.', bg_prompt: `${photo}. a 3d render of a founder` },
      { layout: 'cta', text: 'Follow for more', say: 'Follow for more.', bg_prompt: `${photo}. a phone in a hand` },
    ]);
    const found = criticise(mixed, lookWant(photo));
    expect(rules(found)).toContain('style');
    expect(found.find((one) => one.rule === 'style')).toMatchObject({ scene: 2 });
    const { spec: fixed, notes } = repair(mixed, lookWant(photo));
    expect(fixed.scenes[1].bg_prompt).not.toMatch(/3d render/i);
    expect(fixed.scenes[1].bg_prompt).toContain('a photograph of a founder');
    expect(notes.join(' ')).toContain('shot the way the rest of the film is');
    expect(rules(criticise(fixed, lookWant(photo)))).not.toContain('style');
    // The scenes that were already the film are untouched, so a good storyboard is not rewritten around one bad one.
    expect(fixed.scenes[0].bg_prompt).toBe(mixed.scenes[0].bg_prompt);
  });

  it('does the same for the picture scenes, which is the other field a model writes a look into', () => {
    const drawnScene = spec([
      { layout: 'hook', text: 'Investors want traction', say: 'Investors want traction.', bg_prompt: `${photo}. a founder at a desk` },
      { layout: 'picture', image_prompt: `${photo}. a cartoon founder waving`, say: 'They watch what people do.' },
      { layout: 'cta', text: 'Follow for more', say: 'Follow for more.', bg_prompt: `${photo}. a phone in a hand` },
    ]);
    expect(rules(criticise(drawnScene, lookWant(photo)))).toContain('style');
    const { spec: fixed } = repair(drawnScene, lookWant(photo));
    expect(fixed.scenes[1].image_prompt).not.toMatch(/cartoon/i);
    expect(fixed.scenes[1].image_prompt).toContain('a photographed founder waving');
  });

  it('keeps a hand-drawn film hand-drawn, because there the drawn words are the look', () => {
    const notebook = spec([
      { layout: 'hook', text: 'Investors want traction', say: 'Investors want traction.', bg_prompt: `${drawn}. a founder at a desk` },
      { layout: 'statement', text: 'Show real usage', say: 'Show real usage.', bg_prompt: `${drawn}. a loose ink drawing of a laptop` },
      { layout: 'cta', text: 'Follow for more', say: 'Follow for more.', bg_prompt: `${drawn}. a phone in a hand` },
    ]);
    expect(rules(criticise(notebook, lookWant(drawn)))).not.toContain('style');
    const { spec: fixed, notes } = repair(notebook, lookWant(drawn));
    expect(fixed.scenes[1].bg_prompt).toContain('a loose ink drawing of a laptop');
    expect(notes.join(' ')).not.toContain('shot the way the rest of the film is');
  });
});

describe('a close the founder can stand behind', () => {
  it('knows an action somebody has to be offering from one they need not', () => {
    // "Book a call / Let's talk now" closed a reel whose founder had offered neither.
    expect(opensADoor('Book a call')).toBeTruthy();
    expect(opensADoor("Let's talk now, phone us today")).toBeTruthy();
    expect(opensADoor('Download the guide')).toBeTruthy();
    expect(opensADoor('Link in bio')).toBeTruthy();
    // These ask nothing of anybody and promise nothing either.
    expect(opensADoor('Follow for more')).toBe(null);
    expect(opensADoor('Show real traction')).toBe(null);
    expect(opensADoor('Save this for later')).toBe(null);
  });

  it('closes on something plain when nothing behind the film offers a door', () => {
    const asking = spec([
      { layout: 'hook', text: 'Investors want proof', say: 'Investors want proof.', bg_prompt: 'x' },
      { layout: 'statement', text: 'Show real usage', say: 'Show real usage.', bg_prompt: 'x' },
      { layout: 'cta', text: 'Book a call', heading: "Let's talk", say: 'Book a call now.', bg_prompt: 'x' },
    ]);
    const { spec: fixed, notes } = repair(asking, reelWant({ purpose: 'reel' }));
    const close = fixed.scenes.at(-1)!;
    expect(opensADoor(`${close.text} ${close.heading ?? ''} ${close.say}`)).toBe(null);
    expect(close.text).toBe(plainClose('reel').text);
    expect(notes.join(' ')).toContain('closes on something it can stand behind');
  });

  it('leaves a door the founder really named alone', () => {
    // Material behind the film answers for its own close; the grounding rules have it from there.
    const asking = spec([
      { layout: 'hook', text: 'One canvas', say: 'One canvas.', bg_prompt: 'x' },
      { layout: 'cta', text: 'Download it today', say: 'Download it today.', bg_prompt: 'x', source: 'can be downloaded' },
    ]);
    const held = repair(asking, reelWant({ sources: { corpus: 'everything made can be downloaded', brief: 'a launch', has: true, lines: [] } })).spec;
    expect(held.scenes.at(-1)!.text).toBe('Download it today');
  });
});
