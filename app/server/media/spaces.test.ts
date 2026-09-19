import { describe, expect, it } from 'vitest';
import {
  type App, type Space, clipUrlOf, createClips, fakeClips, plainly, QUOTA, SETUP_HINT, spaces, speechSeconds, waitingLine,
} from './spaces.ts';

const keys = { HF_TOKEN: 'hf_secret' };
const mp4 = Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]);
const done = (url: string) => [{ type: 'status', stage: 'complete', queue: true }, { type: 'data', data: [{ url, path: '/x.mp4' }] }];

// A WAV of a given length, written here rather than borrowed from the voice studio, so this module's tests stand alone.
function wavOf(seconds: number, rate = 24_000): Buffer {
  const body = Buffer.alloc(Math.round(seconds * rate) * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + body.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}

// One stand-in Gradio app per Space, built from the endpoints it claims and the messages it will send back.
type Script = { endpoints: Record<string, string[]>; notes: unknown[] | (() => unknown[]) };
function apps(plan: Record<string, Script>) {
  const calls: { space: string; endpoint: string; args: Record<string, unknown>; token: string }[] = [];
  const cancels: string[] = [];
  const connect = async (space: string, options: { token: `hf_${string}` }): Promise<App> => {
    const script = plan[space];
    if (!script) throw new Error('the Space is not running');
    return {
      async view_api() {
        return { named_endpoints: Object.fromEntries(Object.entries(script.endpoints).map(([at, names]) => [at, { parameters: names.map((parameter_name) => ({ parameter_name })) }])) };
      },
      submit(endpoint, args) {
        calls.push({ space, endpoint, args, token: options.token });
        const notes = typeof script.notes === 'function' ? script.notes() : script.notes;
        return { [Symbol.asyncIterator]: async function* () { for (const note of notes) yield note as never; }, cancel: async () => { cancels.push(space); } } as never;
      },
      close() {},
    };
  };
  return { calls, cancels, connect };
}

const fetched: string[] = [];
const served = (bytes: Buffer | number): typeof fetch => (async (url: any) => {
  fetched.push(String(url));
  return typeof bytes === 'number' ? new Response('gone', { status: bytes }) : new Response(new Uint8Array(bytes));
}) as typeof fetch;

const LTX_TEXT = ['prompt', 'mode', 'duration_ui', 'height_ui', 'width_ui', 'seed_ui', 'randomize_seed', 'ui_guidance_scale', 'improve_texture_flag'];
const LTX_IMAGE = [...LTX_TEXT, 'input_image_filepath'];
const WAN = ['input_image', 'prompt', 'steps', 'negative_prompt', 'duration_seconds', 'guidance_scale', 'guidance_scale_2', 'seed', 'randomize_seed'];

describe('spaces.json', () => {
  it('lists a Space, an endpoint and a parameter map for both jobs', () => {
    const all: Space[] = [...spaces.broll, ...spaces.presenter];
    expect(spaces.broll.length).toBeGreaterThan(1);
    expect(spaces.presenter.length).toBeGreaterThan(1);
    for (const spot of all) {
      expect(spot.space).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(spot.endpoint).toMatch(/^\/\w+$/);
      expect(Object.keys(spot.params).length).toBeGreaterThan(1);
    }
  });

  it('only ever asks for fillings the two jobs can supply', () => {
    const known = new Set(['prompt', 'image', 'seconds', 'seed', 'portrait', 'speech']);
    for (const spot of [...spaces.broll, ...spaces.presenter]) {
      for (const value of Object.values(spot.params)) {
        if (typeof value === 'string' && value.startsWith('$')) expect(known).toContain(value.slice(1));
      }
    }
    // A talking head is given a face and a voice; b-roll from words alone must not ask for a still.
    for (const spot of spaces.presenter) expect(Object.values(spot.params)).toEqual(expect.arrayContaining(['$portrait', '$speech']));
    for (const spot of spaces.broll) expect(Object.values(spot.params)).toContain('$prompt');
  });
});

describe('free clips from Hugging Face', () => {
  it('says what the founder must set up, and nothing once the token is there', () => {
    expect(createClips({}).ready()).toBe(SETUP_HINT);
    expect(createClips(keys).ready()).toBeNull();
    expect(fakeClips.ready()).toBeNull();
  });

  it('will not call anything without a token', async () => {
    await expect(createClips({}).broll({ prompt: 'a kite', seconds: 4 }, { report: () => {} })).rejects.toThrow(SETUP_HINT);
  });

  it('moves a still with the image Space, keeping the clip short enough for the free minutes', async () => {
    fetched.length = 0;
    const { calls, connect } = apps({ 'zerogpu-aoti/wan2-2-fp8da-aoti-faster': { endpoints: { '/generate_video': WAN }, notes: done('https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space/gradio_api/file=/tmp/out.mp4') } });
    const clips = createClips(keys, connect, served(mp4));
    const clip = await clips.broll({ prompt: 'a paper plane over a desk', image: Buffer.from([1, 2, 3]), seconds: 30 }, { report: () => {} });
    expect(clip).toEqual({ ext: 'mp4', bytes: mp4 });
    expect(calls[0].space).toBe('zerogpu-aoti/wan2-2-fp8da-aoti-faster');
    expect(calls[0].endpoint).toBe('/generate_video');
    expect(calls[0].args.prompt).toBe('a paper plane over a desk');
    expect(calls[0].args.duration_seconds).toBe(5);
    expect(calls[0].args.steps).toBe(6);
    expect(calls[0].args.input_image).toBeDefined();
    expect(fetched[0]).toContain('/gradio_api/file=');
  });

  it('skips the image Spaces when there is no still, and asks the words one instead', async () => {
    const { calls, connect } = apps({ 'Lightricks/ltx-video-distilled': { endpoints: { '/text_to_video': LTX_TEXT, '/image_to_video': LTX_IMAGE }, notes: done('https://lightricks-ltx-video-distilled.hf.space/gradio_api/file=/tmp/out.mp4') } });
    await createClips(keys, connect, served(mp4)).broll({ prompt: 'rain on a window', seconds: 1 }, { report: () => {} });
    expect(calls).toHaveLength(1);
    expect(calls[0].endpoint).toBe('/text_to_video');
    expect(calls[0].args.mode).toBe('text-to-video');
    expect(calls[0].args.duration_ui).toBe(3);
    expect(calls[0].args.input_image_filepath).toBeUndefined();
  });

  it('gives a talking head the face, the line and the length of the line', async () => {
    const speech = wavOf(4);
    const { calls, connect } = apps({ 'hugging-apps/leaptalk-talking-head': { endpoints: { '/generate': ['portrait_image', 'speech_audio', 'max_seconds', 'num_inference_steps', 'guidance_scale', 'seed', 'auto_crop_face'] }, notes: done('https://hugging-apps-leaptalk-talking-head.hf.space/gradio_api/file=/tmp/said.mp4') } });
    const clip = await createClips(keys, connect, served(mp4)).presenter({ portrait: Buffer.from([1]), speech }, { report: () => {} });
    expect(clip.ext).toBe('mp4');
    expect(calls[0].args.max_seconds).toBe(5);
    expect(calls[0].args.portrait_image).toBeDefined();
    expect(calls[0].args.speech_audio).toBeDefined();
    expect(calls[0].token).toBe('hf_secret');
  });

  it('names the Space that changed shape, and carries on to the next one', async () => {
    const lines: string[] = [];
    const { calls, connect } = apps({
      'hugging-apps/leaptalk-talking-head': { endpoints: { '/generate': ['portrait_image', 'audio'] }, notes: [] },
      'victor/LongCat-Video-Avatar-1.5': { endpoints: { '/generate': ['image_path', 'audio_path', 'prompt', 'resolution', 'seed', 'vocal_mode', 'acceleration'] }, notes: done('https://victor-longcat-video-avatar-1-5.hf.space/gradio_api/file=/tmp/said.mp4') },
    });
    await createClips(keys, connect, served(mp4)).presenter({ portrait: Buffer.from([1]), speech: wavOf(0.1) }, { report: (line) => lines.push(line) });
    expect(lines.join('\n')).toContain('the Space changed shape: hugging-apps/leaptalk-talking-head /generate no longer takes speech_audio, max_seconds');
    expect(calls[0].space).toBe('victor/LongCat-Video-Avatar-1.5');
    expect(calls[0].args.acceleration).toBe('DBCache faster');
  });

  it('says where it is in the queue and how far along, once per change', async () => {
    const lines: string[] = [];
    const { connect } = apps({ 'Lightricks/ltx-video-distilled': { endpoints: { '/text_to_video': LTX_TEXT }, notes: [
      { type: 'status', stage: 'pending', queue: true, position: 2, eta: 41.2 },
      { type: 'status', stage: 'pending', queue: true, position: 2, eta: 41.2 },
      { type: 'status', stage: 'generating', queue: true, progress_data: [{ progress: 0.5, desc: 'denoising' }] },
      ...done('https://lightricks-ltx-video-distilled.hf.space/gradio_api/file=/tmp/out.mp4'),
    ] } });
    await createClips(keys, connect, served(mp4)).broll({ prompt: 'rain', seconds: 3 }, { report: (line) => lines.push(line) });
    expect(lines).toEqual(['asking LTX Video on Hugging Face…', 'waiting in the queue at 3, about 42s to wait…', 'denoising 50%…', 'fetching the clip back…']);
  });

  it('puts the free minutes in plain words and stops asking, since every Space spends the same ones', async () => {
    const { calls, connect } = apps({
      'zerogpu-aoti/wan2-2-fp8da-aoti-faster': { endpoints: { '/generate_video': WAN }, notes: [{ type: 'status', stage: 'error', message: 'You have exceeded your GPU quota (60s requested vs. 12s left). Try again in 0:42:00' }] },
      'Lightricks/ltx-video-distilled': { endpoints: { '/image_to_video': LTX_IMAGE }, notes: done('https://x.hf.space/gradio_api/file=/tmp/out.mp4') },
    });
    await expect(createClips(keys, connect, served(mp4)).broll({ prompt: 'a kite', image: Buffer.from([1]), seconds: 4 }, { report: () => {} })).rejects.toThrow(QUOTA);
    expect(calls).toHaveLength(1);
    expect(plainly('ZeroGPU quota exceeded')).toBe(QUOTA);
    expect(plainly(new Error('the Space is not running'))).toBe('the Space is not running');
    expect(plainly([{ message: 'prompt is required' }])).toBe('prompt is required');
  });

  it('gathers what each Space said when they all refuse', async () => {
    const { connect } = apps({});
    await expect(createClips(keys, connect, served(mp4)).broll({ prompt: 'a kite', seconds: 4 }, { report: () => {} }))
      .rejects.toThrow('LTX Video: the Space is not running');
  });

  it('gives up the queue place when the founder stops the card', async () => {
    const stop = new AbortController();
    const { cancels, connect } = apps({ 'Lightricks/ltx-video-distilled': { endpoints: { '/text_to_video': LTX_TEXT }, notes: [
      { type: 'status', stage: 'pending', queue: true, position: 0 },
      ...done('https://x.hf.space/gradio_api/file=/tmp/out.mp4'),
    ] } });
    const report = (line: string) => { if (line.startsWith('waiting')) stop.abort(); };
    await expect(createClips(keys, connect, served(mp4)).broll({ prompt: 'a kite', seconds: 4 }, { report, signal: stop.signal })).rejects.toThrow('stopped');
    expect(cancels).toEqual(['Lightricks/ltx-video-distilled']);
  });

  it('says so when the link went stale before the clip came back', async () => {
    const { connect } = apps({ 'Lightricks/ltx-video-distilled': { endpoints: { '/text_to_video': LTX_TEXT }, notes: done('https://x.hf.space/gradio_api/file=/tmp/out.mp4') } });
    await expect(createClips(keys, connect, served(404)).broll({ prompt: 'a kite', seconds: 4 }, { report: () => {} }))
      .rejects.toThrow('the clip could not be fetched back (404) — these links last only minutes');
  });

  it('says so when a Space finishes with nothing', async () => {
    const { connect } = apps({ 'Lightricks/ltx-video-distilled': { endpoints: { '/text_to_video': LTX_TEXT }, notes: [{ type: 'status', stage: 'complete', queue: true }] } });
    await expect(createClips(keys, connect, served(mp4)).broll({ prompt: 'a kite', seconds: 4 }, { report: () => {} }))
      .rejects.toThrow('the Space finished without a clip');
  });
});

describe('reading the answers back', () => {
  it('finds the file however the Space wrapped it', () => {
    expect(clipUrlOf([{ url: 'https://a/one.mp4' }])).toBe('https://a/one.mp4');
    expect(clipUrlOf([{ video: { url: 'https://a/two.mp4' }, subtitles: null }, 42])).toBe('https://a/two.mp4');
    expect(clipUrlOf([{ path: '/tmp/x.mp4' }, 'seed'])).toBeNull();
    expect(clipUrlOf(null)).toBeNull();
  });

  it('turns a queue message into one line, and silence into none', () => {
    expect(waitingLine({ type: 'status', stage: 'pending', queue: true, position: 0 })).toBe('waiting in the queue at 1…');
    expect(waitingLine({ type: 'status', stage: 'generating', queue: true, progress_data: [{ progress: null, index: 3, length: 6, desc: null }] })).toBe('making the clip 50%…');
    expect(waitingLine({ type: 'status', stage: 'generating', queue: true })).toBe('making the clip…');
    expect(waitingLine({ type: 'status', stage: 'complete', queue: true })).toBe('');
  });

  it('reads how long a spoken line lasts out of the WAV itself', () => {
    expect(speechSeconds(wavOf(2))).toBeCloseTo(2, 2);
    expect(speechSeconds(Buffer.from('not a wav'))).toBe(0);
  });
});

describe('the fake clips', () => {
  it('hand back a real mp4 without a token or a network', async () => {
    const lines: string[] = [];
    const broll = await fakeClips.broll({ prompt: 'a kite', seconds: 4 }, { report: (line) => lines.push(line) });
    const said = await fakeClips.presenter({ portrait: Buffer.from([1]), speech: wavOf(1) }, { report: (line) => lines.push(line) });
    expect(broll.ext).toBe('mp4');
    expect(broll.bytes.toString('ascii', 4, 8)).toBe('ftyp');
    expect(said.bytes).toEqual(broll.bytes);
    expect(lines).toEqual(['asking for 4 seconds of a kite…', 'asking for 1.0 seconds of talking…']);
  });
});
