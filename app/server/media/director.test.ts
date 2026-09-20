import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedStage, type Stage } from '../../shared/model.ts';
import { criticise, drawnWord, photographic } from './critic.ts';
import {
  bibleFor, direct, faceIn, onCamera, showsSomebody, layoutsFor, planOf, readBrief, secondsIn, specFromPlan, tellOf, understandingOf,
  type Material, type Plan, type Understanding,
} from './director.ts';
import { countWords, saidWords, type Scene, type Spec } from './spec.ts';
import { sourcesOf } from './grounding.ts';
import { gather, type VideoDeps } from './video.ts';

const nothing: Material = { lines: [], assets: [], using: [] };

describe('reading the brief itself', () => {
  it('finds how long the founder actually asked for', () => {
    expect(secondsIn('15 second clip of an influencer')).toBe(15);
    expect(secondsIn('a 30-second spot')).toBe(30);
    expect(secondsIn('make it 45s')).toBe(45);
    expect(secondsIn('about a minute on what we shipped')).toBe(60);
    expect(secondsIn('half a minute')).toBe(30);
    expect(secondsIn('thirty seconds of it')).toBe(30);
    expect(secondsIn('no length in here')).toBeUndefined();
    // Nothing absurd: a number that is not a length is not read as one.
    expect(secondsIn('our 2024 numbers')).toBeUndefined();
  });

  it("reads the founder's own brief, word for word, before any model is asked anything", () => {
    // This is the brief that made the film the founder rejected.
    const read = readBrief('15 second clip of influencer talking abt what investors look for in a new company');
    expect(read).toMatchObject({ purpose: 'reel', shape: 'tall', pace: 'punchy', pack: 'creator', captions: true, seconds: 15, person: true });
  });

  it('reads the other kinds too, and says nothing it was not told', () => {
    expect(readBrief('a calm editorial quote piece, 20 seconds')).toMatchObject({ pace: 'calm', pack: 'editorial', seconds: 20 });
    expect(readBrief('a 30 second product launch video for this repo')).toMatchObject({ purpose: 'launch', pace: 'punchy', seconds: 30 });
    expect(readBrief('an investor pitch')).toMatchObject({ purpose: 'pitch', shape: 'wide', pace: 'calm' });
    expect(readBrief('something about our product')).toEqual({});
  });
});

describe('what the director understood', () => {
  it('fills everything the founder left on Auto out of the brief, and says so in plain words', () => {
    const read = readBrief('15 second clip of influencer talking abt what investors look for');
    const mind = understandingOf({ audience: 'first-time founders', platform: 'tiktok', tone: 'blunt and quick', why: 'a scroll-stopping reel' }, { brief: 'x' }, read);
    expect(mind).toMatchObject({ purpose: 'reel', shape: 'tall', seconds: 15, pace: 'punchy', pack: 'creator', person: true, captions: true });
    expect(mind.audience).toBe('first-time founders');
    expect(mind.said).toContain('reading the brief: a 15-second vertical influencer-style reel');
    expect(mind.said).toContain('cut fast');
    expect(mind.said).toContain('a scroll-stopping reel');
  });

  it('obeys every picker the founder actually set, and overrules the model with it', () => {
    const asked = { brief: 'a quick reel', purpose: 'pitch' as const, seconds: 45, shape: 'wide' as const, pace: 'calm' as const, pack: 'editorial' as const, music: 'warm' as const };
    const mind = understandingOf({ purpose: 'reel', format: 'tall', seconds: 15, pace: 'punchy', look: 'creator', music: 'drive' }, asked, readBrief(asked.brief));
    expect(mind).toMatchObject({ purpose: 'pitch', shape: 'wide', seconds: 45, pace: 'calm', pack: 'editorial', mood: 'warm' });
  });

  it('falls back to what the purpose has always meant when nobody said anything at all', () => {
    const mind = understandingOf({}, { brief: 'something about our product' }, {});
    expect(mind).toMatchObject({ purpose: 'explainer', shape: 'wide', seconds: 60, pace: 'calm', pack: 'clean', captions: false });
    expect(tellOf(mind)).toContain('60-second widescreen product explainer');
  });

  it('never takes a nonsense answer from a model', () => {
    const mind = understandingOf({ purpose: 'a lovely film', format: 'cinemascope', seconds: 4000, pace: 'quick', look: 'shiny', music: 'techno' }, { brief: 'a 20 second reel' }, readBrief('a 20 second reel'));
    expect(mind.seconds).toBe(20);
    expect(mind.purpose).toBe('reel');
    expect(mind.shape).toBe('tall');
    expect(['calm', 'punchy']).toContain(mind.pace);
  });
});

describe('the style bible', () => {
  it('gives every pack a look its pictures can all share', () => {
    for (const pack of ['creator', 'editorial', 'neon', 'clean', 'sketch', 'brand'] as const) {
      const bible = bibleFor({ ...understandingOf({}, { brief: 'x' }, {}), pack });
      expect(bible.length).toBeGreaterThan(30);
      // A bible describes a look and names no subject, because it is pasted in front of every subject there is.
      expect(bible).not.toMatch(/\b(investor|founder|product|team)\b/);
    }
  });

  it('never gives a photographed film a word that asks for a drawing', () => {
    // The fault this stops: one scene of a real fifteen-second reel came back a 3-D cartoon character standing
    // beside four photographs, and a film with two looks has none.
    for (const pack of ['creator', 'editorial', 'neon', 'clean', 'brand'] as const) {
      const bible = bibleFor({ ...understandingOf({}, { brief: 'x' }, {}), pack });
      expect(drawnWord(bible)).toBeNull();
      // And it says what it is shot on and in what light, which is the whole of what a picture model needs.
      expect(photographic(bible)).toBe(true);
    }
    // The notebook is drawn by hand on purpose and keeps its own look.
    expect(drawnWord(bibleFor({ ...understandingOf({}, { brief: 'x' }, {}), pack: 'sketch' }))).not.toBeNull();
  });

  it('throws away a look the model wrote that is not the look this film is in', () => {
    const mind = { ...understandingOf({}, { brief: 'x' }, {}), pack: 'clean' as const };
    const wrote = (line: string, understanding: Understanding = mind) => planOf({ style_bible: line, beats: [] }, understanding, { brief: 'x' }).bible;
    // A model asked for visual direction writes a mood as often as a medium, and it will write the drawn look
    // straight into the line that was supposed to stop one.
    expect(wrote('modern, dynamic and bold with 3d rendered characters')).toBe(bibleFor(mind));
    expect(wrote('a vibrant and energetic feel throughout')).toBe(bibleFor(mind));
    // A line that really is a look is the film's own, and it is kept.
    expect(wrote('quiet documentary photography, soft window light, muted warm palette')).toContain('documentary');
    // A notebook film handed a photographer's line keeps its hand-drawn one instead.
    const notebook = { ...mind, pack: 'sketch' as const };
    expect(wrote('calm studio photography, soft directional light, matte surfaces', notebook)).toBe(bibleFor(notebook));
  });
});

describe('the net under the storyboard', () => {
  const mind: Understanding = { ...understandingOf({}, { brief: 'a 15 second reel' }, readBrief('a 15 second reel')) };
  const plan: Plan = {
    angle: 'what investors really check',
    hook: 'Investors check one thing',
    bible: 'high-contrast editorial photography, deep shadows',
    beats: [
      { beat: 'stop them', on_screen: 'a founder mid-pitch', say: 'Investors check one thing first.' },
      { beat: 'the number', on_screen: 'an empty room', say: 'Only 12% get a second meeting.' },
      { beat: 'the list', on_screen: 'a whiteboard', say: 'A problem, a team, some early pull.' },
      { beat: 'the turn', on_screen: 'two desks', say: 'They hear a vision but they fund a product.' },
      { beat: 'the ask', on_screen: 'a phone', say: 'Follow for more.' },
    ],
  };

  it('builds a whole film out of the plan when the model will not write a storyboard at all', () => {
    const spec = specFromPlan(plan, mind, layoutsFor({ ai: false, material: nothing }));
    expect(spec.scenes).toHaveLength(5);
    expect(spec.scenes[0].layout).toBe('hook');
    expect(spec.scenes.at(-1)!.layout).toBe('cta');
    // The shapes come out of what the beats actually say, not out of a rota.
    expect(spec.scenes.map((one) => one.layout)).toContain('stat');
    expect(spec.scenes.map((one) => one.layout)).toContain('checklist');
    expect(spec.scenes.map((one) => one.layout)).toContain('compare');
    // Every scene has something to look at, and every picture is prefixed with the film's own style bible.
    for (const scene of spec.scenes) expect(scene.bg_prompt ?? scene.image_prompt).toContain('high-contrast editorial photography');
  });
});

describe('the whole direction, end to end', () => {
  // A model that answers the way the weak free ones really do: a shrug at the first two passes and, for the
  // storyboard, the exact failure the founder was handed.
  const lazyModel = async (prompt: string) => {
    if (prompt.includes('say what is actually being asked for')) return '{"audience": "founders", "platform": "tiktok", "tone": "blunt", "why": "a reel"}';
    if (prompt.includes('decide what this film is actually going to do')) {
      return JSON.stringify({
        angle: 'investors fund traction', hook: 'Investors check one thing', style_bible: 'gritty documentary photography, hard side light',
        beats: [{ beat: 'a', on_screen: 'a desk', say: 'Investors look at whether there is a real problem being solved and whether the team can ship it.' },
          { beat: 'b', on_screen: 'a desk', say: 'They also want to see traction, which means real people using the thing every single week.' },
          { beat: 'c', on_screen: 'a desk', say: 'And finally they look at the market, the timing, and whether you are the person to do it.' }],
      });
    }
    // The storyboard: three identical scenes with the whole narration written on screen.
    return JSON.stringify({
      title: 'What investors look for',
      scenes: [
        { layout: 'statement', text: 'Investors look at whether there is a real problem being solved and whether the team can ship it.', say: 'Investors look at whether there is a real problem being solved and whether the team can ship it.' },
        { layout: 'statement', text: 'They also want to see traction, which means real people using the thing every single week.', say: 'They also want to see traction, which means real people using the thing every single week.' },
        { layout: 'statement', text: 'And finally they look at the market, the timing, and whether you are the person to do it.', say: 'And finally they look at the market, the timing, and whether you are the person to do it.' },
      ],
    });
  };

  it("turns the founder's own rejected run into something a critic has nothing to say about", async () => {
    const said: string[] = [];
    const made = await direct({ brief: '15 second clip of influencer talking abt what investors look for in a new company' }, nothing, lazyModel, { report: (line) => said.push(line) });
    expect(made.understanding).toMatchObject({ purpose: 'reel', shape: 'tall', seconds: 15, pace: 'punchy', pack: 'creator', person: true, captions: true });
    expect(made.spec.scenes[0].layout).toBe('hook');
    expect(made.spec.scenes.at(-1)!.layout).toBe('cta');
    expect(made.spec.scenes.every((one) => one.bg_prompt || one.image_prompt || one.asset)).toBe(true);
    for (const scene of made.spec.scenes) expect(countWords(scene.text)).toBeLessThanOrEqual(12);
    // Fifteen seconds of narration, not the thirty the model wrote.
    expect(saidWords(made.spec)).toBeLessThanOrEqual(36);
    // Every decision is on the card, in words a founder reads rather than a log line.
    expect(said[0]).toContain('reading the brief: a 15-second vertical influencer-style reel');
    expect(said.some((line) => line.startsWith('the angle:'))).toBe(true);
    expect(said.some((line) => line.includes('did not hold up'))).toBe(true);
    expect(said.at(-1)).toMatch(/^\d+ scenes, about \d+ words said: /);
  });

  it('makes a film even when the model answers nothing at all, twice', async () => {
    const silent = async () => 'I am afraid I cannot help with that.';
    const made = await direct({ brief: 'a 20 second calm editorial piece about slowing down' }, nothing, silent, { report: () => {} });
    expect(made.understanding).toMatchObject({ seconds: 20, pace: 'calm', pack: 'editorial' });
    expect(made.spec.scenes.length).toBeGreaterThan(0);
    expect(made.spec.title.length).toBeGreaterThan(0);
  });

  it('takes the good storyboard a good model writes and leaves it alone', async () => {
    const good: Spec = {
      title: 'What investors check',
      scenes: [
        { layout: 'hook', text: 'Investors check one thing', say: 'Investors check one thing first.', bg_prompt: 'a founder mid-pitch' },
        { layout: 'stat', heading: '12%', text: 'get a second meeting', say: 'Only twelve per cent get a second meeting.', bg_prompt: 'an empty meeting room', source: 'Only twelve per cent of decks get a second meeting' },
        { layout: 'checklist', heading: 'The checklist', bullets: ['A real problem', 'A team that ships'], say: 'A real problem and a team that ships.', bg_prompt: 'a whiteboard', source: 'a real problem and a team that ships' },
        { layout: 'cta', text: 'Follow for more', heading: '@founder', say: 'Follow for more.', bg_prompt: 'a phone in a hand' },
      ],
    };
    const model = async (prompt: string) => (prompt.includes('Turn this plan into a storyboard') ? JSON.stringify(good) : '{}');
    const said: string[] = [];
    // The figure is real because the material says so, and every scene points at the line it came from.
    const backed: Material = { ...nothing, lines: ['Only twelve per cent of decks get a second meeting. What they check is a real problem and a team that ships.'], using: ['a note'] };
    const made = await direct({ brief: 'a 15 second reel about what investors check' }, backed, model, { report: (line) => said.push(line) });
    expect(made.spec.scenes.map((one) => one.layout)).toEqual(['hook', 'stat', 'checklist', 'cta']);
    expect(said.some((line) => line.includes('did not hold up'))).toBe(false);
    expect(criticise(made.spec, {
      seconds: 15, pace: 'punchy', purpose: 'reel', captions: true, bible: made.bible,
      layouts: layoutsFor({ ai: false, material: backed }), reel: true, sources: sourcesOf(backed, 'a 15 second reel about what investors check'),
    })).toEqual([]);
  });
});

describe('what the card is wired to, used without being asked', () => {
  const wired: Stage = {
    ...seedStage,
    cards: [
      { id: 'studio-3', kind: 'videogen', x: 0, y: 0, w: 1, h: 1 },
      { id: 'pics-1', kind: 'imagegen', x: 0, y: 0, w: 1, h: 1 },
      { id: 'note-1', kind: 'note', text: 'Our line: handover, without the handover.', x: 0, y: 0, w: 1, h: 1 },
    ],
    wires: [
      { id: 'w1', from: 'studio-3', fromHandle: 'r', to: 'pics-1', toHandle: 'l' },
      { id: 'w2', from: 'note-1', fromHandle: 'r', to: 'studio-3', toHandle: 'l' },
    ],
  };

  it("takes a wired image studio's own pictures and a wired note's own words, because a wire is the founder saying so", async () => {
    const at = await mkdtemp(join(tmpdir(), 'gather-'));
    await mkdir(join(at, 'assets'), { recursive: true });
    await mkdir(join(at, 'vendor'), { recursive: true });
    const deps = {
      dir: at, think: async () => '',
      stage: async () => wired,
      pictures: async (cardId: string) => (cardId === 'pics-1' ? ['media/one.png', 'media/two.png'] : []),
      readFile: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
      assets: async () => [],
    } as unknown as VideoDeps;
    const { material, files } = await gather(deps, { prompt: 'a film', cardId: 'studio-3' }, at, () => {});
    expect(material.using).toContain('2 pictures from the image studio');
    expect(material.using).toContain('a note');
    expect(material.lines.join(' ')).toContain('handover, without the handover');
    expect(material.assets.map((one) => one.kind)).toEqual(['image', 'image']);
    expect(material.assets[0].what).toContain('the latest');
    expect([...files.keys()]).toHaveLength(2);
  });

  it('never offers a layout the film could not fill', () => {
    expect(layoutsFor({ ai: false, material: nothing })).not.toContain('clip');
    expect(layoutsFor({ ai: false, material: nothing })).not.toContain('footage');
    expect(layoutsFor({ ai: true, material: nothing })).toContain('clip');
    const withFilm: Material = { ...nothing, assets: [{ name: 'walk', kind: 'video', what: 'six seconds' }] };
    expect(layoutsFor({ ai: false, material: withFilm })).toContain('footage');
    const withScreens: Material = { ...nothing, assets: [{ name: 'shot', kind: 'screen', what: 'the home page' }] };
    expect(layoutsFor({ ai: false, material: withScreens })).toContain('device');
  });
});

void writeFile;

describe('somebody on camera', () => {
  const person = (over: Partial<Understanding> = {}): Understanding => ({
    purpose: 'reel', audience: 'founders', platform: 'a phone', shape: 'tall', seconds: 15, pace: 'punchy',
    tone: 'friendly', mood: 'upbeat', pack: 'creator', person: true, captions: true, said: '', ...over,
  });
  const six = Array.from({ length: 6 }, (_one, index): Scene => ({ layout: 'statement', text: `Line ${index}`, say: `Line ${index}.` }));

  it('puts the person in the opening, where the hook is said', () => {
    // A reel that wants a person and opens on a texture, producing its presenter in scene three, has a person in
    // it the way a leaflet has a photograph in it.
    const made = onCamera(six, person(), 'warm daylight', () => {}, { minutes: 3 });
    expect(made[0].layout).toBe('clip');
    // And comes back once in the middle of anything long enough to want a second look at them.
    expect(made.filter((one) => one.layout === 'clip')).toHaveLength(2);
  });

  it('gives the opening to the person even when a picture was already put there', () => {
    // The founder's own picture used to take the opening and push the moving person to scene three.
    const held: Scene[] = [{ ...six[0], asset: 'drawn-1' }, ...six.slice(1)];
    const made = onCamera(held, person(), 'warm daylight', () => {}, { minutes: 3 });
    expect(made[0].layout).toBe('clip');
    expect(made[0].asset).toBe('drawn-1');
  });

  it('opens on the person even when the storyboard already had them later', () => {
    // A person's own tool call wrote its presenter scenes second and fourth, so neither placement fired and the
    // reel still opened on a picture with type over it for three seconds.
    const said: string[] = [];
    const written: Scene[] = [
      { layout: 'hook', text: 'Want investors to chase you?', say: 'Want investors to chase you?' },
      { layout: 'presenter', portrait_prompt: 'a founder', say: 'They want proof.' },
      ...six.slice(2),
    ];
    const made = onCamera(written, person(), 'warm daylight', (line) => said.push(line), { minutes: 3 });
    expect(made[0].layout).toBe('presenter');
    // The words on the opening are kept: the hook is what they say.
    expect(made[0].text).toBe('Want investors to chase you?');
    expect(said.join(' ')).toContain('opens on them');
  });

  it('films the person here rather than leaving it to the model to ask somebody else', () => {
    // A model that wants a talking head writes a `presenter` scene, which only the free online service makes; when
    // that is out of quota the film quietly has nobody in it. So the director places the shots itself.
    const said: string[] = [];
    const made = onCamera(six, person(), 'warm daylight', (line) => said.push(line), { minutes: 3 });
    const filmed = made.filter((one) => one.layout === 'clip');
    expect(filmed).toHaveLength(2);
    for (const one of filmed) expect(one.clip_prompt).toContain('talking to it');
    // What it costs the founder in waiting, said before any of it starts.
    expect(said.join(' ')).toContain('6 minutes');
  });

  it('sits on a still of a face when this computer cannot film one', () => {
    const said: string[] = [];
    const made = onCamera(six, person(), 'warm daylight', (line) => said.push(line));
    expect(made.some((one) => one.layout === 'clip')).toBe(false);
    expect(made[0].bg_prompt).toContain('facing the camera');
    expect(said.join(' ')).toContain('no footage');
  });

  it('leaves a film that already has somebody in it alone, and one that never asked for anybody', () => {
    const already = [{ layout: 'presenter' as const, say: 'Hello.' }, ...six];
    expect(onCamera(already, person(), 'warm', () => {}, { minutes: 3 })).toBe(already);
    expect(onCamera(six, person({ person: false }), 'warm', () => {}, { minutes: 3 })).toBe(six);
  });

  it('does not mistake a clip of a desk for a person', () => {
    // A real reel spent three minutes of this computer's time on hands over a contact sheet, and the film it went
    // into had nobody in it, because a clip scene counted as somebody on camera.
    const desk = [...six.slice(0, 2), { layout: 'clip' as const, clip_prompt: 'hands moving papers across a desk', say: 'They read it.' }, ...six.slice(2)];
    const made = onCamera(desk, person(), 'warm daylight', () => {}, { minutes: 3 });
    expect(made.filter((one) => one.layout === 'clip' && /talking to it/.test(one.clip_prompt ?? ''))).toHaveLength(1);
    // Two moving shots in one film is the ceiling, whoever wrote them.
    expect(made.filter((one) => one.layout === 'clip')).toHaveLength(2);
  });
});

describe('a picture the film was handed', () => {
  const person = (over: Partial<Understanding> = {}): Understanding => ({
    purpose: 'reel', audience: 'founders', platform: 'a phone', shape: 'tall', seconds: 15, pace: 'punchy',
    tone: 'friendly', mood: 'upbeat', pack: 'creator', person: true, captions: true, said: '', ...over,
  });
  const drawn = (prompt: string): Material => ({
    lines: [], using: ['the image studio'],
    assets: [{ name: 'drawn-1', kind: 'image', prompt, what: `a picture drawn in the image studio (the latest): ${prompt}` }],
  });

  it('knows whether there is anybody in it from the words it was drawn from', () => {
    expect(showsSomebody({ prompt: 'image of influencer talking abt what investors look for' })).toBe(true);
    expect(showsSomebody({ prompt: 'a paper plane over a quiet city at dawn' })).toBe(false);
    expect(faceIn(drawn('image of an influencer talking to camera'))).toBe('drawn-1');
    expect(faceIn(drawn('a kite over a field'))).toBeUndefined();
  });

  it('puts it on camera instead of drawing a stranger', () => {
    // The founder drew a person, wired it up, asked for a film with a real face — and got three drawn faces that
    // never arrived, because the picture they had made was only ever listed.
    const said: string[] = [];
    const written: Scene[] = [
      { layout: 'presenter', say: 'Investors want traction.', portrait_prompt: 'a founder at a desk' },
      { layout: 'statement', text: 'Traction wins', say: 'Traction wins.' },
    ];
    const made = onCamera(written, person(), 'warm daylight', (line) => said.push(line), undefined, 'drawn-1');
    expect(made[0].asset).toBe('drawn-1');
    expect(made[0].portrait_prompt).toBeUndefined();
    expect(said.join(' ')).toContain('picture from your image studio');
  });

  it('holds it in a scene of its own when nobody was written on camera at all', () => {
    const written: Scene[] = [
      { layout: 'hook', text: 'Investors want traction', say: 'Investors want traction.' },
      { layout: 'cta', text: 'Follow for more', say: 'Follow for more.' },
    ];
    const made = onCamera(written, person(), 'warm daylight', () => {}, undefined, 'drawn-1');
    const holding = made.find((one) => one.asset === 'drawn-1');
    expect(holding?.layout).toBe('picture');
    expect(holding?.bg_prompt).toBeUndefined();
  });
});
