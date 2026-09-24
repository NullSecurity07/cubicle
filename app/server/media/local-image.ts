import { runLines } from './proc.ts';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Maker, Piece } from './jobs.ts';
import { makeRoom, NEEDS_MB, plainLine, whatWentWrong, WRONG } from './gpu-room.ts';
import { fetchModels, inTurn, modelsDir, REAL_DISK, vulkanHere, type Model } from './on-this-machine.ts';

// Pictures made on this machine, with nobody's quota and nothing leaving the house.
//
// Both free picture services ran dry inside one afternoon and a founder's film came out as coloured fog. A machine
// that can draw is a machine that never runs out, so this is stable-diffusion.cpp (MIT) driving Z-Image-Turbo
// through Vulkan: a six-billion-parameter model distilled to draw in four steps rather than fifty, quantised to
// four bits, with a Qwen3-4B text encoder reading the prompt. Everything in that sentence is Apache-2.0, which is
// what lets a founder sell a film made with it.
//
// Measured on the founder's box, an RTX 3050 laptop with 4 GB of video memory beside 27 GB of system memory:
// 1024×1024 in 53 seconds, 768×1344 in 50, 1344×768 in 51, about 6.2 GB of weights held in system memory. The card
// is too small to hold the model, so the weights stay in RAM and are streamed in as they are needed, about 2.1 GB of
// them on the card at a time. No device is named, and the renderer's own first choice is the NVIDIA card (Vulkan1).
// That is the right one: forced onto the integrated graphics with GGML_VK_VISIBLE_DEVICES=0 the same picture took
// 303 seconds and then lost the device. What goes wrong on the NVIDIA card is somebody else holding it, so a picture
// first makes room there (gpu-room.ts).
export const PICTURES_DIR = 'pictures';
// Where the spike that proved this left its weights. If they are there, they are copied rather than fetched again.
const SPIKE = join(homedir(), '.cache/local-image-spike');
const HF = 'https://huggingface.co';

// The renderer is shared with the local clip maker and fetched by whichever of them is asked first.
export const MODELS: Model[] = [
  {
    what: 'the renderer', file: 'bin/sd-vulkan.zip', unzip: 'bin', bytes: 38_406_048,
    url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-874-656a135/sd-master-656a135-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip',
  },
  {
    what: 'the picture model', file: `${PICTURES_DIR}/z_image_turbo-Q4_K.gguf`, bytes: 3_864_250_304,
    url: `${HF}/leejet/Z-Image-Turbo-GGUF/resolve/main/z_image_turbo-Q4_K.gguf`,
  },
  {
    what: 'the words model', file: `${PICTURES_DIR}/Qwen3-4B-Instruct-2507-Q4_K_M.gguf`, bytes: 2_497_281_120,
    url: `${HF}/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf`,
  },
  {
    what: 'the decoder', file: `${PICTURES_DIR}/z_image_vae.safetensors`, bytes: 167_666_902,
    url: `${HF}/Tongyi-MAI/Z-Image-Turbo/resolve/main/vae/diffusion_pytorch_model.safetensors`,
  },
];
export const DOWNLOAD_GB = Math.round(MODELS.reduce((sum, one) => sum + one.bytes, 0) / 1e8) / 10;

// The envelope this was proven in. Z-Image draws at a million pixels; asked for much more it loses the plot and
// takes minutes, so the three shapes are its own near-square, tall and wide sizes and nothing else.
export const SIZES = {
  square: { width: 1024, height: 1024 },
  tall: { width: 768, height: 1344 },
  wide: { width: 1344, height: 768 },
} as const;
// A draft is the same three shapes at a little over half the pixels. Nearly all of a picture's minute is the four
// drawing steps, and those cost by the pixel: measured here, a tall draft is 28 seconds where the full one is 50.
// It is scaled up into the frame behind a scrim and a line of type, which is where nobody counts pixels.
export const DRAFT_SIZES = {
  square: { width: 768, height: 768 },
  tall: { width: 576, height: 1024 },
  wide: { width: 1024, height: 576 },
} as const;
export type Shape = keyof typeof SIZES;
export const sizeOf = (shape: unknown, size?: unknown): { width: number; height: number } =>
  (size === 'draft' ? DRAFT_SIZES : SIZES)[(typeof shape === 'string' && shape in SIZES ? shape : 'square') as Shape];

// Four steps is what the model was distilled for; eight is no better and takes twice as long.
export const STEPS = 4;
// About what one costs in wall time here, said on the card before anybody waits for it.
export const SECONDS_EACH = 55;
export const SECONDS_EACH_DRAFT = 30;
// The weights alone are 6.2 GB, and the renderer wants room to work beside them. Below this it would swap, and a
// picture that takes ten minutes is not a picture anybody waited for.
export const NEEDS_RAM_GB = 9;

export const needsRam = (env: NodeJS.ProcessEnv = process.env): number => {
  const asked = Number(env.STAGE_IMAGE_RAM_GB);
  return Number.isFinite(asked) && asked >= 4 ? asked : NEEDS_RAM_GB;
};

const GB = 1024 * 1024;
// What could be given to a model right now: free memory plus everything the kernel would drop to make room.
export const availableRam = async (read = () => readFile('/proc/meminfo', 'utf8')): Promise<number | null> => {
  const text = await read().catch(() => null);
  const found = text && /^MemAvailable:\s+(\d+) kB$/m.exec(text);
  return found ? Number(found[1]) / GB : null;
};

// A number of steps in the renderer's own chatter, so the card can say how far along it is rather than going quiet
// for a minute.
const STEP = /\|\s*(\d+)\/(\d+)\s*-/;

export type LocalImageDeps = { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; read?: () => Promise<string> };

export function localImages(deps: LocalImageDeps = {}): Maker {
  const env = deps.env ?? process.env;
  const at = modelsDir(env);
  const binary = join(at, 'bin/sd-cli');

  function why(): string | null {
    if (env.STAGE_IMAGE_BACKEND === 'cloud') return 'drawing here is switched off; this machine is set to use the free services instead.';
    if (env.STAGE_NO_LOCAL_IMAGES === '1') return 'drawing here is switched off in this machine\'s settings.';
    if (REAL_DISK.test(at)) return `the picture model would be kept in ${at}, which is memory pretending to be a disk. The founder sets STAGE_VIDEO_MODELS to a folder on a real disk.`;
    if (!vulkanHere()) return 'this computer has no Vulkan graphics driver, which drawing here needs. The founder installs their card\'s Vulkan driver, or turns to the free services instead.';
    return null;
  }

  return {
    name: 'this computer',
    ready: why,
    async make(ask, help): Promise<Piece> {
      const stopped = why();
      if (stopped) throw new Error(stopped);
      return inTurn(async () => {
        // A picture waits its turn, and whoever asked may have stopped wanting it by the time the turn comes: a
        // film that found its cut had no shot for this one. The renderer is only told to stop if it is running.
        if (help.signal?.aborted) throw new Error('stopped');
        // Room on the graphics card first: a chat model resting there holds system memory too, so the memory below
        // is counted after it has been let go of.
        await makeRoom(NEEDS_MB.picture, help.report, { env, fetch: deps.fetch });
        // Asked at the last moment, not at start: what a machine can spare changes minute to minute, and a picture
        // drawn out of swap takes ten minutes rather than one.
        const spare = await availableRam(deps.read);
        const needs = needsRam(env);
        if (spare !== null && spare < needs) {
          throw new Error(`there is ${spare.toFixed(0)} GB of memory free and drawing here needs about ${needs} GB. The founder closes a few things, or turns to the free services.`);
        }
        await fetchModels(at, MODELS, 'the picture model', { report: help.report, signal: help.signal, http: deps.fetch, from: SPIKE });
        const work = join(at, 'work', `picture-${Date.now().toString(36)}`);
        await mkdir(work, { recursive: true });
        const out = join(work, 'out.png');
        const wrong: string[] = [];
        try {
          const { width, height } = sizeOf(ask.shape, ask.size);
          help.report(`drawing it on this computer — about ${ask.size === 'draft' ? SECONDS_EACH_DRAFT : SECONDS_EACH} seconds`);
          const code = await run(binary, [
            '--diffusion-model', join(at, MODELS[1].file),
            '--llm', join(at, MODELS[2].file),
            '--vae', join(at, MODELS[3].file),
            '-p', String(ask.prompt ?? ''),
            // Everything here was measured. The model is distilled, so it wants no guidance at all; the weights do
            // not fit in 4 GB of video memory, so they are held in system memory and streamed; flash attention and
            // a direct convolution in the decoder together take a fifth off the time and stop the decoder failing
            // on a card this small.
            '--cfg-scale', '1.0', '--steps', String(STEPS),
            '-W', String(width), '-H', String(height),
            // The same words drawn twice give the same picture, so a film re-rendered after one line changed does
            // not quietly restyle every scene.
            '--seed', String(seedOf(ask)),
            '--offload-to-cpu', '--diffusion-fa', '--vae-conv-direct',
            '-o', out,
          ], at, (line) => {
            // The renderer draws a progress bar for every part of itself — the words model, then the picture, then
            // the decoder tile by tile. Only the picture's own steps are worth a founder's attention; the long one
            // at the end is the decoder, and what that means to somebody waiting is "nearly there".
            const step = STEP.exec(line);
            if (step) {
              if (Number(step[2]) === STEPS) help.report(`drawing it… step ${step[1]} of ${step[2]}`);
              else if (Number(step[1]) === 1) help.report('putting the picture together…');
              return;
            }
            // Whatever it said when it went wrong. Without this a founder is told only that it did not work, which is
            // the one thing they already knew.
            if (WRONG.test(line)) wrong.push(plainLine(line));
          }, help.signal);
          if (help.signal?.aborted) throw new Error('stopped');
          if (code !== 0) throw new Error(`the picture could not be drawn on this computer${wrong.length ? `: ${whatWentWrong(wrong)}` : ''}`);
          const bytes = await readFile(out);
          if (!bytes.length) throw new Error('the picture came out empty');
          return { ext: 'png', bytes };
        } finally {
          await rm(work, { recursive: true, force: true }).catch(() => {});
        }
      }, help.signal);
    },
  };
}

// The same prompt drawn twice draws the same picture. A caller that wants a particular one says so; everything else
// gets a number made out of the words themselves, which is stable across runs and different between scenes.
export function seedOf(ask: { seed?: unknown; prompt?: unknown }): number {
  const given = Number(ask.seed);
  if (Number.isFinite(given) && given >= 0) return Math.floor(given);
  let hash = 2166136261;
  for (const letter of String(ask.prompt ?? '')) {
    hash ^= letter.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 2_000_000_000;
}

// The renderer draws its progress bar with carriage returns, so a step is a line only if those count as one.
const run = (command: string, args: string[], at: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<number> =>
  runLines(command, args, {
    cwd: at, env: { ...process.env, LD_LIBRARY_PATH: `${join(at, 'bin')}:${process.env.LD_LIBRARY_PATH ?? ''}` },
    split: /[\n\r]/, onLine: (line) => onLine(line.trim()), signal,
  }).then((ran) => ran.code);
