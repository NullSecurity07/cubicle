import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Card, Stage } from '../../shared/model.ts';
import { aboutTheCompany, gather, narratorOf, withoutMoney, sourcesFor, takeLine, type StudioNarrator, type VideoDeps } from './gather.ts';
import { voiceKey, wavOf } from './voice.ts';

const box = { x: 0, y: 0, w: 1, h: 1 };
const wire = (from: string, to: string) => ({ id: `${from}-${to}`, from, fromHandle: 'r', to, toHandle: 'l' });
const stageWith = (voice: Partial<Extract<Card, { kind: 'voicegen' }>>, wires = [wire('voice', 'film')]): Stage => ({
  rooms: [{ id: 'sam', name: 'Sam', role: 'content', brief: '', accent: '#fff', ...box }],
  docs: [],
  cards: [{ id: 'film', kind: 'videogen', ...box }, { id: 'voice', kind: 'voicegen', ...voice, ...box }, { id: 'second', kind: 'voicegen', voice: 'bm_george', ...box }],
  wires,
});
const take = wavOf(new Float32Array(2400));

async function gathered(stage: Stage, asked: Partial<Parameters<typeof gather>[1]> = {}, more: Partial<VideoDeps> = {}) {
  const at = await mkdtemp(join(tmpdir(), 'gather-'));
  await mkdir(join(at, 'assets'), { recursive: true });
  const lines: string[] = [];
  const deps: VideoDeps = {
    dir: at, think: async () => '', stage: async () => stage,
    recordings: async (cardId) => (cardId === 'voice' ? [{ path: 'media/thanks.wav', prompt: 'Thanks for stopping by.', speaker: 'kokoro|af_sarah' }, { path: 'media/old.wav', prompt: 'Older.' }] : []),
    readFile: async (path) => (path.endsWith('.wav') ? take : null),
    ...more,
  };
  const out = await gather(deps, { prompt: 'A film', cardId: 'film', ...asked }, at, (line) => lines.push(line));
  return { ...out, lines };
}

describe('a voice studio wired to a film', () => {
  it('is carried into the film from whoever is making it, as a picture studio is', () => {
    const stage = stageWith({ voice: 'af_sarah' }, [wire('sam', 'voice')]);
    expect(sourcesFor(stage, 'film', 'sam').map((card) => card.id)).toEqual(['voice']);
    expect(sourcesFor(stage, 'film').map((card) => card.id)).toEqual([]);
  });

  it("is read for its voice and its newest recording, and says whose voice the film is in", async () => {
    const { narrator, material } = await gathered(stageWith({ voice: 'af_sarah' }));
    expect(narrator).toMatchObject({ cardId: 'voice', voice: 'af_sarah', says: 'the voice of the Voice studio, Sarah' });
    expect(narrator?.take).toMatchObject({ text: 'Thanks for stopping by.', speaker: 'kokoro|af_sarah' });
    expect(narrator?.take?.bytes.equals(take)).toBe(true);
    expect(material.using).toContain('the voice of the Voice studio, Sarah');
    // The director is told the take exists, so a line it writes can be the founder's own recording.
    expect(material.lines.join('\n')).toContain('"Thanks for stopping by."');
  });

  it('names the default voice for a studio nobody set a voice on', async () => {
    expect((await gathered(stageWith({}))).narrator?.says).toBe('the voice of the Voice studio, Heart');
  });

  it('takes the first voice studio only: a film has one narrator', async () => {
    const stage = stageWith({ voice: 'af_sarah' }, [wire('voice', 'film'), wire('second', 'film')]);
    const { narrator, material } = await gathered(stage);
    expect(narrator?.cardId).toBe('voice');
    expect(material.using.filter((one) => one.startsWith('the voice of'))).toHaveLength(1);
  });

  it("is not read when the founder picked the film's narrator on the card, or turned the narration off", async () => {
    for (const asked of [{ voice: 'bm_george' }, { engine: 'omnivoice' }, { narrate: false }]) {
      const { narrator, material } = await gathered(stageWith({ voice: 'af_sarah' }), asked);
      expect(narrator, JSON.stringify(asked)).toBeUndefined();
      expect(material.using.join()).not.toContain('Voice studio');
    }
  });

  it('finds the recording an OmniVoice studio clones, the way the studio finds it', async () => {
    const stage = stageWith({ engine: 'omnivoice', clone: 'me', design: 'calm woman', language: 'es' });
    const { narrator } = await gathered(stage, {}, {
      assets: async () => [{ name: 'me', path: 'media/me.wav', kind: 'audio', at: 1, bytes: 10 }],
      fileOf: (path) => `/files/${path}`,
    });
    expect(narrator).toMatchObject({ engine: 'omnivoice', clone: 'me', ref: '/files/media/me.wav', language: 'es', says: 'the voice of the Voice studio, cloned from me' });
  });

  it('says so when the recording it clones is gone, and reads in its designed voice', async () => {
    const { narrator, lines } = await gathered(stageWith({ engine: 'omnivoice', clone: 'gone', design: 'calm woman' }), {}, { assets: async () => [], fileOf: (path) => path });
    expect(narrator?.ref).toBeUndefined();
    expect(narrator?.says).toBe('the voice of the Voice studio, OmniVoice (calm woman)');
    expect(lines.join('\n')).toContain('clones gone, which is not on that card any more');
  });
});

describe('whose voice reads the film', () => {
  const studio: StudioNarrator = { cardId: 'voice', voice: 'af_sarah', says: '' };

  it("is the card's pick first, then the wired studio's, then the film's own casting", () => {
    expect(narratorOf({ voice: 'bm_george' }, studio)).toEqual({ voice: 'bm_george', from: 'card' });
    expect(narratorOf({ engine: 'omnivoice', design: 'old man' }, studio)).toEqual({ engine: 'omnivoice', design: 'old man', from: 'card' });
    expect(narratorOf({}, studio)).toEqual({ voice: 'af_sarah', from: 'studio' });
    expect(narratorOf({ voice: 'not-a-voice' }, studio)).toEqual({ voice: 'af_sarah', from: 'studio' });
    expect(narratorOf({}, { ...studio, voice: undefined })).toEqual({ voice: 'af_heart', from: 'studio' });
    expect(narratorOf({}, undefined)).toEqual({ from: 'auto' });
  });

  it("carries an OmniVoice studio's design, language and clone", () => {
    expect(narratorOf({}, { cardId: 'voice', engine: 'omnivoice', design: 'calm', language: 'es', clone: 'me', ref: '/r.wav', refText: 'hi', says: '' }))
      .toEqual({ engine: 'omnivoice', design: 'calm', language: 'es', clone: 'me', ref: '/r.wav', refText: 'hi', from: 'studio' });
    expect(narratorOf({}, { cardId: 'voice', engine: 'omnivoice', design: 'calm', clone: 'gone', says: '' }))
      .toEqual({ engine: 'omnivoice', design: 'calm', from: 'studio' });
  });
});

describe('a take the founder already recorded', () => {
  const lines = ['This is Relay.', 'Thanks for  stopping by. ', 'Try it today.'];
  const reading = { voice: 'af_sarah', from: 'studio' as const };
  const made = (speaker?: string) => ({ text: 'Thanks for stopping by.', bytes: take, ...(speaker ? { speaker } : {}) });

  it('is the line whose words match exactly, spaces aside', () => {
    expect(takeLine(lines, made('kokoro|af_sarah'), reading)).toBe(1);
    expect(takeLine(lines, made(), reading)).toBe(1);
    expect(takeLine(['Thanks for stopping by!'], made(), reading)).toBe(-1);
  });

  it('is never a take read in another voice, nor used when the card picked the narrator', () => {
    expect(takeLine(lines, made('kokoro|bm_george'), reading)).toBe(-1);
    expect(takeLine(lines, made('kokoro|af_sarah'), { voice: 'af_sarah', from: 'card' })).toBe(-1);
    expect(takeLine(lines, undefined, reading)).toBe(-1);
  });

  it('knows who read it by the same key the studio writes', () => {
    expect(voiceKey({ voice: 'af_sarah' })).toBe('kokoro|af_sarah');
    expect(voiceKey({ voice: '' })).toBe('kokoro|af_heart');
    expect(voiceKey({ engine: 'omnivoice', design: ' Calm ', language: '' })).toBe('omnivoice|design:calm|language:');
    expect(voiceKey({ engine: 'omnivoice', design: 'calm', clone: 'me', language: 'es' })).toBe('omnivoice|clone:me|language:es');
    // The studio card's own ask and the film's reading of that card come to the same key.
    expect(voiceKey({ prompt: 'x', engine: 'omnivoice', design: 'calm', language: '' })).toBe(voiceKey(narratorOf({}, { cardId: 'v', engine: 'omnivoice', design: 'calm', says: '' })));
  });
});

// Journey 12: an unwired video card asked for "a documentary about a pottery class" read the pinned Company brief and
// narrated Playtestr's MRR and cash in the bank.
describe('a pinned company brief and a film about something else', () => {
  const brief = 'Playtestr: a tool for indie game devs to run playtests.\nDevs send a build link, recruit players.\nFourteen studios are testing our platform.\nWe have reached 87 euros MRR. Cash in the bank: €7,200.';
  const stage: Stage = {
    rooms: [], cards: [{ id: 'film', kind: 'videogen', ...box }], wires: [],
    docs: [{ id: 'company', title: 'Company brief', pinned: true, ...box }],
  };
  const readDoc = async () => brief;

  it('films the subject asked for and leaves the pinned brief out', async () => {
    const { material } = await gathered(stage, { prompt: 'A 20 second documentary clip about a pottery class, with real photographs.' }, { readDoc });
    expect(material.lines).toEqual([]);
    expect(material.using).toEqual([]);
  });

  it('reads the pinned brief for a film about the company, without its money unless asked', async () => {
    const { material } = await gathered(stage, { prompt: 'A short film about Playtestr for indie devs' }, { readDoc });
    const lines = material.lines.join('\n');
    expect(lines).toContain('Fourteen studios are testing our platform.');
    expect(lines).not.toMatch(/MRR|7,200|Cash/);
    const asked = await gathered(stage, { prompt: 'An investor update film: our MRR and runway' }, { readDoc });
    expect(asked.material.lines.join('\n')).toContain('87 euros MRR');
  });

  it('reads a wired doc whatever the brief is about', async () => {
    const wired: Stage = { ...stage, wires: [wire('company', 'film')] };
    const { material } = await gathered(wired, { prompt: 'A documentary about a pottery class' }, { readDoc });
    expect(material.using).toEqual(['Company brief']);
  });

  it('knows a brief about the company from one about anything else', () => {
    expect(aboutTheCompany('A 20 second documentary clip about a pottery class, with real photographs.', { title: 'Company brief', text: brief })).toBe(false);
    expect(aboutTheCompany('A launch reel', { title: 'Company brief', text: brief })).toBe(true);
    expect(aboutTheCompany('a clip about playtestr', { title: 'Company brief', text: brief })).toBe(true);
    expect(withoutMoney('We have 14 studios. Cash in the bank: €7,200.\nRunway is 8 months.')).toBe('We have 14 studios.');
  });
});
