import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedStage, type Stage } from '../../shared/model.ts';
import { createStore } from '../store.ts';
import { mediaTools } from '../tools/media.ts';
import { createMedia } from './jobs.ts';
import { composition, FORMATS, sceneSeconds, type Shot } from './templates/index.ts';
import { spendingScenes } from '../tools/media.ts';
import { fakeVideos, LENGTHS, MAX_IMAGES, parseSpec, PURPOSE, PURPOSES, scenesFor, storyboardOf, storyboardPrompt, withinCaps, type Scene, type Spec } from './video.ts';

const film: Spec = {
  title: 'Week eleven',
  scenes: [
    { layout: 'title', heading: 'Week eleven', text: 'What we shipped', say: 'Week eleven.' },
    { layout: 'bullets', heading: 'Three studios', bullets: ['Pictures', 'Voices', 'Films'] },
    { layout: 'picture', image_prompt: 'A quiet desk at dawn, soft light', text: 'Where it is made' },
    { layout: 'outro', text: 'Next week, more.' },
  ],
};
const shots = (scenes: Scene[]): Shot[] => scenes.map((scene) => ({ scene, seconds: 4 }));

describe('a storyboard', () => {
  it('takes a whole film and keeps only the fields a scene carries', () => {
    const read = parseSpec({ ...film, scenes: [...film.scenes, { layout: 'quote', text: '"It just works."', heading: 'Maya', colour: 'red' }] });
    expect(read.title).toBe('Week eleven');
    expect(read.scenes[0]).toEqual({ layout: 'title', heading: 'Week eleven', text: 'What we shipped', say: 'Week eleven.' });
    expect(read.scenes.at(-1)).toEqual({ layout: 'quote', text: '"It just works."', heading: 'Maya' });
    expect(parseSpec({ title: 'One', scenes: [{ layout: 'stat', heading: '3x', text: 'faster', say: null, bullets: null }] }).scenes[0]).toEqual({ layout: 'stat', heading: '3x', text: 'faster' });
  });

  it('says what is wrong in words whoever wrote it can act on', () => {
    expect(() => parseSpec('a film about kites')).toThrow('the storyboard must be a JSON object with "title" and "scenes"');
    expect(() => parseSpec({ scenes: film.scenes })).toThrow('"title" must be a line of text');
    expect(() => parseSpec({ title: 'One', scenes: [] })).toThrow('"scenes" must be a list with at least one scene');
    expect(() => parseSpec({ title: 'One', scenes: Array(25).fill(film.scenes[0]) })).toThrow('at most 24 scenes, not 25');
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'montage' }] })).toThrow('scene 1: "layout" must be one of title, hook, statement, bullets, checklist, steps, compare, picture, device, stat, quote, logo, cta, footage, clip, presenter, outro');
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'title' }] })).toThrow('scene 1: a title scene needs "heading"');
    expect(() => parseSpec({ title: 'One', scenes: [film.scenes[0], { layout: 'statement' }] })).toThrow('scene 2: a statement scene needs "text"');
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'bullets', heading: 'Two' }] })).toThrow('scene 1: a bullets scene needs "bullets"');
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'bullets', bullets: Array(7).fill('one') }] })).toThrow('at most 6 fit on screen, not 7');
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'picture', image_prompt: 'a kite' }] })).toThrow('scene 1: a picture scene needs "image_prompt" and a caption in "text"');
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'statement', text: 'x'.repeat(261) }] })).toThrow('scene 1: "text" is too long (261 characters, limit 260)');
    expect(() => parseSpec({ title: 'One', scenes: ['a scene'] })).toThrow('scene 1 must be an object');
  });

  it('gives the model one more go with the reason its first answer could not be used', async () => {
    const asked: string[] = [];
    const said = ['Sure! {"title": "One"}', `here you go:\n\`\`\`json\n${JSON.stringify(film)}\n\`\`\``];
    const spec = await storyboardOf('a week in review', async (prompt) => { asked.push(prompt); return said[asked.length - 1]; });
    expect(spec.scenes).toHaveLength(4);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain('a week in review');
    expect(asked[1]).toContain('Your last answer could not be used: "scenes" must be a list with at least one scene');

    await expect(storyboardOf('a week', async () => 'no json here at all')).rejects.toThrow(/the storyboard could not be written: /);
  });
});

describe('scene timing', () => {
  it('gives a scene the time to be read, and the whole line said over it', () => {
    expect(sceneSeconds('', 0)).toBe(2.8);
    expect(sceneSeconds('one two three four five six seven eight nine', 0)).toBeCloseTo(4.7, 2);
    // A long line spoken over a short scene stretches it; a short line never cuts one short.
    expect(sceneSeconds('two words', 9)).toBe(10);
    expect(sceneSeconds('two words', 1)).toBe(2.8);
    expect(sceneSeconds('word '.repeat(60), 0)).toBe(11);
  });
});

describe('the composition', () => {
  it('writes one sized, timed page with a scene a section and the narration beside it', () => {
    const timed: Shot[] = [{ ...shots(film.scenes)[0], voice: { file: 'say-0.wav', seconds: 3 } }, ...shots(film.scenes).slice(1)];
    timed[2].image = 'shot-2.png';
    const page = composition({ title: 'Week eleven', shape: 'wide', look: 'clean', shots: timed });
    expect(page).toContain('data-composition-id="main"');
    expect(page).toContain('data-width="1280" data-height="720" data-duration="16"');
    expect(page.match(/<section class="clip"/g)).toHaveLength(4);
    expect(page).toContain('<section class="clip" id="s1" data-start="4" data-duration="4">');
    // Every sound carries an id of its own, or the mixer never finds it and the film comes out silent.
    expect(page).toContain('<audio id="say0" src="assets/say-0.wav" data-start="0.35" data-duration="3.00" data-volume="1">');
    expect(page.match(/<audio /g)).toHaveLength(1);
    expect(page).toContain('src="assets/shot-2.png"');
    expect(page).toContain('window.__timelines["main"] = tl;');
    // Nothing is fetched from anywhere: the animation, the drawing and the typeface are all in the folder.
    expect(page).toContain('src="vendor/gsap.min.js"');
    expect(page).not.toContain('//cdn');
    expect(page).toContain("url('vendor/inter.woff2')");
  });

  it('draws the clean look with straight lines and the sketch one by hand, and never both', () => {
    const clean = composition({ title: 'One', shape: 'wide', look: 'clean', shots: shots(film.scenes) });
    expect(clean).not.toContain('vendor/rough.js');
    expect(clean).not.toContain('marksOf');
    expect(clean).toContain('#s0 .rule", { scaleX: 0 }');

    const sketch = composition({ title: 'One', shape: 'wide', look: 'sketch', shots: shots(film.scenes) });
    expect(sketch).toContain('src="vendor/rough.js"');
    // The hand drawn marks are measured before the timeline is built, or they land where the words start, not where they rest.
    expect(sketch.indexOf('const drawn = marksOf(SCENE_AT);')).toBeLessThan(sketch.indexOf('build(tl);'));
    expect(sketch).toContain('markSteps(tl, drawn);');
    expect(sketch).toContain('<svg class="marks" id="m0" viewBox="0 0 1280 720">');
    expect(sketch).not.toContain('.rule", { scaleX: 0 }');
  });

  it('draws every layout, and sizes the page to the shape asked for', () => {
    const every: Scene[] = [
      { layout: 'title', heading: 'One' }, { layout: 'statement', text: 'A sentence.' }, { layout: 'bullets', heading: 'Two', bullets: ['a', 'b'] },
      { layout: 'picture', image_prompt: 'a kite', text: 'A kite' }, { layout: 'stat', heading: '3x', text: 'faster' },
      { layout: 'quote', text: 'It just works.', heading: 'Maya' }, { layout: 'outro', text: 'The end.' },
    ];
    const drawn = shots(every);
    drawn[3].image = 'shot-3.png';
    for (const [shape, size] of Object.entries(FORMATS)) {
      const page = composition({ title: 'One', shape: shape as keyof typeof FORMATS, look: 'clean', shots: drawn });
      expect(page).toContain(`data-width="${size.width}" data-height="${size.height}"`);
      expect(page).toContain(`--s: ${size.scale};`);
      for (const mark of ['class="display', 'class="heading', 'class="list"', 'class="shot"', 'class="stat', 'class="quote', 'class="plate"']) expect(page).toContain(mark);
      // The quote marks are put on for whoever wrote the line without them.
      expect(page).toContain('“It just works.”');
    }
  });

  it('sets the words for a screen watched from across a room', () => {
    const page = composition({ title: 'One', shape: 'wide', look: 'clean', shots: shots(film.scenes) });
    // A heading is about a tenth of the height of a wide frame, and a title half as much again.
    expect(page).toContain('.heading { font-size: calc(68px * var(--s));');
    expect(page).toContain('.display { font-size: calc(112px * var(--s));');
    // The block sits a little above the middle of the frame, where the eye reads it as centred.
    expect(page).toContain('padding: var(--margin) var(--margin) calc(var(--margin) + var(--lift));');
    expect(page).toContain('--lift: 56px;');
  });

  it('makes the one figure on a stat scene the whole scene, and runs it up to itself', () => {
    const wide = composition({ title: 'One', shape: 'wide', look: 'clean', shots: shots([{ layout: 'stat', heading: '38%', text: 'of a sprint' }]) });
    expect(wide).toContain('<p class="stat rise" data-mark="ring" style="font-size: 300px">');
    expect(wide).toContain('<span class="count" style="min-width: 2ch">38</span>%');
    expect(wide).toContain('{ textContent: 0 }, { textContent: 38,');
    // A longer figure is stepped down to the width of the frame rather than wrapped onto two lines.
    const long = composition({ title: 'One', shape: 'wide', look: 'clean', shots: shots([{ layout: 'stat', heading: '$1,200 saved' }]) });
    expect(long).toContain('style="font-size: 116px"');
    // A figure that is really a sentence stops shrinking at the size of a heading and wraps.
    const said = composition({ title: 'One', shape: 'wide', look: 'clean', shots: shots([{ layout: 'stat', heading: 'a whole working day, every single week' }]) });
    expect(said).toContain('style="font-size: 68px; white-space: normal"');
    // Nothing to count in a figure that is not a whole number: it is simply shown.
    const words = composition({ title: 'One', shape: 'wide', look: 'clean', shots: shots([{ layout: 'stat', heading: 'Twice over' }]) });
    expect(words).not.toContain('class="count"');
    expect(words).not.toContain('textContent');
  });

  it('sets a line short enough to say in one breath as large as a title', () => {
    const page = composition({ title: 'One', shape: 'wide', look: 'clean', shots: shots([
      { layout: 'statement', text: 'We stopped guessing.' },
      { layout: 'statement', text: 'Most teams lose a whole day a week in the handover between design and build.' },
    ]) });
    expect(page).toContain('<p class="display rise">We stopped guessing.</p>');
    expect(page).toContain('<p class="heading rise">Most teams lose');
  });

  it('keeps whatever was written out of the page\'s own markup', () => {
    const page = composition({ title: 'One', shape: 'wide', look: 'clean', shots: shots([{ layout: 'statement', text: '<script>alert("x")</script> & more' }]) });
    expect(page).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more');
    expect(page).not.toContain('<script>alert');
  });
});

describe('generate_video', () => {
  const wired: Stage = {
    ...seedStage,
    cards: [{ id: 'studio-3', kind: 'videogen', x: 0, y: 0, w: 1, h: 1 }],
    wires: [...seedStage.wires, { id: 'w', from: 'studio-3', fromHandle: 'r', to: 'marketing', toHandle: 'l' }],
  };

  const turn = async (stage: Stage) => {
    const dir = await mkdtemp(join(tmpdir(), 'videotool-'));
    const store = createStore(dir);
    const media = createMedia({ dir, store, makers: { videogen: [fakeVideos] } });
    const tool = mediaTools(media).find((one) => one.name === 'generate_video')!;
    return { tool, media, context: { stage, roomId: 'marketing', store, granted: new Map<string, string>() } };
  };

  it('films the storyboard a person wrote, and keeps the poster beside the film', async () => {
    const { tool, media, context } = await turn(wired);
    const ran = await tool.run({ ...film, format: 'tall', look: 'sketch' }, context);
    expect(ran.text).toMatch(/^Made the film\.\n\n\[Week eleven\]\(\/api\/files\/media\/[a-z0-9-]+\.mp4\)$/);
    expect(ran.effect).toEqual({ kind: 'media-made', id: 'studio-3' });
    const made = (await media.read('studio-3')).results[0];
    expect(made.prompt).toBe('Week eleven');
    expect(made.poster).toMatch(/^media\/.+\.png$/);
    expect((await context.store.readFileBytes(made.path))!.length).toBeGreaterThan(1000);
    expect((await media.read('studio-3')).log[0]).toBe('4 scenes: Week eleven');
  });

  it('hands a storyboard it cannot use straight back, and never films in someone else\'s studio', async () => {
    const { tool, context } = await turn(wired);
    await expect(tool.run({ title: 'One', scenes: [{ layout: 'title' }] }, context)).rejects.toThrow('scene 1: a title scene needs "heading"');
    await expect(tool.run(film as unknown as Record<string, unknown>, { ...context, roomId: 'build' })).rejects.toThrow(/no video studio is connected/);
    const { tool: alone, context: nowhere } = await turn({ ...wired, wires: seedStage.wires });
    await expect(alone.run(film as unknown as Record<string, unknown>, nowhere)).rejects.toThrow(/no video studio is connected to your room/);
  });

  it('keeps its parameters flat and simple, the way every provider accepts them', async () => {
    const { tool } = await turn(wired);
    const properties = (tool.parameters as { properties: Record<string, { type: string; enum?: string[] }> }).properties;
    expect(Object.keys(properties).sort()).toEqual(['captions', 'format', 'look', 'music', 'narrate', 'pace', 'scenes', 'sfx', 'title']);
    expect(properties.look.enum).toEqual(['clean', 'sketch', 'brand']);
    expect(properties.format.enum).toEqual(['square', 'wide', 'tall']);
    expect(properties.pace.enum).toEqual(['calm', 'punchy']);
    // Every scene field is a plain string, number, boolean or list of strings: Gemini rejects anything cleverer.
    const scene = ((tool.parameters as { properties: { scenes: { items: { properties: Record<string, { type: string; items?: { type: string } }> } } } }).properties.scenes.items.properties);
    for (const [name, shape] of Object.entries(scene)) {
      expect(['string', 'number', 'boolean', 'array'], name).toContain(shape.type);
      if (shape.type === 'array') expect(shape.items).toEqual({ type: 'string' });
    }
  });
});

describe('the storyboard a fuller film needs', () => {
  it('takes every new layout and keeps exactly the fields it carries', () => {
    const read = parseSpec({
      title: 'A launch', pace: 'punchy', music: 'drive', captions: true, sfx: false,
      scenes: [
        { layout: 'hook', text: 'You lose a day a week.' },
        { layout: 'compare', heading: 'The turn', bullets: ['Three tools', 'One stage'], labels: ['Them', 'Us'] },
        { layout: 'checklist', heading: 'In the box', bullets: ['Rooms', 'Docs'] },
        { layout: 'steps', heading: 'How', bullets: ['Write', 'Wire', 'Make'] },
        { layout: 'device', asset: 'screen-0-desktop-0', heading: 'The stage', frame: 'browser' },
        { layout: 'footage', asset: 'walk', start: 4, seconds: 3, mute: false, text: 'On the way in' },
        { layout: 'clip', clip_prompt: 'a paper plane over a desk', seconds: 9 },
        { layout: 'presenter', say: 'We built this for ourselves first.', portrait_prompt: 'a founder in her thirties' },
        { layout: 'logo', heading: 'Relay', text: 'relay.app' },
        { layout: 'cta', text: 'Try it this week.', heading: 'relay.app' },
      ],
    });
    expect(read.pace).toBe('punchy');
    expect(read.music).toBe('drive');
    expect(read.captions).toBe(true);
    expect(read.sfx).toBe(false);
    expect(read.scenes[1]).toEqual({ layout: 'compare', heading: 'The turn', bullets: ['Three tools', 'One stage'], labels: ['Them', 'Us'] });
    expect(read.scenes[4]).toEqual({ layout: 'device', asset: 'screen-0-desktop-0', heading: 'The stage', frame: 'browser' });
    expect(read.scenes[5]).toEqual({ layout: 'footage', asset: 'walk', start: 4, seconds: 3, mute: false, text: 'On the way in' });
    // A clip is three to five seconds whatever it asked for: this is the part that costs somebody else's quota.
    expect(read.scenes[6].seconds).toBe(5);
    expect(parseSpec({ title: 'x', scenes: [{ layout: 'clip', clip_prompt: 'a kite' }] }).scenes[0].seconds).toBe(4);
  });

  it('says what each of the new layouts is missing, in words whoever wrote it can act on', () => {
    const bad = (scene: Record<string, unknown>) => () => parseSpec({ title: 'One', scenes: [scene] });
    expect(bad({ layout: 'hook' })).toThrow('scene 1: a hook scene needs "text"');
    expect(bad({ layout: 'checklist', heading: 'Two' })).toThrow('scene 1: a checklist scene needs "bullets"');
    expect(bad({ layout: 'steps', heading: 'Two' })).toThrow('scene 1: a steps scene needs "bullets"');
    expect(bad({ layout: 'compare', bullets: ['one'] })).toThrow('scene 1: a compare scene needs exactly two "bullets" — the before and the after');
    expect(bad({ layout: 'compare', bullets: ['a', 'b', 'c'] })).toThrow('exactly two "bullets"');
    expect(bad({ layout: 'device', heading: 'The app' })).toThrow('scene 1: a device scene needs "asset"');
    expect(bad({ layout: 'device', asset: 'a', frame: 'watch' })).toThrow('scene 1: "frame" must be one of phone, laptop, browser');
    expect(bad({ layout: 'footage' })).toThrow('scene 1: a footage scene needs "asset"');
    expect(bad({ layout: 'clip' })).toThrow('scene 1: a clip scene needs "clip_prompt"');
    expect(bad({ layout: 'presenter', portrait_prompt: 'a founder' })).toThrow('scene 1: a presenter scene needs "say"');
    expect(bad({ layout: 'presenter', say: 'Hello.' })).toThrow('scene 1: a presenter scene needs "portrait_prompt" or "asset"');
    expect(bad({ layout: 'logo' })).toThrow('scene 1: a logo scene needs "heading"');
    expect(bad({ layout: 'cta', heading: 'relay.app' })).toThrow('scene 1: a cta scene needs "text"');
    expect(bad({ layout: 'compare', bullets: ['a', 'b'], labels: ['one', 'two', 'three'] })).toThrow('"labels": at most 2 fit on screen, not 3');
  });

  it('holds a storyboard inside the caps rather than throwing it away', () => {
    const seven = Array(7).fill(0).map((_, at) => ({ layout: 'picture' as const, image_prompt: `a kite ${at}`, text: `Kite ${at}` }));
    const { spec, notes } = withinCaps({ title: 'Kites', scenes: seven }, { ai: true, assets: [] });
    expect(spec.scenes.filter((one) => one.layout === 'picture')).toHaveLength(MAX_IMAGES);
    expect(spec.scenes.at(-1)).toEqual({ layout: 'statement', text: 'Kite 6', image_prompt: undefined });
    expect(notes[0]).toContain(`at most ${MAX_IMAGES} pictures`);
  });

  it("spends the AI quota at most twice, and never when the founder's switch is off", () => {
    const three = { title: 'One', scenes: [
      { layout: 'clip' as const, clip_prompt: 'a kite', text: 'A kite' },
      { layout: 'presenter' as const, say: 'Hello.', portrait_prompt: 'a founder' },
      { layout: 'clip' as const, clip_prompt: 'a desk', text: 'A desk' },
    ] };
    const on = withinCaps(three, { ai: true, assets: [] });
    expect(on.spec.scenes.map((one) => one.layout)).toEqual(['clip', 'presenter', 'picture']);
    const off = withinCaps(three, { ai: false, assets: [] });
    expect(off.spec.scenes.map((one) => one.layout)).toEqual(['picture', 'statement', 'picture']);
    // A clip that cannot be made keeps its words; a presenter keeps saying what it was going to say.
    expect(off.spec.scenes[1].say).toBe('Hello.');
    expect(off.spec.scenes[0].image_prompt).toBe('a kite');
  });

  it('drops a name for something that is not on the card, rather than filming a hole', () => {
    const { spec } = withinCaps({ title: 'One', scenes: [
      { layout: 'footage', asset: 'holiday', text: 'On the beach' },
      { layout: 'device', asset: 'screen-0-desktop-0', heading: 'The stage' },
    ] }, { ai: false, assets: ['screen-0-desktop-0'] });
    expect(spec.scenes[0].layout).toBe('statement');
    expect(spec.scenes[0].text).toBe('On the beach');
    expect(spec.scenes[1].layout).toBe('device');
  });
});

describe('what a film is for', () => {
  it('gives every purpose a shape, a pace and a format, and a number of scenes that fits the length', () => {
    for (const purpose of PURPOSES) {
      const preset = PURPOSE[purpose];
      expect(LENGTHS).toContain(preset.length);
      expect(preset.shape.length).toBeGreaterThan(40);
      const [least, most] = scenesFor(preset.length, preset.pace);
      expect(least).toBeGreaterThanOrEqual(3);
      expect(most).toBeLessThanOrEqual(24);
      expect(most).toBeGreaterThan(least);
    }
    // A reel cuts fast, so thirty seconds of it is far more scenes than thirty seconds of an explainer.
    expect(scenesFor(30, 'punchy')[1]).toBeGreaterThan(scenesFor(30, 'calm')[1]);
  });

  it('writes the brief around what the film is for, what is on the card and what may be spent', () => {
    const material = {
      lines: ['What it says it is: Handover, without the handover.'],
      assets: [{ name: 'walk', kind: 'video', what: "6 seconds of the founder's own footage" }],
      using: ['relay'],
    };
    const reel = storyboardPrompt({ brief: 'launch the studio', purpose: 'reel', seconds: 30, pace: 'punchy', shape: 'tall', captions: true, music: 'drive', sfx: true, ai: false, material });
    expect(reel).toContain('shot tall for a phone');
    expect(reel).toContain(PURPOSE.reel.shape);
    expect(reel).toContain("- walk — 6 seconds of the founder's own footage");
    expect(reel).toContain('never invent a feature, a number or a customer it does not have');
    expect(reel).toContain('captioned word by word');
    expect(reel).toContain('launch the studio');
    // Nothing offers a layout the film cannot actually fill.
    expect(reel).toContain('- footage:');
    expect(reel).not.toContain('- clip:');
    expect(reel).not.toContain('- device:');

    const pitch = storyboardPrompt({ brief: 'raise a seed round', purpose: 'pitch', seconds: 90, pace: 'calm', shape: 'wide', captions: false, music: 'calm', sfx: true, ai: true, material: { lines: [], assets: [], using: [] } });
    expect(pitch).toContain('90-second investor pitch');
    expect(pitch).toContain('- clip:');
    expect(pitch).not.toContain('- footage:');
    expect(pitch).not.toContain('These are on the card already');
  });
});

describe('a film with everything in it', () => {
  it('draws every one of the seventeen layouts', () => {
    const every: Scene[] = [
      { layout: 'title', heading: 'One' }, { layout: 'hook', text: 'Stop.' }, { layout: 'statement', text: 'A sentence.' },
      { layout: 'bullets', heading: 'Two', bullets: ['a', 'b'] }, { layout: 'checklist', heading: 'In', bullets: ['a'] },
      { layout: 'steps', heading: 'How', bullets: ['a', 'b'] }, { layout: 'compare', bullets: ['was', 'is'], labels: ['Was', 'Is'] },
      { layout: 'picture', image_prompt: 'a kite', text: 'A kite' }, { layout: 'device', asset: 'screen', heading: 'On screen' },
      { layout: 'stat', heading: '3x', text: 'faster' }, { layout: 'quote', text: 'It just works.', heading: 'Maya' },
      { layout: 'logo', heading: 'Relay', text: 'relay.app' }, { layout: 'cta', text: 'Try it.', heading: 'relay.app' },
      { layout: 'footage', asset: 'walk', text: 'On the way' }, { layout: 'clip', clip_prompt: 'a plane', text: 'A plane' },
      { layout: 'presenter', say: 'Hello.', portrait_prompt: 'a founder' }, { layout: 'outro', text: 'The end.' },
    ];
    const drawn = shots(every);
    drawn[7].image = 'shot-7.png';
    drawn[8].image = 'screen-0-desktop-0.png';
    drawn[13].video = 'cut-13.mp4';
    drawn[14].video = 'clip-14.mp4';
    drawn[15].video = 'pres-15.mp4';
    for (const shape of Object.keys(FORMATS) as (keyof typeof FORMATS)[]) {
      const page = composition({ title: 'One', shape, look: 'clean', pace: 'punchy', shots: drawn });
      for (const mark of ['class="hook', 'class="list list--check"', 'class="list list--steps"', 'class="compare"',
        'class="device device--', 'class="cta', 'frame--logo', 'class="presenter"', 'class="mark"', 'class="step"']) expect(page, `${shape}: ${mark}`).toContain(mark);
      expect(page).toContain('<video src="assets/cut-13.mp4" playsinline muted');
      expect(page).toContain('<video src="assets/pres-15.mp4" playsinline muted');
      expect(page.match(/<section class="clip"/g)).toHaveLength(17);
    }
    // A tall frame takes a phone and a wide one a browser, unless the storyboard said which.
    expect(composition({ title: 'One', shape: 'tall', look: 'clean', shots: shots([{ layout: 'device', asset: 'a' }]) })).toContain('device--phone');
    expect(composition({ title: 'One', shape: 'wide', look: 'clean', shots: shots([{ layout: 'device', asset: 'a' }]) })).toContain('device--browser');
  });

  it("keeps a piece of the founder's own sound only where the scene asked for it", () => {
    const loud = shots([{ layout: 'footage', asset: 'walk', mute: false, start: 3.5 }]);
    loud[0].video = 'cut-0.mp4';
    const page = composition({ title: 'One', shape: 'wide', look: 'clean', shots: loud });
    expect(page).toContain('data-media-start="3.50"');
    expect(page).toContain('data-has-audio="true" data-volume="0.85"');
    expect(page).not.toContain('playsinline muted');
  });

  it('moves twice as fast when the founder asked it to', () => {
    const calm = composition({ title: 'One', shape: 'wide', look: 'clean', pace: 'calm', shots: shots(film.scenes) });
    const punchy = composition({ title: 'One', shape: 'wide', look: 'clean', pace: 'punchy', shots: shots(film.scenes) });
    expect(calm).toContain('duration: 0.92, ease: "expo.out", stagger: 0.1');
    expect(punchy).toContain('duration: 0.52, ease: "power3.out", stagger: 0.05');
    // The same words are held for longer when there is room for them.
    expect(sceneSeconds('one two three four five six', 0, 'calm')).toBeGreaterThan(sceneSeconds('one two three four five six', 0, 'punchy'));
    expect(sceneSeconds('', 0, 'punchy')).toBe(1.7);
  });

  it('puts the bed under everything and the sounds on the cuts, each with an id of its own', () => {
    const page = composition({
      title: 'One', shape: 'tall', look: 'clean', pace: 'punchy', shots: shots(film.scenes),
      bed: { file: 'bed.wav', seconds: 16 }, cues: [{ sound: 'cut-hard', at: 0 }, { sound: 'tick', at: 4.2, gain: 0.5 }],
    });
    expect(page).toContain('<audio id="bed" src="assets/bed.wav" data-start="0" data-duration="16.00" data-volume="1">');
    expect(page).toContain('<audio id="fx0" src="assets/cut-hard.wav" data-start="0.00" data-duration="1" data-volume="0.30">');
    expect(page).toContain('<audio id="fx1" src="assets/tick.wav" data-start="4.20" data-duration="1" data-volume="0.50">');
    // Nothing is fetched from anywhere, sound included.
    expect(page).not.toContain('//cdn');
  });

  it("wears the product's own colours when it was asked to", () => {
    const brand = composition({ title: 'One', shape: 'wide', look: 'brand', brand: { colours: ['#0e1117', '#4e8cff'], font: 'Satoshi', fontFile: 'Satoshi.woff2' }, shots: shots(film.scenes) });
    expect(brand).toContain('--ground: #0e1117;');
    expect(brand).toContain('--signal: #4e8cff;');
    expect(brand).toContain('font-family: "Satoshi", \'Studio Sans\', sans-serif;');
    expect(brand).toContain("src: url('vendor/Satoshi.woff2')");
  });
});

describe('the scenes that cost something', () => {
  const wiredWith = (ai: boolean): Stage => ({
    ...seedStage,
    cards: [{ id: 'studio-3', kind: 'videogen', ...(ai ? { ai: true } : {}), x: 0, y: 0, w: 1, h: 1 }],
    wires: [...seedStage.wires, { id: 'w', from: 'studio-3', fromHandle: 'r', to: 'marketing', toHandle: 'l' }],
  });
  const ask = async (stage: Stage) => {
    const dir = await mkdtemp(join(tmpdir(), 'approve-'));
    const store = createStore(dir);
    const media = createMedia({ dir, store, makers: { videogen: [fakeVideos] } });
    const tool = mediaTools(media).find((one) => one.name === 'generate_video')!;
    const approval = tool.approval as (args: Record<string, unknown>, context: never) => Promise<string | null>;
    return { approval, context: { stage, roomId: 'marketing', store, granted: new Map<string, string>() } };
  };

  it('names them, and only them', () => {
    expect(spendingScenes([{ layout: 'clip' }, { layout: 'title' }, { layout: 'presenter' }])).toEqual(['clip', 'presenter']);
    expect(spendingScenes([{ layout: 'picture' }])).toEqual([]);
    expect(spendingScenes('not a list')).toEqual([]);
  });

  it('asks the founder before a person spends the quota, and never asks for anything else', async () => {
    const { approval, context } = await ask(wiredWith(true));
    expect(await approval({ ...film, scenes: [...film.scenes, { layout: 'clip', clip_prompt: 'a kite' }] } as never, context as never))
      .toBe('Make 1 AI scene (clip) in the video studio? Those are the only part of a film that is not free.');
    // Nothing that costs anything, nothing to ask about.
    expect(await approval(film as never, context as never)).toBeNull();
    // The switch is the founder's: with it off the scene is never made, so there is nothing to approve either.
    const { approval: quiet, context: off } = await ask(wiredWith(false));
    expect(await quiet({ title: 'One', scenes: [{ layout: 'clip', clip_prompt: 'a kite' }] } as never, off as never)).toBeNull();
  });
});

describe('the assets tray on a card', () => {
  it('names what was dropped after the file, keeps the names apart, and lets one go', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tray-'));
    const media = createMedia({ dir, store: createStore(dir), makers: { videogen: [fakeVideos] } });
    const first = await media.addAsset('studio-3', { file: 'Walk in the park.MOV', path: 'uploads/a.mov', kind: 'video', bytes: 900, seconds: 12, thumb: 'media/t.jpg' });
    const second = await media.addAsset('studio-3', { file: 'walk-in-the-park.mov', path: 'uploads/b.mov', kind: 'video', bytes: 900 });
    expect(first.name).toBe('Walk in the park');
    expect(second.name).toBe('walk-in-the-park');
    const third = await media.addAsset('studio-3', { file: 'Walk in the park.mp4', path: 'uploads/c.mp4', kind: 'video', bytes: 900 });
    expect(third.name).toBe('Walk in the park-2');
    expect(await media.assetsOf('studio-3')).toHaveLength(3);
    await media.removeAsset('studio-3', 'Walk in the park');
    expect((await media.assetsOf('studio-3')).map((one) => one.name)).toEqual(['walk-in-the-park', 'Walk in the park-2']);
  });

  it('keeps what was dropped when something is made, and tells the studio which card asked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tray2-'));
    const asked: Record<string, unknown>[] = [];
    const media = createMedia({ dir, store: createStore(dir), makers: { videogen: [{ ...fakeVideos, make: async (one, help) => { asked.push(one); return fakeVideos.make(one, help); } }] } });
    await media.addAsset('studio-3', { file: 'walk.mp4', path: 'uploads/a.mp4', kind: 'video', bytes: 900 });
    await media.make({ id: 'studio-3', kind: 'videogen', x: 0, y: 0, w: 1, h: 1 }, { prompt: 'A film' });
    expect(asked[0].cardId).toBe('studio-3');
    const after = await media.read('studio-3');
    expect(after.assets).toHaveLength(1);
    expect(after.results).toHaveLength(1);
    expect(after.state).toBe('idle');
  });
});
