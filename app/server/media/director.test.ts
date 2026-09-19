import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedStage, type Stage } from '../../shared/model.ts';
import { criticise } from './critic.ts';
import {
  bibleFor, direct, layoutsFor, readBrief, secondsIn, specFromPlan, tellOf, understandingOf,
  type Material, type Plan, type Understanding,
} from './director.ts';
import { countWords, saidWords, type Spec } from './spec.ts';
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
