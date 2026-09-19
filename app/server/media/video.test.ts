import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedStage, type Stage } from '../../shared/model.ts';
import { createStore } from '../store.ts';
import { mediaTools } from '../tools/media.ts';
import { createMedia } from './jobs.ts';
import { composition, FORMATS, sceneSeconds, type Shot } from './templates/index.ts';
import { fakeVideos, parseSpec, storyboardOf, type Scene, type Spec } from './video.ts';

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
    expect(() => parseSpec({ title: 'One', scenes: Array(11).fill(film.scenes[0]) })).toThrow('at most 10 scenes, not 11');
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'montage' }] })).toThrow('scene 1: "layout" must be one of title, statement, bullets, picture, stat, quote, outro');
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'title' }] })).toThrow('scene 1: a title scene needs "heading"');
    expect(() => parseSpec({ title: 'One', scenes: [film.scenes[0], { layout: 'statement' }] })).toThrow('scene 2: a statement scene needs "text"');
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'bullets', heading: 'Two' }] })).toThrow('scene 1: a bullets scene needs "bullets"');
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'bullets', bullets: Array(7).fill('one') }] })).toThrow('at most 6 bullets fit on screen, not 7');
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'picture', image_prompt: 'a kite' }] })).toThrow('scene 1: a picture scene needs "image_prompt" and a caption in "text"');
    expect(() => parseSpec({ title: 'One', scenes: [{ layout: 'statement', text: 'x'.repeat(241) }] })).toThrow('scene 1: "text" is too long (241 characters, limit 240)');
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
    expect(sketch).toContain('markSteps(tl, marksOf(SCENE_AT));');
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
    expect(Object.keys(properties).sort()).toEqual(['format', 'look', 'narrate', 'scenes', 'title']);
    expect(properties.look.enum).toEqual(['clean', 'sketch']);
    expect(properties.format.enum).toEqual(['square', 'wide', 'tall']);
  });
});
