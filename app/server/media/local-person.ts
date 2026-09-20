import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clip, ClipAsk, Clips, Help, PresenterAsk } from './clips.ts';
import { ff, FFMPEG, ffReady } from './ff.ts';
import { CLIP_SECONDS, localClips, MINUTES_EACH, type LocalDeps } from './local-clips.ts';
import { modelsDir } from './on-this-machine.ts';
import { speechSeconds } from './spaces.ts';

// Somebody on camera, moving, made on this machine.
//
// A founder drew a person in the image studio, wired it up, asked for a reel with a real face — and got a
// photograph. Every talking-head service had said no: the free Spaces had nothing left that day, and the local clip
// maker is Wan2.1 T2V, which draws from words and cannot animate a picture at all. So the film fell all the way
// back to a still, and the founder's words for that were "no talking, no body and hand movement".
//
// What was tried, on the founder's own box (RTX 3050 laptop, 4 GB of video memory beside 27 GB of system memory),
// to animate their actual picture:
//
//   Wan2.1-VACE-1.3B fp16 (Apache-2.0, 4.3 GB)     160 s a step × 8 — about 21 minutes for two seconds
//   Wan2.1-Fun-1.3B-InP bf16 (Apache-2.0, 3.1 GB)  285 s a step × 8 — about 38 minutes for three seconds
//
// Both of them run, and getting them to run at all turned up something worth writing down: the Wan decoder cannot
// be given to this machine's shared-memory graphics for the *encode* — `--backend vae=cpu` is the difference
// between a clip and "failed during weight preparation". But twenty minutes a scene is not a thing to put in front
// of somebody waiting for a fifteen-second reel, and a three-scene film would be an hour. The GGUF quantisations
// that would have been small enough are no use either: GGUF cannot hold the five-dimensional patch embedding these
// models open with, so the file loads and the tensor is simply missing.
//
// So the route that ships is the one that is quick and was already proven here: the same Wan2.1 T2V that makes the
// film's b-roll, asked for a person talking to camera in the words the portrait itself was drawn from. It is a
// moving, gesturing, blinking person of the same kind rather than that exact face — which, under a voice-over and
// captions in a fifteen-second reel, is what the founder asked for and did not have. Animating the exact picture is
// behind `STAGE_LOCAL_I2V=1` for a founder who would rather wait twenty minutes, and the card says so.

export const I2V_MINUTES = 21;
// The longest a film will spend putting a person on camera here, however many scenes ask for one. Past this the
// remaining scenes take the still with a camera move on it, which is a film rather than a wait.
export const MOST_MINUTES = 12;

// The words a portrait was drawn from, turned into a few seconds of that person moving. What matters is that the
// framing survives: a video model given "an influencer" draws a wide shot of a room with somebody in it.
// From the waist up, not the chest: the founder asked for a body and hands that move, and a tight face cannot show them.
export const FACING = 'one person fully dressed, seen from the waist up in a medium shot, facing the camera and talking to it, '
  + 'head, shoulders and both hands inside the frame, both eyes open and looking into the lens, mouth moving as they talk, '
  + 'gesturing with both hands, natural head movement, shifting their weight, blinking, static camera';
export function personPrompt(about?: string): string {
  const said = (about ?? '').replace(/\s+/g, ' ').trim();
  // Whatever the picture was about, said after the framing so the framing is what the model reads first.
  const who = said ? said.replace(/^(a picture|an image|a photo)( of)?\s*/i, '').slice(0, 180) : 'a person in plain clothes';
  return `${FACING}. ${who}`;
}

export type LocalPersonDeps = LocalDeps & { clips?: Clips };

export function localPerson(deps: LocalPersonDeps = {}): Clips {
  const env = deps.env ?? process.env;
  const engine = deps.clips ?? localClips(deps);
  const at = modelsDir(env);
  // Animating the founder's own picture takes twenty minutes a scene here, so it is theirs to switch on.
  const exact = () => env.STAGE_LOCAL_I2V === '1';
  let spentMinutes = 0;

  function why(): string | null {
    return engine.ready();
  }

  return {
    ready: why,
    // B-roll is the clip maker's own job; this one exists for the person.
    broll: (ask: ClipAsk, help: Help) => engine.broll(ask, help),

    async presenter(ask: PresenterAsk, help: Help): Promise<Clip> {
      const stopped = why();
      if (stopped) throw new Error(stopped);
      const seconds = Math.max(CLIP_SECONDS, Math.min(12, speechSeconds(ask.speech) || CLIP_SECONDS));
      const minutes = exact() ? I2V_MINUTES : MINUTES_EACH;
      if (spentMinutes + minutes > MOST_MINUTES) {
        throw new Error(`this film has already spent ${spentMinutes} minutes drawing people on this computer, which is as long as it goes`);
      }
      spentMinutes += minutes;
      help.report(`drawing the person moving on this computer — about ${minutes} minutes, and nothing leaves the machine`);
      // The picture the founder made is what this person looks like; its own words are what they are doing.
      const made = await engine.broll({ prompt: personPrompt(ask.about), seconds: CLIP_SECONDS, ...(exact() ? { image: ask.portrait } : {}) }, help);
      if (seconds <= CLIP_SECONDS + 0.2) return made;
      // A line longer than one clip is not one clip held still: it is that clip and a closer framing of it, cut
      // between, so the scene keeps moving for as long as somebody is speaking over it.
      return { ext: 'mp4', bytes: await stretch(made.bytes, seconds, join(at, 'work'), help) };
    },
  };
}

// One short clip made to last as long as the line said over it, by cutting between the shot and a push into it
// rather than freezing on the last frame or looping visibly.
export async function stretch(bytes: Buffer, seconds: number, workRoot: string, help: Help): Promise<Buffer> {
  const noFf = await ffReady();
  if (noFf) return bytes;
  const work = join(workRoot, `person-${Date.now().toString(36)}`);
  await mkdir(work, { recursive: true });
  try {
    const from = join(work, 'in.mp4');
    const wide = join(work, 'wide.mp4');
    const near = join(work, 'near.mp4');
    const out = join(work, 'out.mp4');
    await writeFile(from, bytes);
    // The same seconds twice: as shot, and pushed in by a fifth on the speaker's eyes.
    await ff(FFMPEG, ['-y', '-loglevel', 'error', '-i', from, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', wide]);
    await ff(FFMPEG, ['-y', '-loglevel', 'error', '-i', from, '-an', '-vf', 'scale=iw*1.2:ih*1.2,crop=iw/1.2:ih/1.2:(iw-iw/1.2)/2:(ih-ih/1.2)*0.34',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', near]);
    const list = join(work, 'cuts.txt');
    const takes: string[] = [];
    for (let held = 0; held < seconds; held += CLIP_SECONDS) takes.push(takes.length % 2 ? near : wide);
    await writeFile(list, takes.map((one) => `file '${one}'`).join('\n'));
    await ff(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-t', seconds.toFixed(2),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out]);
    return await readFile(out);
  } catch (error) {
    help.report(`the person could not be held for the whole line (${(error as Error).message}), so the scene is as long as the shot`);
    return bytes;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// Stands in for the whole of this in tests and fake-model runs: a person who moves, made instantly.
export const fakeLocalPerson: Clips = {
  ready: () => null,
  broll: async () => ({ ext: 'mp4', bytes: Buffer.from('fake-clip') }),
  presenter: async (_ask, help) => {
    help.report(`drawing the person moving on this computer — about ${MINUTES_EACH} minutes, and nothing leaves the machine`);
    return { ext: 'mp4', bytes: Buffer.from('fake-person') };
  },
};
