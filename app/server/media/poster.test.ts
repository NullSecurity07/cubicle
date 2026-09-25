import { describe, expect, it } from 'vitest';
import { posterOf } from './poster.ts';
import { captionLines, composition, startsOf, type Film } from './templates/index.ts';
import type { Word } from './templates/captions.ts';

// The hero film's poster was "to what they": a caption caught mid-phrase over the opening. A poster is the opening
// title, settled, with no caption on it.
const said = 'Wire them to what they may read, and they draft, research. A small AI team works beside me, drafting.'.split(' ');
const words: Word[] = said.map((word, at) => ({ word, at: 0.2 + at * 0.4, seconds: 0.3 }));
const film = (first: Film['shots'][number]['scene']): Film => ({
  title: 'Hero', shape: 'wide', look: 'clean', pace: 'calm', captions: true, words,
  shots: [
    { scene: first, seconds: 3.2 },
    { scene: { layout: 'hook', text: 'Wires are access', say: 'Wire them to what they may read, and they draft, research.' }, seconds: 2.8 },
    { scene: { layout: 'picture', say: 'A small AI team works beside me, drafting.' }, seconds: 3 },
  ],
});

describe('the poster frame', () => {
  it('is taken with no caption on it, while the film itself keeps its captions', () => {
    const hero = film({ layout: 'hook', text: 'Wires are access', say: 'Wire them to what they may read, and they draft, research.' });
    expect(captionLines(hero).length).toBeGreaterThan(0);
    const still = posterOf(hero);
    expect(captionLines(still.film)).toEqual([]);
    expect(composition(still.film)).not.toContain('to what they');
    expect(hero.captions).toBe(true);
  });

  it('is the opening headline once it has landed, inside its own shot and clear of the cut', () => {
    const still = posterOf(film({ layout: 'hook', text: 'Wires are access', say: 'Wire them.' }));
    expect(still.at).toBeGreaterThan(1);
    expect(still.at).toBeLessThan(3.2 - 0.2);
  });

  it('skips an opening shot with no words on it for the first shot that writes its title', () => {
    const hero = film({ layout: 'picture', say: 'Wire them to what they may read.' });
    const { starts } = startsOf(hero.shots);
    const still = posterOf(hero);
    expect(still.at).toBeGreaterThan(starts[1]);
    expect(still.at).toBeLessThan(starts[2]);
  });
});
