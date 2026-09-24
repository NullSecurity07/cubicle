import { runLines } from './proc.ts';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Clip, ClipAsk, Clips, Help } from './clips.ts';
import { ff, FFMPEG } from './ff.ts';
import { makeRoom, NEEDS_MB, plainLine, whatWentWrong, WRONG } from './gpu-room.ts';
import { fetchModels, inTurn, modelsDir, REAL_DISK, SETUP_DIR, vulkanHere, type Model } from './on-this-machine.ts';
import { moveOf } from './moves.ts';
import { CAPS } from './spec.ts';

// Moving pictures made on this machine, with nobody's quota and nothing leaving the house: stable-diffusion.cpp (MIT)
// driving Wan2.1-T2V-1.3B through Vulkan, with a tiny autoencoder in place of the full one and a four-step adapter in
// place of fifty steps. Measured on the founder's box: 832×480, 49 frames (three seconds), four steps, 2 minutes 41
// seconds, 3.2 GB of video memory and 22 GB of system memory at its peak. That last number is why this asks first.
//
// It is slow and it is unlimited, which is the opposite of the Spaces backend, so the studio tries this one first for
// b-roll. It cannot make a talking head at all: the only local route for that is under a non-commercial licence, and a
// founder's marketing film is commercial, so talking heads stay with the Spaces.

// Where the weights live, whether this computer can run them, how they are fetched and the one-at-a-time queue all
// belong to both of the backends that run here, so they live beside them rather than in either one.
export { SETUP_DIR, modelsDir, REAL_DISK, vulkanHere, type Model } from './on-this-machine.ts';
// Where the spike that proved this left its weights. If they are there, they are copied rather than fetched again.
const SPIKE = join(homedir(), '.cache/local-video-spike');

// What has to be on disk before a single frame can be made, and where each piece really comes from. The renderer is
// MIT; the video model and the words model are Apache-2.0; see templates/assets/CREDITS.md for the adapter, which is
// the one piece whose re-host states no licence of its own.
const HF = 'https://huggingface.co';
export const MODELS: Model[] = [
  {
    what: 'the renderer', file: 'bin/sd-vulkan.zip', unzip: 'bin', bytes: 38_406_048,
    url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-874-656a135/sd-master-656a135-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip',
  },
  {
    what: 'the video model', file: 'diffusion/wan2.1_t2v_1.3B_fp16.safetensors', bytes: 2_838_303_560,
    url: `${HF}/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors`,
  },
  {
    what: 'the words model', file: 'text_encoders/umt5-xxl-encoder-Q3_K_S.gguf', bytes: 2_858_489_696,
    url: `${HF}/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q3_K_S.gguf`,
  },
  {
    what: 'the fast decoder', file: 'taew2_1.safetensors', bytes: 22_642_926,
    url: `${HF}/Kijai/WanVideo_comfy/resolve/main/taew2_1.safetensors`,
  },
  // The name of this file is part of how it is used: the prompt names the adapter by its own stem.
  {
    what: 'the four-step adapter', file: 'loras/wan21_sf_dmd_1_3B_r32.safetensors', bytes: 91_233_416,
    url: `${HF}/Kijai/WanVideo_comfy/resolve/main/LoRAs/Wan2_1_self_forcing_1_3B/Wan2_1_self_forcing_dmd_1_3B_lora_rank_32_fp16.safetensors`,
  },
];
export const LORA = 'wan21_sf_dmd_1_3B_r32';
export const DOWNLOAD_GB = Math.round(MODELS.reduce((sum, one) => sum + one.bytes, 0) / 1e8) / 10;

// The envelope this was proven in, and nothing outside it. Wan2.1 at 1.3B makes mush at any size but its own, and a
// longer clip is more memory than this machine has to give.
//
// A clip is drawn in the shape of the film it is going into. Every clip used to be drawn wide, and a phone reel
// then cut the middle out of it — so a person framed from the waist up arrived as a face, and the founder's words
// for that were "no body and hand movement". All three of these hold about a million pixels, which is what the
// model was trained near; each was drawn and looked at on the founder's own machine.
export const FRAME = { width: 832, height: 480, frames: 49, fps: 16, steps: 4 };
export const SHAPES = {
  wide: { width: 832, height: 480 },
  tall: { width: 480, height: 832 },
  square: { width: 624, height: 624 },
} as const;
export type ClipShape = keyof typeof SHAPES;
export const frameOf = (shape: unknown): { width: number; height: number } =>
  SHAPES[(typeof shape === 'string' && shape in SHAPES ? shape : 'wide') as ClipShape];
export const CLIP_SECONDS = Math.round((FRAME.frames / FRAME.fps) * 10) / 10;
// About what one costs in wall time here, said on the card before the founder switches it on.
export const MINUTES_EACH = 3;

export const NEEDS_RAM_GB = 22;
// A founder who knows their own machine — plenty of swap, nothing else running — can lower the bar. Below it the
// clip still gets made; it just leans on swap, which is slow rather than fatal.
export const needsRam = (env: NodeJS.ProcessEnv = process.env): number => {
  const asked = Number(env.STAGE_VIDEO_RAM_GB);
  return Number.isFinite(asked) && asked >= 4 ? asked : NEEDS_RAM_GB;
};
const GB = 1024 * 1024;
// What could be given to a model right now: free memory plus everything the kernel would drop to make room.
export async function availableRam(read = () => readFile('/proc/meminfo', 'utf8')): Promise<number | null> {
  const text = await read().catch(() => null);
  const found = text && /^MemAvailable:\s+(\d+) kB$/m.exec(text);
  return found ? Number(found[1]) / GB : null;
}

export const LEAST_RAM_GB = 12;
// What the kernel could hand a model if it pushed everything it can out to disk. Swap is not memory — a model leaning
// on it crawls — but it is the difference between a clip that takes a long while and no clip at all, and this very
// clip has been made on this machine with about eleven gigabytes free and swap behind it. So it counts, and the old
// flat refusal at twenty-two gigabytes was simply wrong about what this computer can do.
export async function availableSwap(read = () => readFile('/proc/meminfo', 'utf8')): Promise<number | null> {
  const text = await read().catch(() => null);
  const found = text && /^SwapFree:\s+(\d+) kB$/m.exec(text);
  return found ? Number(found[1]) / GB : null;
}

// Whether there is room to film here, and what to say about it. Three answers, because there are three real cases:
// plenty (say nothing), enough only by leaning on swap (make it, but warn first, because a founder who is told it
// will take three minutes and waits twenty thinks the app has hung), and genuinely too little (do not start).
export type Room = { answer: 'yes' | 'slow' | 'no'; line: string };
export function roomToFilm(
  { ram, swap, needs = NEEDS_RAM_GB, least = LEAST_RAM_GB }: { ram: number | null; swap?: number | null; needs?: number; least?: number },
): Room {
  // A machine that will not say how much it has is given the benefit of the doubt, as it always was.
  if (ram === null) return { answer: 'yes', line: '' };
  if (ram >= needs) return { answer: 'yes', line: '' };
  const behind = swap ?? 0;
  // The floor: below this there is not enough real memory to hold the model at all, and swap only makes it thrash.
  // A founder who lowered the bar themselves lowers the floor by the same share, so their setting still means
  // something; it never rises above the twelve gigabytes this was measured at.
  const floor = Math.min(least, (needs * least) / NEEDS_RAM_GB);
  if (ram < floor || ram + behind < needs) {
    return {
      answer: 'no',
      line: `there is ${Math.round(ram)} GB of memory free and ${Math.round(behind)} GB of swap behind it, and a local clip needs about ${needs} GB between them. The founder closes a few things, or turns to the free online clips.`,
    };
  }
  return {
    answer: 'slow',
    line: `there is ${Math.round(ram)} GB of memory free, so this leans on swap: the clip will still be made, but slower than the usual ${MINUTES_EACH} minutes.`,
  };
}

export const SLOW_HINT = `Making a clip on this computer takes about ${MINUTES_EACH} minutes and needs ${NEEDS_RAM_GB} GB of memory and swap together.`;

const run = (command: string, args: string[], at: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<number> =>
  runLines(command, args, {
    cwd: at, env: { ...process.env, LD_LIBRARY_PATH: `${join(at, 'bin')}:${process.env.LD_LIBRARY_PATH ?? ''}` },
    onLine: (line) => onLine(line.trim()), signal,
  }).then((ran) => ran.code);

// A number of steps in the renderer's own chatter, so the card can say how far along it is rather than going quiet
// for three minutes.
const STEP = /\|\s*(\d+)\/(\d+)\s*-\s*[\d.]+(s\/it|it\/s)/;

// What the clip model is asked for: what the clip is of, and then what the camera does, in one clause it reads. The
// move goes on the end so the subject leads, and the whole is held to the storyboard's own cap: when there is no
// room for both, the subject is shortened at a word and the move kept, because a clip of the right thing that does
// not move as asked is still the right thing, and one cut off mid-word is not.
export function clipPrompt(ask: Pick<ClipAsk, 'prompt' | 'move'>): string {
  const subject = ask.prompt.trim().replace(/[\s,.;]+$/, '');
  const move = moveOf(ask.move);
  const phrase = move && (move.kind === 'motion' || move.wanReads) ? move.wan : '';
  if (!phrase) return subject.slice(0, CAPS.clip_prompt);
  const room = CAPS.clip_prompt - phrase.length - 2;
  const cut = subject.length <= room ? subject : subject.slice(0, room).replace(/\s+\S*$/, '').replace(/[\s,.;]+$/, '');
  return `${cut}, ${phrase}`;
}

export type LocalDeps = { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: () => number };

export function localClips(deps: LocalDeps = {}): Clips {
  const env = deps.env ?? process.env;
  const http = deps.fetch ?? fetch;
  const at = modelsDir(env);
  const binary = join(at, 'bin/sd-cli');

  function why(): string | null {
    if (env.STAGE_NO_LOCAL_CLIPS === '1') return 'local clips are switched off in this machine\'s settings.';
    if (REAL_DISK.test(at)) return `the video models would be kept in ${at}, which is memory pretending to be a disk. The founder sets STAGE_VIDEO_MODELS to a folder on a real disk.`;
    if (!vulkanHere()) return 'this computer has no Vulkan graphics driver, which the local video model needs. The founder installs their card\'s Vulkan driver, or turns to the free online clips instead.';
    return null;
  }

  return {
    ready: why,
    async broll(ask: ClipAsk, help: Help): Promise<Clip> {
      const stopped = why();
      if (stopped) throw new Error(stopped);
      return inTurn(async () => {
        // Room on the graphics card first: a chat model resting there holds system memory too, so the memory below
        // is counted after it has been let go of.
        await makeRoom(NEEDS_MB.clip, help.report, { env, fetch: http });
        // Asked at the last moment, not at start: what a machine can spare changes minute to minute. Both numbers
        // come out of one reading of the file, so memory and swap are describing the same moment.
        const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => '');
        const held = async () => meminfo;
        const room = roomToFilm({ ram: await availableRam(held), swap: await availableSwap(held), needs: needsRam(env) });
        if (room.answer === 'no') throw new Error(room.line);
        if (room.answer === 'slow') help.report(room.line);
        await fetchModels(at, MODELS, 'the video model', { report: help.report, signal: help.signal, http, from: SPIKE });
        const work = join(at, 'work', Date.now().toString(36));
        await mkdir(work, { recursive: true });
        try {
          const webm = join(work, 'clip.webm');
          help.report(`making ${CLIP_SECONDS} seconds here on this computer — about ${MINUTES_EACH} minutes…`);
          const started = Date.now();
          let said = 0;
          const wrong: string[] = [];
          const code = await run(binary, [
            '-M', 'vid_gen',
            '--diffusion-model', join(at, 'diffusion/wan2.1_t2v_1.3B_fp16.safetensors'),
            '--tae', join(at, 'taew2_1.safetensors'),
            '--t5xxl', join(at, 'text_encoders/umt5-xxl-encoder-Q3_K_S.gguf'),
            '--lora-model-dir', join(at, 'loras'),
            '-p', `${clipPrompt(ask)}<lora:${LORA}:1.0>`,
            // Every one of these was measured, and the film is mush without them: no guidance (the adapter replaces
            // it), four steps, the flow shift the adapter was trained at, the tiny decoder, and the weights kept in
            // system memory rather than on a four-gigabyte card.
            '--cfg-scale', '1.0', '--sampling-method', 'euler', '--steps', String(FRAME.steps),
            '-W', String(frameOf(ask.shape).width), '-H', String(frameOf(ask.shape).height),
            '--video-frames', String(FRAME.frames), '--fps', String(FRAME.fps), '--flow-shift', '5.0',
            '--diffusion-fa', '--offload-to-cpu', '--vae-tiling',
            '-o', webm,
          ], at, (line) => {
            const step = STEP.exec(line);
            // What it said when it went wrong, so the founder is told why rather than guessed at.
            if (!step && WRONG.test(line)) wrong.push(plainLine(line));
            if (!step || Number(step[1]) <= said) return;
            said = Number(step[1]);
            help.report(`making it… step ${step[1]} of ${step[2]}`);
          }, help.signal);
          if (help.signal?.aborted) throw new Error('stopped');
          if (code !== 0 || !existsSync(webm)) throw new Error(`the local video model did not finish${wrong.length ? `: ${whatWentWrong(wrong)}` : '; there may not have been enough memory'}`);
          // The renderer writes VP9; the film is cut in H.264, so it is re-wrapped once here.
          const mp4 = join(work, 'clip.mp4');
          await ff(FFMPEG, ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', mp4], help.signal, 300);
          help.report(`made it in ${Math.round((Date.now() - started) / 1000)} seconds`);
          return { ext: 'mp4', bytes: await readFile(mp4) };
        } finally {
          await rm(work, { recursive: true, force: true }).catch(() => {});
        }
      }, help.signal);
    },
    async presenter(): Promise<Clip> {
      // The local route for this is Wav2Lip, whose licence forbids commercial use, and a founder's marketing film is
      // commercial. So this one is not made here at all, and the free Spaces take it.
      throw new Error('a talking head cannot be made on this machine; the free online clips make those');
    },
  };
}

// Stands in for the local model in every test and fake run: instant, offline, and the same tiny clip every time.
const CLIP = 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAr5tZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhAAAAFGJ0cnQAAAAAAAAaGAAAAAA=';
export const fakeLocalClips: Clips = {
  ready: () => null,
  async broll(ask, { report }) {
    report(`making ${CLIP_SECONDS} seconds of ${ask.prompt} here on this computer…`);
    return { ext: 'mp4', bytes: Buffer.from(CLIP, 'base64') };
  },
  async presenter() { throw new Error('a talking head cannot be made on this machine; the free online clips make those'); },
};
