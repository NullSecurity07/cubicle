import { ff, FFMPEG } from './ff.ts';

// The founder's own footage, made fit for the film. Whatever they dropped — a phone clip, a screen recording, a
// downloaded export — is re-encoded to one codec, one frame rate and exactly the frame the film is in, so the
// renderer never has to think about it and a 4K vertical clip does not become a letterboxed postage stamp.

// A clip is cut to the frame the way a picture is: filled, then trimmed, never squeezed.
export const cover = (width: number, height: number) =>
  `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=bicubic,crop=${width}:${height},setsar=1`;

export type Cut = { from: string; to: string; width: number; height: number; start?: number; seconds?: number; mute?: boolean; signal?: AbortSignal };

export async function normalise(cut: Cut): Promise<void> {
  const args = ['-y', '-loglevel', 'error'];
  // Seeking before the input is the fast one, and on a re-encode it is exact enough for a cut.
  if (cut.start && cut.start > 0) args.push('-ss', cut.start.toFixed(2));
  args.push('-i', cut.from);
  if (cut.seconds && cut.seconds > 0) args.push('-t', cut.seconds.toFixed(2));
  args.push('-vf', `${cover(cut.width, cut.height)},fps=30`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-g', '60');
  if (cut.mute === false) args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  else args.push('-an');
  args.push('-movflags', '+faststart', cut.to);
  await ff(FFMPEG, args, cut.signal, 900);
}

// One frame out of a dropped clip, small, for the tray on the card to show what the file is.
export async function thumbOf(from: string, to: string, at = 0.5, signal?: AbortSignal): Promise<void> {
  await ff(FFMPEG, ['-y', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', from, '-frames:v', '1',
    '-vf', 'scale=320:-2:flags=bicubic', to], signal, 120);
}

// A still the founder dropped, made into the film's frame. The same cover fit, so a portrait photo in a wide film is
// cropped to its middle rather than pillarboxed.
export async function fitStill(from: string, to: string, width: number, height: number, signal?: AbortSignal): Promise<void> {
  await ff(FFMPEG, ['-y', '-loglevel', 'error', '-i', from, '-vf', cover(width, height), '-frames:v', '1', to], signal, 120);
}
