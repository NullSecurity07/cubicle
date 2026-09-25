import { joinPcm, pcmSeconds, readPcm, wavOfPcm, type Pcm } from './film-record.ts';
import type { Piece } from './jobs.ts';

// A film read around a line the founder already recorded. The narration is one reading of the whole script, so the
// voice rises and falls as somebody talking does; when one of its lines is a take the founder made in a wired Voice
// studio, that take is the line, and only what comes before it and what comes after it are read — each in one go,
// in the same voice — and the three are joined end to end. The pieces are the sentences each was said in, so the
// captions are timed exactly as they are for a film read all at once.

export type Said = { bytes: Buffer; parts: { text: string; seconds: number }[]; noncommercial?: boolean; credits?: string };

// `lines` are the scenes' own lines in order, `at` the one the take says, `take` the recording itself (a WAV), and
// `say` reads a stretch of words in the film's voice. Nothing when the take cannot be read, so the film is read
// whole instead.
export async function readAround(lines: string[], at: number, take: Buffer, say: (text: string) => Promise<Piece>): Promise<Said | null> {
  const heard = readPcm(take);
  if (!heard || !heard.samples.length || at < 0 || at >= lines.length) return null;
  const before = lines.slice(0, at).map((line) => line.trim()).filter(Boolean).join(' ');
  const after = lines.slice(at + 1).map((line) => line.trim()).filter(Boolean).join(' ');
  const pieces: Pcm[] = [];
  const parts: Said['parts'] = [];
  let noncommercial = false;
  let credits: string | undefined;
  const read = async (text: string) => {
    const piece = await say(text);
    const pcm = readPcm(piece.bytes);
    if (!pcm) throw new Error('the recording could not be read');
    pieces.push(pcm);
    parts.push(...(piece.parts?.length ? piece.parts : [{ text, seconds: pcmSeconds(pcm) }]));
    if (piece.noncommercial) { noncommercial = true; credits ??= piece.credits; }
  };
  if (before) await read(before);
  pieces.push(heard);
  parts.push({ text: lines[at].trim(), seconds: pcmSeconds(heard) });
  if (after) await read(after);
  // The film's own voice sets the rate; a take alone keeps its own.
  const rate = pieces.find((one) => one !== heard)?.rate ?? heard.rate;
  return { bytes: wavOfPcm(joinPcm(pieces, rate)), parts, ...(noncommercial ? { noncommercial: true } : {}), ...(credits ? { credits } : {}) };
}
