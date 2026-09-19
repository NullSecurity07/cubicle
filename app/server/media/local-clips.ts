import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Clip, ClipAsk, Clips, Help } from './clips.ts';
import { ff, FFMPEG } from './ff.ts';

// Moving pictures made on this machine, with nobody's quota and nothing leaving the house: stable-diffusion.cpp (MIT)
// driving Wan2.1-T2V-1.3B through Vulkan, with a tiny autoencoder in place of the full one and a four-step adapter in
// place of fifty steps. Measured on the founder's box: 832×480, 49 frames (three seconds), four steps, 2 minutes 41
// seconds, 3.2 GB of video memory and 22 GB of system memory at its peak. That last number is why this asks first.
//
// It is slow and it is unlimited, which is the opposite of the Spaces backend, so the studio tries this one first for
// b-roll. It cannot make a talking head at all: the only local route for that is under a non-commercial licence, and a
// founder's marketing film is commercial, so talking heads stay with the Spaces.

export const SETUP_DIR = 'stage-video-models';
// Where the spike that proved this left its weights. If they are there, they are copied rather than fetched again.
const SPIKE = join(homedir(), '.cache/local-video-spike');

export const modelsDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.STAGE_VIDEO_MODELS?.trim() || join(homedir(), '.cache', SETUP_DIR);

// Six gigabytes do not belong in memory pretending to be a disk: a cache under /tmp would be re-fetched every reboot
// and, on a machine where /tmp is tmpfs, would eat the very memory the model needs.
export const REAL_DISK = /^\/(tmp|dev\/shm|run)(\/|$)/;

// What has to be on disk before a single frame can be made, and where each piece really comes from. The renderer is
// MIT; the video model and the words model are Apache-2.0; see templates/assets/CREDITS.md for the adapter, which is
// the one piece whose re-host states no licence of its own.
export type Model = { what: string; file: string; url: string; bytes: number; unzip?: string };
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
export const FRAME = { width: 832, height: 480, frames: 49, fps: 16, steps: 4 };
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
export const vulkanHere = (dirs = ['/usr/share/vulkan/icd.d', '/etc/vulkan/icd.d', '/usr/local/share/vulkan/icd.d']): boolean =>
  dirs.some((one) => existsSync(one));

export const SLOW_HINT = `Making a clip on this computer takes about ${MINUTES_EACH} minutes and needs ${NEEDS_RAM_GB} GB of memory free.`;

type Runner = (command: string, args: string[], at: string, onLine: (line: string) => void, signal?: AbortSignal) => Promise<number>;
const run: Runner = (command, args, at, onLine, signal) => new Promise((done, fail) => {
  const child = spawn(command, args, { cwd: at, env: { ...process.env, LD_LIBRARY_PATH: `${join(at, 'bin')}:${process.env.LD_LIBRARY_PATH ?? ''}` } });
  let rest = '';
  const read = (chunk: Buffer) => {
    rest += chunk.toString('utf8');
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) onLine(line.trim());
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  const stop = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', stop, { once: true });
  child.on('error', fail);
  child.on('close', (code) => { signal?.removeEventListener('abort', stop); done(code ?? 1); });
});

// One at a time, always. Two of these together would ask for forty-four gigabytes, and one of these beside the film's
// own render would ask Chrome to share what it has not got.
let turn: Promise<unknown> = Promise.resolve();
const inTurn = <T>(job: () => Promise<T>): Promise<T> => {
  const mine = turn.then(job, job);
  turn = mine.catch(() => {});
  return mine;
};

// A number of steps in the renderer's own chatter, so the card can say how far along it is rather than going quiet
// for three minutes.
const STEP = /\|\s*(\d+)\/(\d+)\s*-\s*[\d.]+(s\/it|it\/s)/;

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

  // Everything on disk, copied from the spike that proved this where it can be and fetched once where it cannot.
  async function fetchModels(report: (line: string) => void, signal?: AbortSignal) {
    const missing: Model[] = [];
    for (const model of MODELS) {
      const size = await stat(join(at, model.file)).then((one) => one.size, () => 0);
      if (model.unzip ? existsSync(binary) : size > model.bytes * 0.98) continue;
      missing.push(model);
    }
    if (!missing.length) return;
    const gigabytes = Math.round(missing.reduce((sum, one) => sum + one.bytes, 0) / 1e8) / 10;
    report(`getting the video model ready — ${gigabytes} GB, once, into ${at}`);
    for (const model of missing) {
      const to = join(at, model.file);
      await mkdir(dirname(to), { recursive: true });
      // The spike that proved this on the founder's machine left its weights behind; they are the same files.
      const kept = join(SPIKE, model.file);
      if (!model.unzip && existsSync(kept)) {
        report(`${model.what}: already on this machine, copying it across…`);
        await copyFile(kept, to);
      } else {
        report(`${model.what}: ${Math.round(model.bytes / 1e8) / 10} GB…`);
        const answer = await http(model.url, { signal, redirect: 'follow' });
        if (!answer.ok || !answer.body) throw new Error(`${model.what} could not be fetched (${answer.status})`);
        const chunks: Uint8Array[] = [];
        let got = 0;
        let said = 0;
        for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) {
          chunks.push(chunk);
          got += chunk.length;
          const whole = Math.floor((got / model.bytes) * 10) * 10;
          if (whole > said) { said = whole; report(`${model.what}, ${Math.min(whole, 100)}%…`); }
        }
        await writeFile(to, Buffer.concat(chunks));
        const size = (await stat(to)).size;
        // A file that came back the wrong size is a redirect to a login page, not a model.
        if (size < model.bytes * 0.98 || size > model.bytes * 1.02) {
          await rm(to, { force: true });
          throw new Error(`${model.what} came back the wrong size (${size} bytes, expected about ${model.bytes})`);
        }
      }
      if (model.unzip) {
        report(`${model.what}: unpacking…`);
        await mkdir(join(at, model.unzip), { recursive: true });
        await new Promise<void>((done, fail) => execFile('python3', ['-m', 'zipfile', '-e', to, join(at, model.unzip!)], (error) => (error ? fail(new Error('the renderer could not be unpacked; this machine needs python3 or unzip')) : done())));
        // The release keeps its files in a folder of its own; flatten whatever came out.
        for (const name of await readdir(join(at, model.unzip), { withFileTypes: true })) {
          if (!name.isDirectory()) continue;
          for (const inner of await readdir(join(at, model.unzip, name.name))) await copyFile(join(at, model.unzip, name.name, inner), join(at, model.unzip, inner)).catch(() => {});
        }
        for (const name of ['sd-cli', 'sd-server']) await chmod(join(at, model.unzip, name), 0o755).catch(() => {});
        if (!existsSync(binary)) throw new Error('the renderer was unpacked but sd-cli is not where it should be');
      }
    }
    report('the video model is ready; it will not need fetching again');
  }

  return {
    ready: why,
    async broll(ask: ClipAsk, help: Help): Promise<Clip> {
      const stopped = why();
      if (stopped) throw new Error(stopped);
      return inTurn(async () => {
        // Asked at the last moment, not at start: what a machine can spare changes minute to minute.
        const spare = await availableRam();
        const needs = needsRam(env);
        if (spare !== null && spare < needs) {
          throw new Error(`there is ${spare.toFixed(0)} GB of memory free and a local clip needs about ${needs} GB. The founder closes a few things, or turns to the free online clips.`);
        }
        await fetchModels(help.report, help.signal);
        const work = join(at, 'work', Date.now().toString(36));
        await mkdir(work, { recursive: true });
        try {
          const webm = join(work, 'clip.webm');
          help.report(`making ${CLIP_SECONDS} seconds here on this computer — about ${MINUTES_EACH} minutes…`);
          const started = Date.now();
          let said = 0;
          const code = await run(binary, [
            '-M', 'vid_gen',
            '--diffusion-model', join(at, 'diffusion/wan2.1_t2v_1.3B_fp16.safetensors'),
            '--tae', join(at, 'taew2_1.safetensors'),
            '--t5xxl', join(at, 'text_encoders/umt5-xxl-encoder-Q3_K_S.gguf'),
            '--lora-model-dir', join(at, 'loras'),
            '-p', `${ask.prompt}<lora:${LORA}:1.0>`,
            // Every one of these was measured, and the film is mush without them: no guidance (the adapter replaces
            // it), four steps, the flow shift the adapter was trained at, the tiny decoder, and the weights kept in
            // system memory rather than on a four-gigabyte card.
            '--cfg-scale', '1.0', '--sampling-method', 'euler', '--steps', String(FRAME.steps),
            '-W', String(FRAME.width), '-H', String(FRAME.height),
            '--video-frames', String(FRAME.frames), '--fps', String(FRAME.fps), '--flow-shift', '5.0',
            '--diffusion-fa', '--offload-to-cpu', '--vae-tiling',
            '-o', webm,
          ], at, (line) => {
            const step = STEP.exec(line);
            if (!step || Number(step[1]) <= said) return;
            said = Number(step[1]);
            help.report(`making it… step ${step[1]} of ${step[2]}`);
          }, help.signal);
          if (help.signal?.aborted) throw new Error('stopped');
          if (code !== 0 || !existsSync(webm)) throw new Error('the local video model did not finish; there may not have been enough memory');
          // The renderer writes VP9; the film is cut in H.264, so it is re-wrapped once here.
          const mp4 = join(work, 'clip.mp4');
          await ff(FFMPEG, ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', mp4], help.signal, 300);
          help.report(`made it in ${Math.round((Date.now() - started) / 1000)} seconds`);
          return { ext: 'mp4', bytes: await readFile(mp4) };
        } finally {
          await rm(work, { recursive: true, force: true }).catch(() => {});
        }
      });
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
