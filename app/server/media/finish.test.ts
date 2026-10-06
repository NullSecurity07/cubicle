import { describe, expect, it } from 'vitest';
import { finishPicture, looking, REDRAWS } from './finish.ts';
import type { Seen, Sight } from './sight.ts';
import type { Scene } from './spec.ts';
import type { Visual } from './visuals.ts';

// A sight that sees whatever it is told each file shows, and cuts any file into planes named after it.
const sightOf = (seen: Record<string, Seen>): Sight & { planed: string[] } => {
  const planed: string[] = [];
  return {
    planed,
    warm: () => {},
    why: () => null,
    look: async (file) => seen[file.split('/').pop()!] ?? null,
    plies: async (file) => { planed.push(file.split('/').pop()!); return { back: 'b.png', mid: 'm.png', fore: 'f.png' }; },
  };
};
const visual: Visual = { at: 0, scene: 0, take: 0, line: 'A founder at a desk', subject: 'a founder at a desk in morning light', kind: 'medium', room: 'foot' };
const scene: Scene = { layout: 'statement', text: 'Ship it', say: 'A founder at a desk.' };
const paint = { quiet: '#999999', ground: '#101010' };
const staring: Seen = { facing: 0.9, lettered: 0.1 };
const fine: Seen = { facing: 0.1, lettered: 0.1 };

describe('finishing a picture', () => {
  it('draws a stranger staring down the lens again, keeps the better one, and says which words made it', async () => {
    const lines: string[] = [];
    const asked: Visual[] = [];
    const done = await finishPicture({
      dir: '/nowhere', file: 'one.png', visual, scene, pack: 'clean', paint, state: looking(), report: (line) => lines.push(line),
      sight: sightOf({ 'one.png': staring, 'one-b.png': fine }),
      redraw: async (again) => { asked.push(again); return 'one-b.png'; },
    });
    expect(done.file).toBe('one-b.png');
    // The record keeps the words that did not summon the stranger, so a remake in a new look draws from them.
    expect(done.visual.subject).not.toContain('founder');
    expect(done.visual.subject).toBe(asked[0].subject);
    expect(lines).toEqual(['a picture came back with somebody looking straight at the camera, so it was drawn again']);
  });

  it('keeps the first picture and its words when the second is no better', async () => {
    const done = await finishPicture({
      dir: '/nowhere', file: 'one.png', visual, scene, pack: 'clean', paint, state: looking(), report: () => {},
      sight: sightOf({ 'one.png': staring, 'one-b.png': staring }),
      redraw: async () => 'one-b.png',
    });
    expect(done.file).toBe('one.png');
    expect(done.visual).toBe(visual);
  });

  it('draws again at most twice a film, and says each fault once', async () => {
    const state = looking();
    const lines: string[] = [];
    let redraws = 0;
    for (let at = 0; at < 4; at += 1) {
      await finishPicture({
        dir: '/nowhere', file: 'one.png', visual, scene, pack: 'clean', paint, state, report: (line) => lines.push(line),
        sight: sightOf({ 'one.png': staring, 'one-b.png': fine }),
        redraw: async () => { redraws += 1; return 'one-b.png'; },
      });
    }
    expect(redraws).toBe(REDRAWS);
    expect(lines).toHaveLength(1);
  });

  it('draws nothing again once the film was stopped', async () => {
    const stop = new AbortController();
    stop.abort();
    let redraws = 0;
    await finishPicture({
      dir: '/nowhere', file: 'one.png', visual, scene, pack: 'clean', paint, state: looking(), stop: stop.signal, report: () => {},
      sight: sightOf({ 'one.png': staring }), redraw: async () => { redraws += 1; return 'one-b.png'; },
    });
    expect(redraws).toBe(0);
  });

  it('cuts the still into planes only where the look moves through them', async () => {
    const moving = sightOf({});
    const documentary = await finishPicture({ dir: '/nowhere', file: 'one.png', visual, scene, pack: 'documentary', paint, state: looking(), report: () => {}, sight: moving });
    expect(documentary.plies).toEqual({ back: 'b.png', mid: 'm.png', fore: 'f.png' });
    const still = sightOf({});
    const clean = await finishPicture({ dir: '/nowhere', file: 'one.png', visual, scene, pack: 'clean', paint, state: looking(), report: () => {}, sight: still });
    expect(clean.plies).toBeUndefined();
    expect(still.planed).toEqual([]);
  });
});

describe('a blank picture', () => {
  const pictures = async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { default: sharp } = await import('sharp');
    const dir = await mkdtemp(join(tmpdir(), 'blank-'));
    const flat = (r: number, g: number, b: number) => sharp({ create: { width: 64, height: 36, channels: 3, background: { r, g, b } } }).png().toBuffer();
    await sharp(await flat(250, 250, 250)).toFile(join(dir, 'white.png'));
    await sharp(await flat(250, 250, 250)).toFile(join(dir, 'white-b.png'));
    await sharp(await flat(4, 4, 4)).toFile(join(dir, 'black.png'));
    // A real picture: a dark-to-light ramp with something in it.
    const ramp = Buffer.alloc(64 * 36 * 3);
    for (let at = 0; at < 64 * 36; at += 1) ramp.fill(Math.round(((at % 64) / 63) * 230), at * 3, at * 3 + 3);
    await sharp(ramp, { raw: { width: 64, height: 36, channels: 3 } }).png().toFile(join(dir, 'real.png'));
    return dir;
  };

  it('is drawn again once, and the real second picture is kept', async () => {
    const dir = await pictures();
    const lines: string[] = [];
    const done = await finishPicture({
      dir, file: 'white.png', visual, scene, pack: 'clean', paint, state: looking(), report: (line) => lines.push(line),
      sight: sightOf({}), redraw: async () => 'real.png',
    });
    expect(done.file).toBe('real.png');
    expect(lines.join(' ')).toMatch(/blank/);
  });

  it('never reaches the film: blank twice, and the scene is left to sit on the look with its words', async () => {
    const dir = await pictures();
    await expect(finishPicture({
      dir, file: 'white.png', visual, scene, pack: 'clean', paint, state: looking(), report: () => {},
      sight: sightOf({}), redraw: async () => 'white-b.png',
    })).rejects.toThrow(/blank/);
    await expect(finishPicture({ dir, file: 'black.png', visual, scene, pack: 'clean', paint, state: looking(), report: () => {} }))
      .rejects.toThrow(/blank/);
  });

  it('is told apart from a real picture by how little it varies, not by how light it is', async () => {
    const { blankness, isBlank } = await import('./contrast.ts');
    const dir = await pictures();
    const { join } = await import('node:path');
    expect(isBlank(await blankness(join(dir, 'white.png')))).toBe(true);
    expect(isBlank(await blankness(join(dir, 'black.png')))).toBe(true);
    expect(isBlank(await blankness(join(dir, 'real.png')))).toBe(false);
    expect(isBlank(await blankness('/nowhere/at-all.png'))).toBe(false);
  });
});

describe('a drawn picture that does not show its scene', () => {
  const corridor = { ...visual, line: 'A dental front desk phone flashing red', subject: 'a dental front desk phone flashing red' };
  const closer = { ...corridor, subject: 'phone, large and clear in the middle of the frame, a dental front desk phone flashing red' };
  const eyes = (present: Record<string, number>): Sight => ({ ...sightOf({}), about: async (file) => present[file.split('/').pop()!] ?? null });

  it('is drawn again closer once, and the closer one is kept when it shows more', async () => {
    const lines: string[] = [];
    const asked: Visual[] = [];
    const done = await finishPicture({
      dir: '/nowhere', file: 'one.png', visual: corridor, scene, pack: 'clean', paint, state: looking(), report: (line) => lines.push(line),
      sight: eyes({ 'one.png': 0.06, 'one-b.png': 0.46 }), subject: { label: 'a photograph of a phone at a dental front desk', closer },
      redraw: async (again) => { asked.push(again); return 'one-b.png'; },
    });
    expect(asked).toEqual([closer]);
    expect(done.file).toBe('one-b.png');
    expect(done.visual).toBe(closer);
    expect(lines).toEqual(['scene 1: the picture did not show a phone at a dental front desk (0.06), so it was drawn again closer (0.46)']);
  });

  it('keeps a picture that shows its scene, and the first one when the second is no better', async () => {
    let redraws = 0;
    const redraw = async () => { redraws += 1; return 'one-b.png'; };
    const shows = await finishPicture({ dir: '/nowhere', file: 'one.png', visual: corridor, scene, pack: 'clean', paint, state: looking(), report: () => {},
      sight: eyes({ 'one.png': 0.7 }), subject: { label: 'a phone', closer }, redraw });
    expect(shows.file).toBe('one.png');
    expect(redraws).toBe(0);
    const worse = await finishPicture({ dir: '/nowhere', file: 'one.png', visual: corridor, scene, pack: 'clean', paint, state: looking(), report: () => {},
      sight: eyes({ 'one.png': 0.1, 'one-b.png': 0.05 }), subject: { label: 'a phone', closer }, redraw });
    expect(worse.file).toBe('one.png');
    expect(redraws).toBe(1);
    const blind = await finishPicture({ dir: '/nowhere', file: 'one.png', visual: corridor, scene, pack: 'clean', paint, state: looking(), report: () => {},
      sight: sightOf({}), subject: { label: 'a phone', closer }, redraw });
    expect(blind.file).toBe('one.png');
    expect(redraws).toBe(1);
  });
});
