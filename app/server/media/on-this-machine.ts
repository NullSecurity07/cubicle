import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { serial } from './turns.ts';

// What the two backends that run here have in common: where the weights live, whether this computer can run them at
// all, how a few gigabytes are fetched the first time, and — the one that matters most — that only one of them runs
// at a time. Two of these together ask for more memory than the machine has, and either of them beside the film's
// own Chrome render asks Chrome to share what it has not got.

export const SETUP_DIR = 'stage-video-models';
export const modelsDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.STAGE_VIDEO_MODELS?.trim() || join(homedir(), '.cache', SETUP_DIR);

// Gigabytes do not belong in memory pretending to be a disk: a cache under /tmp would be re-fetched every reboot
// and, on a machine where /tmp is tmpfs, would eat the very memory the model needs.
export const REAL_DISK = /^\/(tmp|dev\/shm|run)(\/|$)/;

export const vulkanHere = (dirs = ['/usr/share/vulkan/icd.d', '/etc/vulkan/icd.d', '/usr/local/share/vulkan/icd.d']): boolean =>
  dirs.some((one) => existsSync(one));

// One heavy job at a time, whatever kind it is. The queue is the module itself, so a clip and a picture asked for in
// the same second take their turn rather than both asking Vulkan for everything at once.
//
// Whoever asked may have stopped wanting it by the time its turn comes — a picture the measured cut has no shot
// for is stopped while it waits, and two of a film's three hands are always waiting here. A job stopped by then is
// not run at all: it would otherwise clear the graphics card of the resting chat model and then draw for nobody.
const heavy = serial();
export const inTurn = <T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> =>
  heavy(() => (signal?.aborted ? Promise.reject(new Error('stopped')) : job()));

// One file that has to be on disk before anything can be made, and where it really comes from. `unzip` marks the one
// that is an archive rather than a weight.
export type Model = { what: string; file: string; url: string; bytes: number; unzip?: string };

// Everything on disk, fetched once. A spike that proved a model on this machine leaves its weights behind; where
// they are there, they are copied rather than fetched again.
export async function fetchModels(
  at: string, models: Model[], ready: string,
  help: { report: (line: string) => void; signal?: AbortSignal; http?: typeof fetch; from?: string },
): Promise<void> {
  const http = help.http ?? fetch;
  const binary = join(at, 'bin/sd-cli');
  const missing: Model[] = [];
  for (const model of models) {
    const size = await stat(join(at, model.file)).then((one) => one.size, () => 0);
    if (model.unzip ? existsSync(binary) : size > model.bytes * 0.98) continue;
    missing.push(model);
  }
  if (!missing.length) return;
  const gigabytes = Math.round(missing.reduce((sum, one) => sum + one.bytes, 0) / 1e8) / 10;
  help.report(`getting ${ready} ready — ${gigabytes} GB, once, into ${at}`);
  for (const model of missing) {
    const to = join(at, model.file);
    await mkdir(dirname(to), { recursive: true });
    const kept = help.from ? join(help.from, model.file) : '';
    if (!model.unzip && kept && existsSync(kept)) {
      help.report(`${model.what}: already on this machine, copying it across…`);
      await copyFile(kept, to);
    } else {
      help.report(`${model.what}: ${Math.round(model.bytes / 1e8) / 10} GB…`);
      const answer = await http(model.url, { signal: help.signal, redirect: 'follow' });
      if (!answer.ok || !answer.body) throw new Error(`${model.what} could not be fetched (${answer.status})`);
      const chunks: Uint8Array[] = [];
      let got = 0;
      let said = 0;
      for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
        got += chunk.length;
        const whole = Math.floor((got / model.bytes) * 10) * 10;
        if (whole > said) { said = whole; help.report(`${model.what}, ${Math.min(whole, 100)}%…`); }
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
      help.report(`${model.what}: unpacking…`);
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
  help.report(`${ready} is ready; it will not need fetching again`);
}
