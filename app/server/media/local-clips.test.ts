import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { firstClips, noClips, type Clips } from './clips.ts';
import {
  availableRam, availableSwap, CLIP_SECONDS, DOWNLOAD_GB, FRAME, LEAST_RAM_GB, LORA, localClips, MINUTES_EACH,
  MODELS, modelsDir, NEEDS_RAM_GB, REAL_DISK, roomToFilm, fakeLocalClips, vulkanHere,
} from './local-clips.ts';

describe('where the local video model is kept', () => {
  it('goes to a real disk in the founder\'s home, and takes a folder they name instead', () => {
    expect(modelsDir({})).toBe(join(homedir(), '.cache/stage-video-models'));
    expect(modelsDir({ STAGE_VIDEO_MODELS: '/data/models' })).toBe('/data/models');
    expect(modelsDir({ STAGE_VIDEO_MODELS: '   ' })).toBe(join(homedir(), '.cache/stage-video-models'));
  });

  it('refuses memory pretending to be a disk, because six gigabytes there is six gigabytes the model cannot have', () => {
    for (const bad of ['/tmp', '/tmp/models', '/dev/shm/x', '/run/user/1000/models']) expect(REAL_DISK.test(bad), bad).toBe(true);
    for (const fine of ['/home/me/.cache/stage-video-models', '/data/tmp/models', '/var/tmp2']) expect(REAL_DISK.test(fine), fine).toBe(false);
    expect(localClips({ env: { STAGE_VIDEO_MODELS: '/tmp/models' } }).ready()).toMatch(/memory pretending to be a disk/);
  });

  it('names every file it needs, where it really comes from, and what the lot weighs', () => {
    expect(MODELS.map((one) => one.what)).toEqual(['the renderer', 'the video model', 'the words model', 'the fast decoder', 'the four-step adapter']);
    for (const model of MODELS) {
      expect(model.url, model.what).toMatch(/^https:\/\/(huggingface\.co|github\.com)\//);
      expect(model.bytes, model.what).toBeGreaterThan(1_000_000);
    }
    // The adapter's own file name is part of how it is used: the prompt names it by its stem.
    expect(MODELS.at(-1)!.file).toBe(`loras/${LORA}.safetensors`);
    // The founder is told the size before any of it starts.
    expect(DOWNLOAD_GB).toBeGreaterThan(5);
    expect(DOWNLOAD_GB).toBeLessThan(7);
  });
});

describe('before a clip is made here', () => {
  it('reads what memory could actually be given to a model, not what is idle right now', async () => {
    const said = await availableRam(async () => 'MemTotal:       28574720 kB\nMemFree:         1000000 kB\nMemAvailable:   23068672 kB\n');
    expect(said).toBeCloseTo(22, 1);
    expect(await availableRam(async () => 'nothing useful')).toBeNull();
    expect(await availableRam(async () => { throw new Error('no such file'); })).toBeNull();
  });

  it('says in plain words what is missing, and never starts without it', async () => {
    expect(localClips({ env: { STAGE_NO_LOCAL_CLIPS: '1' } }).ready()).toMatch(/switched off/);
    const nowhere = localClips({ env: { STAGE_VIDEO_MODELS: '/dev/shm/v' } });
    await expect(nowhere.broll({ prompt: 'a kite', seconds: 3 }, { report: () => {} })).rejects.toThrow(/memory pretending to be a disk/);
    // A machine with no Vulkan driver is told about its driver, not about a stack trace.
    expect(vulkanHere(['/nowhere/at/all'])).toBe(false);
    expect(vulkanHere(['/nowhere', homedir()])).toBe(true);
  });

  it('holds itself to the one envelope it was measured in', () => {
    expect(FRAME).toEqual({ width: 832, height: 480, frames: 49, fps: 16, steps: 4 });
    expect(CLIP_SECONDS).toBeCloseTo(3.1, 1);
    expect(NEEDS_RAM_GB).toBe(22);
    expect(MINUTES_EACH).toBe(3);
  });

  it('will not make a talking head, whose only local route a founder could not sell anything with', async () => {
    await expect(fakeLocalClips.presenter({ portrait: Buffer.alloc(1), speech: Buffer.alloc(1) }, { report: () => {} }))
      .rejects.toThrow('a talking head cannot be made on this machine; the free online clips make those');
  });
});

describe('the order the backends are asked in', () => {
  const said = (name: string, hint: string | null, works: boolean): Clips => ({
    ready: () => hint,
    broll: async (_ask, { report }) => { report(`${name} trying`); if (!works) throw new Error(`${name} failed`); return { ext: 'mp4', bytes: Buffer.from(name) }; },
    presenter: async () => { if (!works) throw new Error(`${name} failed`); return { ext: 'mp4', bytes: Buffer.from(`${name}-face`) }; },
  });

  it('takes this machine first and the network second', async () => {
    const lines: string[] = [];
    const made = await firstClips(said('here', null, true), said('online', null, true))
      .broll({ prompt: 'a kite', seconds: 3 }, { report: (line) => lines.push(line) });
    expect(made.bytes.toString()).toBe('here');
    expect(lines).toEqual(['here trying']);
  });

  it('hands on to the next when the first cannot, and says so', async () => {
    const lines: string[] = [];
    const made = await firstClips(said('here', null, false), said('online', null, true))
      .broll({ prompt: 'a kite', seconds: 3 }, { report: (line) => lines.push(line) });
    expect(made.bytes.toString()).toBe('online');
    expect(lines).toContain('that did not work (here failed); trying another way…');
  });

  it('skips a backend that is not set up, and is ready while any of them is', async () => {
    const some = firstClips(said('here', 'this computer has no Vulkan driver', true), said('online', null, true));
    expect(some.ready()).toBeNull();
    expect((await some.broll({ prompt: 'a kite', seconds: 3 }, { report: () => {} })).bytes.toString()).toBe('online');
    // None of them ready: the founder gets the first hint, not a stack trace.
    const none = firstClips(said('here', 'this computer has no Vulkan driver', true), noClips);
    expect(none.ready()).toBe('this computer has no Vulkan driver');
    await expect(none.broll({ prompt: 'a kite', seconds: 3 }, { report: () => {} })).rejects.toThrow('this computer has no Vulkan driver');
  });

  it('gives up with every reason together when all of them tried and failed', async () => {
    const both = firstClips(said('here', null, false), said('online', null, false));
    await expect(both.broll({ prompt: 'a kite', seconds: 3 }, { report: () => {} })).rejects.toThrow('here failed; online failed');
  });
});

// The bar that a real run tripped over: this machine refused a clip at "21 GB free, needs about 22" although it has
// made that very clip with about 11 GB free and swap behind it. So the question is no longer one number.
describe('whether there is room to film here', () => {
  const meminfo = (ram: number, swap: number) => async () => `MemTotal:       28574720 kB\nMemAvailable:   ${ram * 1024 * 1024} kB\nSwapTotal:      ${swap * 1024 * 1024} kB\nSwapFree:       ${swap * 1024 * 1024} kB\n`;

  it('reads what the kernel could still push out to disk, and shrugs when it cannot tell', async () => {
    expect(await availableSwap(meminfo(21, 16))).toBeCloseTo(16, 1);
    expect(await availableSwap(async () => 'nothing useful')).toBeNull();
    expect(await availableSwap(async () => { throw new Error('no such file'); })).toBeNull();
    // Both numbers come out of the one file, so they always describe the same moment.
    const text = meminfo(21, 16);
    expect(await availableRam(text)).toBeCloseTo(21, 1);
  });

  it('says nothing at all when there is plenty', () => {
    expect(roomToFilm({ ram: 25, swap: 0 })).toEqual({ answer: 'yes', line: '' });
    expect(roomToFilm({ ram: NEEDS_RAM_GB, swap: 0 })).toEqual({ answer: 'yes', line: '' });
    // A machine that will not say how much it has is given the benefit of the doubt, as it always was.
    expect(roomToFilm({ ram: null, swap: null })).toEqual({ answer: 'yes', line: '' });
  });

  it('makes the clip but warns first when the machine will be leaning on swap', () => {
    const near = roomToFilm({ ram: 21, swap: 16 });
    expect(near.answer).toBe('slow');
    expect(near.line).toContain('21 GB of memory free');
    expect(near.line).toContain('swap');
    expect(near.line).toContain(`${MINUTES_EACH} minutes`);
    // The lowest it will start at, and one step above it.
    expect(roomToFilm({ ram: LEAST_RAM_GB, swap: 20 }).answer).toBe('slow');
    expect(roomToFilm({ ram: 12.5, swap: 10 }).answer).toBe('slow');
  });

  it('refuses only when there is too little memory to begin with, or too little of both together', () => {
    // Below the floor, however much swap is behind it: this is thrashing, not filming.
    const thin = roomToFilm({ ram: 11.9, swap: 64 });
    expect(thin.answer).toBe('no');
    expect(thin.line).toContain('12 GB of memory free');
    expect(thin.line).toContain(`about ${NEEDS_RAM_GB} GB between them`);
    // Room to start, but nowhere near enough between them.
    expect(roomToFilm({ ram: 15, swap: 5 }).answer).toBe('no');
    expect(roomToFilm({ ram: 15, swap: 6.9 }).answer).toBe('no');
    expect(roomToFilm({ ram: 15 }).answer).toBe('no');
    expect(roomToFilm({ ram: 15, swap: 7 }).answer).toBe('slow');
  });

  it('follows the founder down when they lower the bar themselves', () => {
    // STAGE_VIDEO_RAM_GB lowers what is needed, and the floor never sits above what is needed.
    expect(roomToFilm({ ram: 9, swap: 0, needs: 8 })).toEqual({ answer: 'yes', line: '' });
    expect(roomToFilm({ ram: 7, swap: 4, needs: 8 }).answer).toBe('slow');
    expect(roomToFilm({ ram: 3, swap: 40, needs: 8 }).answer).toBe('no');
  });
});
