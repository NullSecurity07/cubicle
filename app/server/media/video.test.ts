import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedStage, type Stage } from '../../shared/model.ts';
import { createStore } from '../store.ts';
import { mediaTools } from '../tools/media.ts';
import { createMedia, type Maker } from './jobs.ts';
import { crowdsCaptions } from './spec.ts';
import { composition, FORMATS, PACKS, quietOf, SAFE_1080, safeArea, sceneSeconds, startsOf, type Shot } from './templates/index.ts';
import { meansAPicture, spendingScenes } from '../tools/media.ts';
import { docsFor, fakeVideos, sourcesFor, type VideoAsk } from './video.ts';
import { LENGTHS, MAX_AI, MAX_IMAGES, MAX_LOCAL_AI, parseSpec, PURPOSE, PURPOSES, scenesFor, withinCaps, withinLength, wordsFor, type Scene, type Spec } from './spec.ts';
import { hands } from './turns.ts';
import { makingWords as estimate } from '../../shared/film-time.ts';
import { bibleFor, jsonIn, layoutsFor, planPrompt, specPrompt, understandingOf, type Material, type Plan } from './director.ts';
import { budgetOf } from './spec.ts';

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
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'montage' }] })).toThrow('scene 1: "layout" must be one of title, hook, statement, bullets, checklist, steps, compare, chart, picture, device, stat, quote, logo, cta, footage, clip, presenter, outro');
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'title' }] })).toThrow('scene 1: a title scene needs "heading"');
    expect(() => parseSpec({ title: 'One', scenes: [film.scenes[0], { layout: 'statement' }] })).toThrow('scene 2: a statement scene needs "text"');
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'bullets', heading: 'Two' }] })).toThrow('scene 1: a bullets scene needs "bullets"');
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'bullets', bullets: Array(7).fill('one') }] })).toThrow('at most 6 fit on screen, not 7');
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'picture', text: 'A kite' }] })).toThrow('scene 1: a picture scene needs "image_prompt"');
    // A picture on its own is a scene: under captions a caption as well would be the same sentence twice.
    expect(parseSpec({ title: 'One', scenes: [{ layout: 'picture', image_prompt: 'a kite' }] }).scenes[0].layout).toBe('picture');
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'statement', text: 'x'.repeat(261) }] })).toThrow('scene 1: "text" is too long (261 characters, limit 260)');
    expect(() => parseSpec({ title: 'One', scenes: ['a scene'] })).toThrow('scene 1 must be an object');
  });

  it('reads a JSON object out of a model that also wanted to explain itself', () => {
    expect(jsonIn('Sure! {"title": "One"} hope that helps')).toEqual({ title: 'One' });
    expect(jsonIn(`here you go:\n\`\`\`json\n${JSON.stringify(film)}\n\`\`\``)).toMatchObject({ title: 'Week eleven' });
    expect(() => jsonIn('no json here at all')).toThrow('the answer held no JSON object');
    expect(() => jsonIn('{not really}')).toThrow('the answer was not valid JSON');
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
    expect(page).toContain('<section class="clip" id="s1" data-start="4" data-duration="4.42">');
    // Everything one scene is made of moves as one box, because a cut is a move of the whole box.
    expect(page).toContain('<div class="stage" id="g1">');
    // The last scene has nothing to leave for, and is held past the end of the film all the same: a section that
    // stops exactly on the last frame is a section the renderer catches a hair after it has gone, which is a
    // frame of black on the end of every film.
    expect(page).toContain('id="s3" data-start="12" data-duration="4.42">');
    expect(page).toContain('data-duration="16"');
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
      for (const mark of ['class="display', 'class="heading', 'class="list"', 'class="shot"', 'class="regstat"', 'class="quote', 'class="plate"']) expect(page).toContain(mark);
      // The quote marks are put on for whoever wrote the line without them.
      expect(page).toContain('“It just works.”');
    }
  });

  it('hands a plain figure to the registry\'s count-up, in the box the figure had, and draws short-label charts as its columns', () => {
    const stat = composition({ title: 'One', shape: 'wide', look: 'clean', shots: shots([{ layout: 'stat', heading: '38%', text: 'of a sprint' }]) });
    expect(stat).toContain('<div class="regstat" style="height: 349px"><div class="regcount" id="regcount0"');
    expect(stat).toContain('var vars = {"start":0,"end":38,"prefix":"","suffix":"%"');
    expect(stat).toContain('tl.add(registryCount0().paused(false), 0.220);');
    // One way of counting a figure, not two.
    expect(stat).not.toContain('class="count"');
    expect(stat).not.toContain('textContent: 38');
    expect(stat).toContain('<p class="lead quiet rise">of a sprint</p>');
    const years: Scene = { layout: 'chart', heading: 'Revenue', bullets: ['2023 12k', '2024 30k', '2025 48k'] };
    const chart = composition({ title: 'One', shape: 'wide', look: 'creator', shots: shots([years]) });
    expect(chart).toContain('class="hf-catalog-animated-bar-chart regbars" id="regbars0"');
    expect(chart).toContain('tl.fromTo("#regbars0", { "--hf-grow": 0 }');
    expect(chart).not.toContain('class="chart"');
    expect(chart).not.toContain('"#c0-0"');
    // Names that have to be read keep the studio's rows, which give a name a line of its own.
    const names: Scene = { layout: 'chart', bullets: ['Spreadsheets 12h', 'Our studio 2h'] };
    const rows = composition({ title: 'One', shape: 'wide', look: 'creator', shots: shots([names]) });
    expect(rows).toContain('class="chart"');
    expect(rows).toContain('"#c0-0"');
    expect(rows).not.toContain('regbars');
  });

  it('sets the words for a screen watched from across a room', () => {
    const page = composition({ title: 'One', shape: 'wide', look: 'clean', shots: shots(film.scenes) });
    // A heading is about a tenth of the height of a wide frame, and a title half as much again. The sizes are
    // written out in whole pixels rather than left to a multiplier, because there are floors under them now and a
    // floor that cannot be read off the stylesheet is not a floor.
    expect(page).toContain('font-size: 68px;');
    expect(page).toContain('font-size: 112px;');
    // The block sits a little above the middle of the frame, where the eye reads it as centred — and clear of the
    // whole of the platform's own furniture, not a third of it.
    expect(page).toContain('calc(var(--margin) + var(--lift) + var(--safe-foot)) var(--margin);');
    expect(page).toContain('--lift: 56px;');
  });

  it('keeps every word inside the strip a phone feed leaves free', () => {
    // The top 250px of a 1080x1920 feed carry a handle, the bottom 510px carry the caption, the sound and the
    // buttons, and the right 140px carry the column a thumb reaches for. Our tall frame is that canvas at two
    // thirds, so the numbers are too, and nothing that has to be read is drawn outside what is left.
    const page = composition({ title: 'One', shape: 'tall', look: 'creator', captions: true, shots: shots(film.scenes) });
    expect(page).toContain(`--safe-top: ${FORMATS.tall.safeTop}px;`);
    expect(page).toContain(`--safe-foot: ${FORMATS.tall.safeFoot}px;`);
    expect(page).toContain(`--safe-right: ${FORMATS.tall.safeRight}px;`);
    for (const [name, mine, theirs] of [['top', FORMATS.tall.safeTop, SAFE_1080.top], ['foot', FORMATS.tall.safeFoot, SAFE_1080.foot],
      ['right', FORMATS.tall.safeRight, SAFE_1080.right]] as const) {
      expect(mine, name).toBeGreaterThanOrEqual(Math.floor((theirs * FORMATS.tall.width) / 1080));
    }
    // The captions sit around two thirds of the way down, and well above the strip the platform owns.
    expect(FORMATS.tall.caps).toBeGreaterThan(FORMATS.tall.safeFoot);
    expect(1 - FORMATS.tall.caps / FORMATS.tall.height).toBeGreaterThan(0.6);
    expect(1 - FORMATS.tall.caps / FORMATS.tall.height).toBeLessThan(0.72);
    // And the rectangle everything has to sit inside is the frame less all of it.
    const area = safeArea('tall');
    expect(area.y).toBeGreaterThanOrEqual(FORMATS.tall.safeTop);
    expect(area.x + area.width).toBeLessThanOrEqual(FORMATS.tall.width - FORMATS.tall.safeRight);
    expect(area.y + area.height).toBeLessThanOrEqual(FORMATS.tall.height - FORMATS.tall.safeFoot);
  });

  it('makes the one figure on a stat scene the whole scene, and runs it up to itself', () => {
    // The notebook draws its own figure, because it rings it by hand and a ring is measured around type that is there.
    const wide = composition({ title: 'One', shape: 'wide', look: 'sketch', shots: shots([{ layout: 'stat', heading: '38%', text: 'of a sprint' }]) });
    expect(wide).toContain('<p class="stat rise" data-mark="ring" style="font-size: 300px">');
    expect(wide).toContain('<span class="count" style="min-width: 2ch">38</span>%');
    expect(wide).toContain('{ textContent: 0 }, { textContent: 38,');
    // A longer figure is stepped down to the width of the frame rather than wrapped onto two lines.
    const long = composition({ title: 'One', shape: 'wide', look: 'clean', shots: shots([{ layout: 'stat', heading: '$1,200 saved' }]) });
    expect(long).toContain('style="font-size: 146px"');
    // A figure that is really a sentence stops shrinking at the size of a heading and wraps.
    const said = composition({ title: 'One', shape: 'wide', look: 'clean', shots: shots([{ layout: 'stat', heading: 'a whole working day, every single week' }]) });
    expect(said).toContain('style="font-size: 88px; white-space: normal"');
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
    expect(ran.text).toMatch(/^Made the film\. It is also at media\/[a-z0-9-]+\.mlt as tracks for Shotcut or Kdenlive, with its pictures and sound beside it\.\n\n\[Week eleven\]\(\/api\/files\/media\/[a-z0-9-]+\.mp4\)$/);
    expect(ran.effect).toEqual({ kind: 'media-made', id: 'studio-3' });
    const made = (await media.read('studio-3')).results[0];
    expect(made.prompt).toBe('Week eleven');
    expect(made.poster).toMatch(/^media\/.+\.png$/);
    expect((await context.store.readFileBytes(made.path))!.length).toBeGreaterThan(1000);
    // The finished film is also a project an editor opens, named after the film and pointing at it by its own name.
    expect(made.mlt).toBe(made.path.replace(/\.mp4$/, '.mlt'));
    const project = (await context.store.readFileBytes(made.mlt!))!.toString('utf8');
    expect(project).toContain(`<property name="resource">${made.path.split('/').pop()}</property>`);
    expect((await media.read('studio-3')).log[1]).toBe('4 scenes: Week eleven');
  });

  it('hands a storyboard it cannot use straight back, and never films in someone else\'s studio', async () => {
    const { tool, context } = await turn(wired);
    await expect(tool.run({ title: 'One', scenes: [{ layout: 'title' }] }, context)).rejects.toThrow('scene 1: a title scene needs "heading"');
    await expect(tool.run(film as unknown as Record<string, unknown>, { ...context, roomId: 'build' })).rejects.toThrow(/no video studio is connected/);
    const { tool: alone, context: nowhere } = await turn({ ...wired, wires: seedStage.wires });
    await expect(alone.run(film as unknown as Record<string, unknown>, nowhere)).rejects.toThrow(/no video studio is connected to your room/);
  });

  it('falls back to the switches the founder set on the card for whatever the person left out', async () => {
    const asks: VideoAsk[] = [];
    const spy: Maker = { ...fakeVideos, make: (ask, help) => { asks.push(ask as VideoAsk); return fakeVideos.make(ask, help); } };
    const dir = await mkdtemp(join(tmpdir(), 'videotool-'));
    const store = createStore(dir);
    const media = createMedia({ dir, store, makers: { videogen: [spy] } });
    const tool = mediaTools(media).find((one) => one.name === 'generate_video')!;
    const off: Stage = { ...wired, cards: [{ id: 'studio-3', kind: 'videogen', x: 0, y: 0, w: 1, h: 1, captions: 'off', sfx: 'off', silent: true }] };
    const context = { stage: off, roomId: 'marketing', store, granted: new Map<string, string>() };
    await tool.run({ ...film }, context);
    expect(asks[0]).toMatchObject({ captions: false, sfx: false, narrate: false });
    // What the person says outright still wins over the card.
    await tool.run({ ...film, narrate: true, sfx: true }, context);
    expect(asks[1]).toMatchObject({ captions: false, sfx: true, narrate: true });
    // A card left on Auto leaves captions to the director, and sound and narration on.
    const auto: Stage = { ...wired, cards: [{ id: 'studio-3', kind: 'videogen', x: 0, y: 0, w: 1, h: 1, captions: 'on' }] };
    await tool.run({ ...film }, { ...context, stage: auto });
    expect(asks[2]).toMatchObject({ captions: true, narrate: true });
    expect(asks[2].sfx).toBeUndefined();
  });

  it('keeps its parameters flat and simple, the way every provider accepts them', async () => {
    const { tool } = await turn(wired);
    const properties = (tool.parameters as { properties: Record<string, { type: string; enum?: string[] }> }).properties;
    expect(Object.keys(properties).sort()).toEqual(['brief', 'captions', 'format', 'images', 'length', 'look', 'music', 'narrate', 'pace', 'purpose', 'scenes', 'sfx', 'title']);
    expect(properties.look.enum).toEqual(['clean', 'creator', 'editorial', 'neon', 'documentary', 'sketch', 'brand']);
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
      title: 'A launch', pace: 'punchy', music: 'upbeat', captions: true, sfx: false,
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
    expect(read.music).toBe('upbeat');
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
    const many = Array(MAX_IMAGES + 1).fill(0).map((_, at) => ({ layout: 'picture' as const, image_prompt: `a kite ${at}`, text: `Kite ${at}` }));
    const { spec, notes } = withinCaps({ title: 'Kites', scenes: many }, { ai: true, assets: [] });
    expect(spec.scenes.filter((one) => one.layout === 'picture')).toHaveLength(MAX_IMAGES);
    // What it would have drawn in front of the words is drawn behind them instead: the scene still has something.
    expect(spec.scenes.at(-1)).toEqual({ layout: 'statement', text: `Kite ${MAX_IMAGES}`, heading: undefined, image_prompt: undefined, bg_prompt: `a kite ${MAX_IMAGES}` });
    expect(notes[0]).toContain(`at most ${MAX_IMAGES} in front of the words`);
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

  it('never sets the reason something failed across the frame', () => {
    // A real launch film rendered "nothing to show" as its headline on ten frames of sixteen, because the reason a
    // picture never arrived was handed to the scene as its words. A founder's film says nothing it was not given.
    const { spec, notes } = withinCaps({ title: 'One', scenes: [
      { layout: 'clip', clip_prompt: 'a kite over a field', say: 'A kite goes up.' },
      { layout: 'device', asset: 'nothing-by-that-name', say: 'Here it is.' },
    ] }, { ai: false, assets: [] });
    for (const scene of spec.scenes) {
      const shown = [scene.heading, scene.text, ...(scene.bullets ?? [])].filter(Boolean).join(' ');
      expect(shown).not.toMatch(/switched off|nothing on the card|at most/i);
    }
    // The founder is told, on the card, in both cases.
    expect(notes.join(' ')).toContain('AI clips are switched off');
    expect(notes.join(' ')).toContain('nothing on the card by that name');
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
    const reelMind = understandingOf({}, { brief: 'launch the studio', purpose: 'reel' }, {});
    const plan: Plan = { angle: 'the handover is the bug', hook: 'Your handover is the bug', bible: bibleFor(reelMind), beats: [{ beat: 'name it', on_screen: 'a desk', say: 'Design hands to build and a day goes missing.' }] };
    const layouts = layoutsFor({ ai: false, material });
    const reel = specPrompt(plan, reelMind, material, layouts);
    expect(reel).toContain('30-second vertical film');
    expect(reel).toContain('the handover is the bug');
    expect(reel).toContain('Your handover is the bug');
    expect(reel).toContain(plan.bible);
    expect(reel).toContain("- walk — 6 seconds of the founder's own footage");
    expect(reel).toContain('1. name it — on screen: a desk');
    // Nothing offers a layout the film cannot actually fill.
    expect(reel).toContain('- footage:');
    expect(reel).not.toContain('- clip:');
    expect(reel).not.toContain('- device:');
    // The rules the storyboard will be read against are told to it before it is written.
    expect(reel).toContain('The first scene is a hook and the last is a cta.');
    expect(reel).toContain('At least four different layouts');

    const empty: Material = { lines: [], assets: [], using: [] };
    const pitchMind = understandingOf({}, { brief: 'raise a seed round', purpose: 'pitch' }, {});
    const pitchPlan: Plan = { angle: 'we have the traction', hook: 'Ten thousand teams', bible: bibleFor(pitchMind), beats: [] };
    expect(planPrompt(pitchMind, { brief: 'raise a seed round', purpose: 'pitch' }, empty)).toContain('90-second investor pitch');
    expect(planPrompt(pitchMind, { brief: 'raise a seed round', purpose: 'pitch' }, empty)).toContain(PURPOSE.pitch.shape);
    const pitch = specPrompt(pitchPlan, pitchMind, empty, layoutsFor({ ai: true, material: empty }));
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
        'class="device device--', 'class="cta', 'frame--logo', 'class="reel reel--face"', 'class="mark"', 'class="step"']) expect(page, `${shape}: ${mark}`).toContain(mark);
      // A moving picture is an element of the film in its own right, not a tag inside a timed section: the renderer
      // resolves a nested one against the wrong clock and shows the wrong frames.
      expect(page).toContain('<video id="v13" class="reel" src="assets/cut-13.mp4" playsinline muted data-start=');
      expect(page).toContain('<video id="v15" class="reel reel--face" src="assets/pres-15.mp4" playsinline muted data-start=');
      expect(page.indexOf('<video id="v13"')).toBeLessThan(page.indexOf('<section class="clip" id="s0"'));
      expect(page.match(/<section class="clip"/g)).toHaveLength(17);
    }
    // A tall frame takes a phone and a wide one a browser, unless the storyboard said which.
    expect(composition({ title: 'One', shape: 'tall', look: 'clean', shots: shots([{ layout: 'device', asset: 'a' }]) })).toContain('device--phone');
    expect(composition({ title: 'One', shape: 'wide', look: 'clean', shots: shots([{ layout: 'device', asset: 'a' }]) })).toContain('device--browser');
  });

  it('wears a declared format where a look has one, on the pictures and never over the type', () => {
    // The documentary look is the one place a grade belongs: letterbox bars painted once for the whole render,
    // and a measured tune applied to the moving and still pictures. Nothing touches the words.
    const page = composition({ title: 'One', shape: 'wide', look: 'documentary', shots: shots(film.scenes) });
    expect(page).toContain('<div class="bar bar--top"></div>');
    expect(page).toContain('<div class="bar bar--foot"></div>');
    // The lift in front of the grade is measured per picture and is 1 wherever nothing needed lifting, so a film
    // whose stills came back readable wears exactly the pack's own tune and nothing else.
    expect(page).toContain('.bg img, .shot img, .shot video, .reel, .device__glass img { filter: brightness(var(--raise, 1)) saturate(0.94) contrast(1.03); }');
    // The bars are a frame, not a move: nothing on the timeline touches them.
    expect(page).not.toContain('"#bar,');
    expect(page).not.toMatch(/tl\.[a-z]+\("\.bar/);
    // And every other look declares no format at all, so it has neither.
    for (const look of PACKS.filter((one) => one !== 'documentary')) {
      expect(composition({ title: 'One', shape: 'wide', look, shots: shots(film.scenes) }), look).not.toContain('class="bar bar--top"');
    }
  });

  it('puts no filter, grain or vignette over the frame in any pack', () => {
    // The founder's verdict on the last film was "obvious filter". There was one, over every frame of every film:
    // a grain layer and a vignette layer above the whole composite. Both are gone, and no pack brings them back.
    for (const look of PACKS) {
      const page = composition({ title: 'One', shape: 'tall', look, pace: 'punchy', shots: shots(film.scenes) });
      expect(page, look).not.toContain('class="grain"');
      expect(page, look).not.toContain('class="vig"');
      expect(page, look).not.toContain('feTurbulence');
    }
  });

  it("keeps a piece of the founder's own sound only where the scene asked for it", () => {
    const loud = shots([{ layout: 'footage', asset: 'walk', mute: false, start: 3.5 }]);
    loud[0].video = 'cut-0.mp4';
    const page = composition({ title: 'One', shape: 'wide', look: 'clean', shots: loud });
    expect(page).toContain('data-media-start="3.50"');
    expect(page).toContain('data-has-audio="true" data-volume="0.85"');
    expect(page).not.toContain('playsinline muted');
    // Its window on the film's clock is the scene's own, so the renderer knows exactly which frames to pull.
    expect(page).toContain('data-start="0" data-duration="4.00"');
  });

  it('moves twice as fast when the founder asked it to', () => {
    const calm = composition({ title: 'One', shape: 'wide', look: 'clean', pace: 'calm', shots: shots(film.scenes) });
    const punchy = composition({ title: 'One', shape: 'wide', look: 'clean', pace: 'punchy', shots: shots(film.scenes) });
    expect(calm).toContain('duration: 0.92, ease: "expo.out", stagger: 0.1');
    expect(punchy).toContain('duration: 0.52, ease: "power3.out", stagger: 0.05');
    // The same words are held for longer when there is room for them.
    expect(sceneSeconds('one two three four five six', 0, 'calm')).toBeGreaterThan(sceneSeconds('one two three four five six', 0, 'punchy'));
    expect(sceneSeconds('', 0, 'punchy')).toBe(1.6);
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
    // A face whose file could not be found is not named at all: the renderer cannot supply it, and saying its name
    // only earns an error in the check.
    const unnamed = composition({ title: 'One', shape: 'wide', look: 'brand', brand: { colours: ['#0e1117', '#4e8cff'], font: 'Inter Variable' }, shots: shots(film.scenes) });
    expect(unnamed).toContain("font-family: 'Studio Sans', sans-serif;");
    expect(unnamed).not.toContain('Inter Variable');
    expect(brand).toContain("src: url('vendor/Satoshi.woff2')");
  });
});

describe('the scenes that cost something', () => {
  const wiredWith = (ai: boolean): Stage => ({
    ...seedStage,
    cards: [{ id: 'studio-3', kind: 'videogen', ai: ai ? 'on' : 'off', x: 0, y: 0, w: 1, h: 1 }],
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

describe('how long a film comes out', () => {
  it('tells the storyboard its word budget, because the narration is what sets the length', () => {
    expect(wordsFor(30)).toBe(72);
    expect(wordsFor(90)).toBe(216);
    // And the budget the director really works to takes the breath before every line and the beat after it off the
    // top, which is the three and a half seconds that made fifteen come out at eighteen.
    expect(budgetOf(30, 10, 'punchy')).toBe(62);
    expect(budgetOf(15, 6, 'punchy')).toBe(30);
    expect(budgetOf(15, 6, 'punchy')).toBeLessThan(wordsFor(15));
    const mind = understandingOf({}, { brief: 'x', purpose: 'reel' }, {});
    const brief = planPrompt(mind, { brief: 'x', purpose: 'reel' }, { lines: [], assets: [], using: [] });
    expect(brief).toContain('words — that is what makes the film 30 seconds long');
  });

  it('cuts a film that still overruns badly, from the middle and never the opening or the close', () => {
    const shots = [12, 12, 12, 12, 12, 12].map((one, at) => ({ seconds: one + at * 0.1 }));
    const held = withinLength(shots, 30);
    expect(held.dropped).toBe(2);
    expect(held.shots).toHaveLength(4);
    // The opener stays, and so do the two that close it.
    expect(held.shots[0]).toBe(shots[0]);
    expect(held.shots.at(-1)).toBe(shots.at(-1));
    expect(held.shots.at(-2)).toBe(shots.at(-2));
    // The longest of what was actually in the middle went first.
    expect(held.shots).not.toContain(shots[3]);
    expect(held.shots).not.toContain(shots[2]);
  });

  it('leaves a film that is near enough, and a short one, exactly as it is', () => {
    // Within a tenth of what was asked for is near enough; past that a scene goes.
    const near = [6, 6, 6, 6, 6].map((seconds) => ({ seconds }));
    expect(withinLength(near, 30).dropped).toBe(0);
    expect(withinLength([{ seconds: 60 }, { seconds: 60 }], 15).dropped).toBe(0);
    // A storyboard a person wrote themselves is never cut: they said what they wanted.
    expect(withinLength(near, 0).dropped).toBe(0);
  });
});

describe('how many moving shots a film may have', () => {
  it('allows twice as many when they are made here, because here costs only time', () => {
    const six = { title: 'One', scenes: Array(6).fill(0).map((_, at) => ({ layout: 'clip' as const, clip_prompt: `a kite ${at}`, text: `Kite ${at}` })) };
    const online = withinCaps(six, { ai: true, assets: [], most: MAX_AI });
    expect(online.spec.scenes.filter((one) => one.layout === 'clip')).toHaveLength(MAX_AI);
    const here = withinCaps(six, { ai: true, assets: [], most: MAX_LOCAL_AI });
    expect(here.spec.scenes.filter((one) => one.layout === 'clip')).toHaveLength(MAX_LOCAL_AI);
    expect(here.spec.scenes.filter((one) => one.layout === 'picture')).toHaveLength(6 - MAX_LOCAL_AI);
  });

  it('asks the founder only when something would really go out and be spent', async () => {
    // A clip made on this machine spends nothing, so nothing is asked.
    expect(spendingScenes([{ layout: 'clip' }, { layout: 'clip' }], true)).toEqual([]);
    expect(spendingScenes([{ layout: 'clip' }, { layout: 'clip' }], false)).toEqual(['clip', 'clip']);
    // A talking head always goes out, whatever this machine can do.
    expect(spendingScenes([{ layout: 'clip' }, { layout: 'presenter' }], true)).toEqual(['presenter']);
  });
});

describe('what a film is allowed to draw on', () => {
  // The founder's own stage, card for card: an image studio feeding a picture card, the picture card feeding the
  // video studio, and Sam wired to all three. The film that came out of it gathered nothing at all.
  const stage = {
    rooms: [{ id: 'sam', name: 'Sam', role: 'content', brief: '', accent: '#f0b35a', x: 0, y: 0, w: 1, h: 1 }],
    docs: [{ id: 'brief-doc', title: 'The brief', x: 0, y: 0, w: 1, h: 1 }],
    cards: [
      { id: 'video', kind: 'videogen' as const, x: 0, y: 0, w: 1, h: 1 },
      { id: 'picture', kind: 'image' as const, x: 0, y: 0, w: 1, h: 1 },
      { id: 'studio', kind: 'imagegen' as const, x: 0, y: 0, w: 1, h: 1 },
      { id: 'browser', kind: 'browser' as const, x: 0, y: 0, w: 1, h: 1 },
      { id: 'note', kind: 'note' as const, text: 'A thought', x: 0, y: 0, w: 1, h: 1 },
      { id: 'elsewhere', kind: 'imagegen' as const, x: 0, y: 0, w: 1, h: 1 },
    ],
    wires: [
      { id: 'w1', from: 'picture', fromHandle: 'r', to: 'video', toHandle: 'l' },
      { id: 'w2', from: 'studio', fromHandle: 'r', to: 'picture', toHandle: 'l' },
      { id: 'w3', from: 'sam', fromHandle: 'r', to: 'note', toHandle: 'l' },
      { id: 'w4', from: 'sam', fromHandle: 'r', to: 'browser', toHandle: 'l' },
      { id: 'w5', from: 'sam', fromHandle: 'r', to: 'brief-doc', toHandle: 'l' },
    ],
  };

  it('reaches what is wired to the studio, and one hop behind a picture card', () => {
    // Without the second reach the studio that drew the picture is invisible, which is the whole of the bug.
    expect(sourcesFor(stage, 'video').map((one) => one.id).sort()).toEqual(['picture', 'studio']);
  });

  it('carries what is wired to whoever is making the film', () => {
    const found = sourcesFor(stage, 'video', 'sam').map((one) => one.id).sort();
    // A browser card of theirs is the page they were pointed at, so the film photographs it too; a studio wired
    // to nobody is nobody's.
    expect(found).toEqual(['browser', 'note', 'picture', 'studio']);
    expect(found).not.toContain('elsewhere');
  });

  it('names nothing twice and never the studio itself', () => {
    const both = { ...stage, wires: [...stage.wires, { id: 'w6', from: 'sam', fromHandle: 'r', to: 'video', toHandle: 'l' }, { id: 'w7', from: 'sam', fromHandle: 'r', to: 'picture', toHandle: 'l' }] };
    const found = sourcesFor(both, 'video', 'sam').map((one) => one.id);
    expect(found).toHaveLength(new Set(found).size);
    expect(found).not.toContain('video');
  });

  it('reads the documents wired to the studio and to whoever asked', () => {
    expect(docsFor(stage, 'video')).toEqual([]);
    expect(docsFor(stage, 'video', 'sam')).toEqual(['brief-doc']);
  });

  it('reads every pinned doc, wired or not, and the docs that person wrote this turn', () => {
    const pinned = { ...stage, docs: [...stage.docs, { id: 'company', title: 'Company', pinned: true, x: 0, y: 0, w: 1, h: 1 }] };
    expect(docsFor(pinned, 'video')).toEqual(['company']);
    expect(docsFor(pinned, 'video', 'sam', ['doc-new', 'company'])).toEqual(['brief-doc', 'company', 'doc-new']);
  });
});

describe('the founder asking for a picture in the film', () => {
  it('hears the words a founder uses, and nothing else', () => {
    // A person told this and calling the video tool with no picture has not disobeyed — it has not noticed.
    expect(meansAPicture('15 second clip of influencer talking abt what investors look for real face')).toBe(true);
    expect(meansAPicture('generate an image and use that in the video')).toBe(true);
    expect(meansAPicture('use the one you just made')).toBe(true);
    expect(meansAPicture('a 30 second launch film for the product')).toBe(false);
    expect(meansAPicture('make it punchy and put music under it')).toBe(false);
  });
});

describe('a picture scene with no picture', () => {
  it('points no image at nothing, because that is a 404 and a blank rectangle', () => {
    const page = composition({
      title: 'One', shape: 'wide', look: 'clean',
      shots: [{ scene: { layout: 'picture', image_prompt: 'a bare table', text: 'A bare table' }, seconds: 3 }],
    });
    expect(page).not.toContain('assets/undefined');
    expect(page).not.toMatch(/<img src="assets\/"/);
    // It still writes whatever words it had, so the scene is not three seconds of nothing.
    expect(page).toContain('A bare table');
  });

  it('shows the picture where there is one', () => {
    const page = composition({
      title: 'One', shape: 'wide', look: 'clean',
      shots: [{ scene: { layout: 'picture', image_prompt: 'a bare table' }, image: 'shot-0.png', seconds: 3 }],
    });
    expect(page).toContain('assets/shot-0.png');
  });
});

describe('two systems of type in one band', () => {
  const listy = { layout: 'checklist', heading: 'What you get', bullets: ['A number that moved', 'A story that holds'], say: 'Two things matter to them.' } as Scene;
  const plain = { layout: 'statement', text: 'What they really want', say: 'Investors want proof, not promises.' } as Scene;

  it('takes the captions off a scene whose own type grows into the caption band', () => {
    expect(crowdsCaptions(listy)).toBe(true);
    expect(crowdsCaptions(plain)).toBe(false);
    expect(crowdsCaptions({ layout: 'checklist' } as Scene)).toBe(false);
    // A quotation's attribution hangs below it, at the bottom of the block, which is where the band starts. The
    // renderer's own check caught "— LEAD INVESTOR" overlapping the word being said.
    expect(crowdsCaptions({ layout: 'quote', text: 'It just works.', heading: 'Lead investor' } as Scene)).toBe(true);
    expect(crowdsCaptions({ layout: 'quote', text: 'It just works.' } as Scene)).toBe(false);
  });

  it('leaves the band empty for the length of that scene', () => {
    const page = composition({
      title: 'One', shape: 'tall', look: 'creator', captions: true,
      words: [{ word: 'Two', at: 0.2, seconds: 0.3 }, { word: 'things', at: 0.5, seconds: 0.4 }, { word: 'matter.', at: 0.9, seconds: 0.4 }],
      shots: [{ scene: listy, seconds: 3 }],
    });
    expect(page).not.toContain('class="capline"');
    expect(page).not.toContain('class="regcaps"');
  });

  it('keeps them where the scene puts one block of type above the band', () => {
    const page = composition({
      title: 'One', shape: 'tall', look: 'creator', captions: true,
      words: [{ word: 'Investors', at: 0.2, seconds: 0.3 }, { word: 'want', at: 0.5, seconds: 0.4 }, { word: 'proof.', at: 0.9, seconds: 0.4 }],
      shots: [{ scene: plain, seconds: 3 }],
    });
    // The creator pack draws its captions with the registry's highlight component.
    expect(page).toContain('class="regcaps"');
  });
});

describe('a list is read a line at a time', () => {
  it('gives every line a beat of its own rather than one stagger', () => {
    const page = composition({
      title: 'One', shape: 'wide', look: 'documentary',
      shots: [{ scene: { layout: 'steps', heading: 'How it goes', bullets: ['Map the audience', 'Measure real intent', 'Then build'] } as Scene, seconds: 6 }],
    });
    for (const line of [1, 2, 3]) expect(page).toContain(`#s0 .one-at-a-time:nth-child(${line})`);
    // …and the generic entrance leaves them alone, or every line arrives twice.
    expect(page).toContain('#s0 .rise:not(.one-at-a-time)');
  });

  it('spreads them across the scene rather than across a tenth of a second', () => {
    const page = composition({
      title: 'One', shape: 'wide', look: 'documentary',
      shots: [{ scene: { layout: 'checklist', heading: 'What you get', bullets: ['One', 'Two', 'Three'] } as Scene, seconds: 6 }],
    });
    const at = [...page.matchAll(/one-at-a-time:nth-child\(\d\)"[^;]*?, ([\d.]+)\);/g)].map((one) => Number(one[1]));
    expect(at).toHaveLength(3);
    expect(at[2] - at[0]).toBeGreaterThan(1);
  });
});

describe('pictures that start before the cut is measured', () => {
  it('draws three at a time however they arrive, and hands a free place straight to whoever is waiting', async () => {
    const inHand = hands(3);
    let busy = 0;
    let most = 0;
    const finished: number[] = [];
    const job = (name: number, ticks: number) => inHand(async () => {
      busy += 1;
      most = Math.max(most, busy);
      for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
      busy -= 1;
      finished.push(name);
      return name;
    });
    // The first lot, as the guessed cut asks for them — and two more once the measured cut arrives.
    const early = [job(0, 5), job(1, 1), job(2, 3), job(3, 1)];
    await Promise.resolve();
    const late = [job(4, 1), job(5, 1)];
    expect(await Promise.all([...early, ...late])).toEqual([0, 1, 2, 3, 4, 5]);
    expect(most).toBe(3);
    expect(finished).toHaveLength(6);
  });

  it('keeps going after one of them fails, because a picture that could not be drawn is a texture and not the end', async () => {
    const inHand = hands(1);
    await expect(inHand(async () => { throw new Error('no picture'); })).rejects.toThrow('no picture');
    expect(await inHand(async () => 'the next one')).toBe('the next one');
  });

  it('says a draft is a draft in minutes: a few for the quick one, most of ten for the film drawn here', () => {
    const film = { scenes: 5, seconds: 15, clips: 0, narrate: true, here: true };
    const minutes = (said: string) => Number(/about (\d+) minute/.exec(said)?.[1]);
    expect(minutes(estimate({ ...film, pictures: 3, draft: true }))).toBeLessThanOrEqual(3);
    expect(minutes(estimate({ ...film, pictures: 7 }))).toBeGreaterThanOrEqual(6);
  });
});

describe('the film clock', () => {
  it('starts each shot where the last ended, to the hundredth, and quiets captions only where a scene writes its line out', () => {
    const cut = shots([{ layout: 'hook', text: 'Ship on Fridays.', say: 'Ship on Fridays.' }, { layout: 'statement', text: 'Quiet', say: 'Something else entirely is said here.' }]);
    cut[0].seconds = 1.333;
    cut[1].seconds = 2.004;
    const { starts, total } = startsOf(cut);
    expect(starts).toEqual([0, 1.33]);
    expect(total).toBe(3.33);
    expect(quietOf(cut, starts)).toEqual([{ at: 0, seconds: 1.333 }]);
  });
});
