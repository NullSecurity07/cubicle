import { execFile } from 'node:child_process';

// The one place this app shells out to ffmpeg. It is already on this machine (the renderer needs it), so nothing here
// installs anything; when it is missing, every part that uses it says so and the film is made without that part.
export const FFMPEG = process.env.STAGE_FFMPEG || 'ffmpeg';
export const FFPROBE = process.env.STAGE_FFPROBE || 'ffprobe';
export const FF_HINT = 'ffmpeg is not on this machine, so music, sound and dropped footage are left out. The founder installs ffmpeg — it is free — and restarts the app.';

const BIG = 64_000_000;

export function ff(bin: string, args: string[], signal?: AbortSignal, seconds = 600): Promise<string> {
  return new Promise((done, fail) => {
    const child = execFile(bin, args, { timeout: seconds * 1000, maxBuffer: BIG, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) return done(stdout);
      // ffmpeg says what went wrong on its last line, and everything before it is the banner.
      const said = (stderr || stdout || error.message).trim().split('\n').filter(Boolean).at(-1) ?? error.message;
      fail(new Error(said.slice(0, 220)));
    });
    signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
  });
}

let known: string | null | undefined;
// Asked once a run: either ffmpeg answers, or the founder is told what to install, in their words.
export async function ffReady(): Promise<string | null> {
  if (known !== undefined) return known;
  known = await ff(FFMPEG, ['-version'], undefined, 15).then(() => null, () => FF_HINT);
  return known;
}

// What a dropped file really is, read out of the file rather than trusted from its name.
export type Track = { seconds: number; width: number; height: number; sound: boolean; kind: 'video' | 'image' | 'audio' };
export async function probe(path: string, signal?: AbortSignal): Promise<Track> {
  const printed = await ff(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], signal, 60);
  const read = JSON.parse(printed) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; duration?: string; disposition?: { attached_pic?: number } }[] };
  const streams = read.streams ?? [];
  const picture = streams.find((one) => one.codec_type === 'video' && !one.disposition?.attached_pic);
  const sound = streams.some((one) => one.codec_type === 'audio');
  const seconds = Number(read.format?.duration ?? picture?.duration ?? 0) || 0;
  // A still has a video stream and no length worth the name; a sound file has no picture at all.
  const kind = !picture ? 'audio' : seconds >= 0.3 ? 'video' : 'image';
  return { seconds, width: picture?.width ?? 0, height: picture?.height ?? 0, sound, kind };
}
