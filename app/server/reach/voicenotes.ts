import { spawn } from 'node:child_process';
import { LISTEN_RATE } from '../../shared/reach.ts';

// Turning a phone's recording into something the listening model understands, and a reply into something the phone
// will play, is the one job here that this app cannot do by itself. `ffmpeg` does it, in a pipe, with nothing
// written to disk. A machine without it still works — the words come and go as text — and says so once, plainly.
export type Runner = (args: string[], input?: Buffer) => Promise<Buffer>;

export const NO_FFMPEG = 'This machine has no ffmpeg, so I cannot listen to a voice note or send one. Write to me instead, or install ffmpeg and I will start hearing you.';
// Telegram lets a bot fetch a file up to twenty megabytes. A voice note that long is half an hour of talking.
export const BIGGEST = 20 * 1024 * 1024;
export const TOO_BIG = 'That recording is bigger than I can fetch from Telegram. Send me a shorter one, or write it.';
// About a minute out loud. Longer than that on a phone is a podcast, not an answer, and the written reply has it all.
export const SPOKEN = 900;

export function ffmpeg(bin = 'ffmpeg'): Runner {
  return (args, input) => new Promise<Buffer>((done, fail) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let said = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => { said = `${said}${chunk}`.slice(-400); });
    child.on('error', (error: NodeJS.ErrnoException) => fail(new Error(error.code === 'ENOENT' ? NO_FFMPEG : error.message)));
    child.on('close', (code) => (code === 0 ? done(Buffer.concat(out)) : fail(new Error(said.trim().split('\n').at(-1) ?? `ffmpeg stopped with ${code}`))));
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

// Whatever the phone recorded in — Opus in Ogg, m4a, anything — down to the one channel of plain samples at 16 kHz
// that the listening model takes. The same shape the microphone in the app already sends.
export async function samplesOf(sound: Buffer, run: Runner): Promise<Float32Array> {
  const raw = await run(['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-map', '0:a:0', '-ac', '1', '-ar', String(LISTEN_RATE), '-f', 'f32le', 'pipe:1'], sound);
  // A copy, and only whole samples: a Buffer is a window onto a block this does not own, at an offset of its choosing.
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length - (raw.length % 4)));
}

// The other way: the voice this app already makes, as the Ogg Opus that Telegram draws as a voice note with a waveform.
// 48 kbps: at 32 the model's breath and sibilants came out smeared on a phone speaker, and a minute of talking is
// still well under half a megabyte.
export const VOICE_NOTE_RATE = '48k';
export const oggOf = (wav: Buffer, run: Runner): Promise<Buffer> =>
  run(['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-map', '0:a:0', '-c:a', 'libopus', '-b:a', VOICE_NOTE_RATE, '-ar', '48000', '-ac', '1', '-f', 'ogg', 'pipe:1'], wav);

// A reply is written to be read: asterisks, headings, tables and a block of code. Read out as it stands it is
// gibberish, so this is the same words as somebody would actually say them, and it stops on a full stop near a
// minute in. Code is never read aloud — it is mentioned, and the written reply below has it.
export function sayable(markdown: string, limit = SPOKEN): string {
  let code = false;
  const lines: string[] = [];
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) { if (!code) lines.push('There is code in the written reply.'); code = !code; continue; }
    if (code) continue;
    // A table is a shape on a screen, not a sentence; a rule is a pause somebody drew.
    if (/^\s*\|.*\|\s*$/.test(line) || /^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) continue;
    lines.push(line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^(\s*)[-*+]\s+/, '$1').replace(/^\s*\d+\.\s+/, ''));
  }
  const said = lines.join('\n')
    .replace(/`([^`\n]+)`/g, '$1')
    // A picture is handed over as a picture, so there is nothing to say about it; any other link is read as the
    // words it was written as. Read out as it stands, an address is a minute of somebody spelling out punctuation.
    .replace(/!\[[^\]\n]*\]\([^\s)]*\)/g, '')
    .replace(/\[([^\]\n]+)\]\([^\s)]*\)/g, '$1')
    .replace(/(\*\*|__)([^*_\n]+)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^\s*_][^*_\n]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
  if (said.length <= limit) return said;
  const cut = said.slice(0, limit);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));
  return `${(stop > limit * 0.4 ? cut.slice(0, stop + 1) : cut).trim()}\n\nThe rest is in the written reply.`;
}

// The checks never start a process: they hand over this instead, which answers with something of the right shape.
export const fakeFfmpeg: Runner = async (args, input) => (args.includes('f32le') ? Buffer.alloc(LISTEN_RATE * 4) : Buffer.from(`OggS-${input?.length ?? 0}`));
