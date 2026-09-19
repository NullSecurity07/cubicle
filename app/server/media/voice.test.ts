import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedStage, type Stage } from '../../shared/model.ts';
import { createStore } from '../store.ts';
import { mediaTools } from '../tools/media.ts';
import { createMedia } from './jobs.ts';
import { DEFAULT_VOICE, fakeVoices, geminiVoice, isVoice, SETUP_HINT, VOICES, wavOf, wavSeconds } from './voice.ts';

const pcm = (samples: number[]) => Buffer.from(new Int16Array(samples.map((one) => Math.round(one * 32767))).buffer);
const asked: { url: string; body: any; headers: any }[] = [];
const answers = (make: () => Response): typeof fetch => (async (url: any, init?: RequestInit) => {
  asked.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers });
  return make();
}) as typeof fetch;

describe('WAV files', () => {
  it('writes a file a player can read, and reads its length back out of it', () => {
    const wav = wavOf(new Float32Array(12_000), 24_000);
    expect(wav.length).toBe(44 + 24_000);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wavSeconds(wav)).toBeCloseTo(0.5, 5);
    expect(wavSeconds(wavOf(new Float32Array(48_000), 48_000))).toBeCloseTo(1, 5);
  });

  it('keeps the loud parts inside what sixteen bits can hold, and says nothing about a file that is not one', () => {
    const wav = wavOf(Float32Array.from([0, 0.5, -0.5, 4, -4]));
    expect([...new Int16Array(wav.subarray(44).buffer, wav.byteOffset + 44, 5)]).toEqual([0, 16384, -16383, 32767, -32767]);
    expect(wavSeconds(Buffer.from('not a wav at all, just some words'))).toBe(0);
    expect(wavSeconds(Buffer.alloc(0))).toBe(0);
  });

  it('finds the samples when something else comes before them', () => {
    const plain = wavOf(new Float32Array(2400));
    const listed = Buffer.alloc(4);
    listed.writeUInt32LE(4);
    const extra = Buffer.concat([plain.subarray(0, 36), Buffer.from('LIST'), listed, Buffer.from('junk'), plain.subarray(36)]);
    expect(wavSeconds(extra)).toBeCloseTo(0.1, 5);
  });
});

describe('voices', () => {
  it('offers every voice under a name the founder can choose by, best first', () => {
    expect(VOICES).toHaveLength(28);
    expect(VOICES[0]).toEqual({ id: 'af_heart', name: 'Heart · American woman' });
    expect(DEFAULT_VOICE).toBe('af_heart');
    expect(new Set(VOICES.map((voice) => voice.id)).size).toBe(28);
    for (const voice of VOICES) expect(voice.name).toMatch(/^[A-Z][a-z]+ · (American|British) (woman|man)$/);
    expect(isVoice('bm_george')).toBe(true);
    expect(isVoice('af_nobody')).toBe(false);
    expect(isVoice(undefined)).toBe(false);
  });
});

describe('Gemini as the second voice', () => {
  it('says what the founder must set up, and nothing once the key is there', () => {
    expect(geminiVoice({}).ready()).toBe(SETUP_HINT);
    expect(geminiVoice({ GEMINI_API_KEY: 'key' }).ready()).toBeNull();
  });

  it('asks for sound and puts a WAV header in front of the samples that come back', async () => {
    asked.length = 0;
    const maker = geminiVoice({ GEMINI_API_KEY: 'key' }, answers(() => Response.json({
      candidates: [{ content: { parts: [{ text: 'here you go' }, { inlineData: { data: pcm([0, 0.25, -0.25]).toString('base64') } }] } }],
    })));
    const piece = await maker.make({ prompt: 'Thanks for stopping by.' }, { report: () => {} });
    expect(piece.ext).toBe('wav');
    expect(piece.bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(piece.bytes.length).toBe(44 + 6);
    expect(asked[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent');
    expect(asked[0].body.contents[0].parts[0].text).toBe('Thanks for stopping by.');
    expect(asked[0].body.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(asked[0].headers['x-goog-api-key']).toBe('key');
  });

  it('passes on what went wrong in one line', async () => {
    const refused = geminiVoice({ GEMINI_API_KEY: 'key' }, answers(() => new Response('quota exhausted', { status: 429 })));
    await expect(refused.make({ prompt: 'hello' }, { report: () => {} })).rejects.toThrow('Gemini answered 429: quota exhausted');
    const empty = geminiVoice({ GEMINI_API_KEY: 'key' }, answers(() => Response.json({ candidates: [{ content: { parts: [{ text: 'sorry' }] } }] })));
    await expect(empty.make({ prompt: 'hello' }, { report: () => {} })).rejects.toThrow('nothing came back to say');
  });
});

describe('generate_voice', () => {
  const wired: Stage = {
    ...seedStage,
    cards: [{ id: 'studio-2', kind: 'voicegen', x: 0, y: 0, w: 1, h: 1 }],
    wires: [...seedStage.wires, { id: 'w', from: 'studio-2', fromHandle: 'r', to: 'marketing', toHandle: 'l' }],
  };

  const turn = async (stage: Stage) => {
    const dir = await mkdtemp(join(tmpdir(), 'voicetool-'));
    const store = createStore(dir);
    const media = createMedia({ dir, store, makers: { voicegen: [fakeVoices] } });
    const tool = mediaTools(media).find((one) => one.name === 'generate_voice')!;
    return { tool, media, context: { stage, roomId: 'marketing', store, granted: new Map<string, string>() } };
  };

  it('speaks in the studio wired to this person, and puts the recording in the reply', async () => {
    const { tool, media, context } = await turn(wired);
    const ran = await tool.run({ text: 'Thanks for stopping by.', voice: 'bf_emma' }, context);
    expect(ran.text).toMatch(/^Said it\.\n\n\[Thanks for stopping by\.\]\(\/api\/files\/media\/[a-z0-9-]+\.wav\)$/);
    expect(ran.effect).toEqual({ kind: 'media-made', id: 'studio-2' });
    const made = (await media.read('studio-2')).results[0];
    expect(made.prompt).toBe('Thanks for stopping by.');
    expect(wavSeconds((await context.store.readFileBytes(made.path))!)).toBeCloseTo(1, 5);
  });

  it('falls back to the first voice when asked for one that does not exist', async () => {
    const { tool, context } = await turn(wired);
    const said: Record<string, unknown>[] = [];
    const media = createMedia({ dir: context.store.filesDir, store: context.store, makers: { voicegen: [{ ...fakeVoices, make: async (ask) => { said.push(ask); return { ext: 'wav', bytes: Buffer.from('x') }; } }] } });
    const tool2 = mediaTools(media).find((one) => one.name === 'generate_voice')!;
    await tool2.run({ text: 'hello', voice: 'af_nobody' }, context);
    expect(said[0].voice).toBe('af_heart');
    expect(tool.parameters).toMatchObject({ properties: { voice: { enum: VOICES.map((voice) => voice.id) } } });
  });

  it('asks the founder for a studio when none is wired, and never speaks in someone else\'s', async () => {
    const { tool, context } = await turn({ ...wired, wires: seedStage.wires });
    await expect(tool.run({ text: 'hello' }, context)).rejects.toThrow(/no voice studio is connected to your room/);
    const other = await turn(wired);
    await expect(tool.run({ text: 'hello' }, { ...other.context, roomId: 'build' })).rejects.toThrow(/no voice studio is connected/);
  });

  it('will not speak from nothing', async () => {
    const { tool, context } = await turn(wired);
    await expect(tool.run({ text: '  ' }, context)).rejects.toThrow('"text" is missing');
  });
});
