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
