import { describe, expect, it } from 'vitest';
import { LISTEN_RATE } from '../../shared/reach.ts';
import { NO_FFMPEG, fakeFfmpeg, ffmpeg, oggOf, samplesOf, sayable } from './voicenotes.ts';

describe('a recording, on its way in and out', () => {
  it('asks for one channel of plain samples at the rate the listening model wants', async () => {
    const asked: string[][] = [];
    const samples = await samplesOf(Buffer.from('an ogg from a phone'), async (args) => { asked.push(args); return Buffer.alloc(LISTEN_RATE * 4); });
    expect(asked[0]).toContain('f32le');
    expect(asked[0]).toContain(String(LISTEN_RATE));
    expect(samples).toHaveLength(LISTEN_RATE);
  });

  it('asks for the Ogg Opus that Telegram draws as a voice note', async () => {
    const asked: string[][] = [];
    await oggOf(Buffer.from('RIFF'), async (args) => { asked.push(args); return Buffer.from('OggS'); });
    expect(asked[0]).toContain('libopus');
    expect(asked[0]).toContain('ogg');
  });

  it('says in plain words when this machine has no ffmpeg at all', async () => {
    await expect(ffmpeg('ffmpeg-that-is-not-here')([])).rejects.toThrow(NO_FFMPEG);
  });

  it('stands in for ffmpeg in a check without starting anything', async () => {
    expect((await fakeFfmpeg(['-f', 'f32le'])).length).toBe(LISTEN_RATE * 4);
    expect((await fakeFfmpeg(['-f', 'ogg'], Buffer.from('x'))).toString()).toContain('Ogg');
  });
});

describe('a reply, as somebody would actually say it', () => {
  it('reads the words, not the marks around them', () => {
    expect(sayable('## The launch\n\n- **Friday** is the day\n- the price is `29`\n\n---\n\nSee [the note](https://example.com/x).'))
      .toBe('The launch\n\nFriday is the day\nthe price is 29\n\nSee the note.');
  });

  it('never reads a picture or a file out as a path, because the founder is being handed the file itself', () => {
    const said = sayable('Made the picture.\n\n![a cat on a roof](/api/files/media/cat.png)\n\nand [Launch day](/api/files/media/launch.mp4).');
    expect(said).toBe('Made the picture.\n\nand Launch day.');
    expect(said).not.toContain('/api/files');
    expect(said).not.toContain('!');
  });

  it('never reads code or a table out loud, and says so instead', () => {
    const said = sayable('Here it is:\n\n```js\nconst a = 1;\n```\n\n| one | two |\n| --- | --- |\n\nThat is all.');
    expect(said).toContain('There is code in the written reply.');
    expect(said).not.toContain('const a');
    expect(said).not.toContain('|');
  });

  it('stops on a sentence at about a minute, and says the rest is written down', () => {
    const said = sayable(`${'This is a sentence. '.repeat(60)}`, 200);
    expect(said.length).toBeLessThan(260);
    expect(said).toContain('The rest is in the written reply.');
    expect(said.split('\n')[0].endsWith('.')).toBe(true);
  });
});

describe('what the listening model is told', () => {
  it('tells an English-only model nothing about language, because it refuses to hear it', async () => {
    const { hearing } = await import('./speech.ts');
    // The real model said so the first time the founder sent a voice note: "Cannot specify `task` or `language` for
    // an English-only model". Every fake had been happy.
    expect(hearing('onnx-community/whisper-base.en')).toEqual({ chunk_length_s: 30 });
    expect(hearing('onnx-community/whisper-base')).toEqual({ chunk_length_s: 30, language: 'en' });
  });
});
