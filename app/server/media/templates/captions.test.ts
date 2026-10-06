import { describe, expect, it } from 'vitest';
import { capHtml, capLines, capSteps, wordTimes } from './captions.ts';
import { composition, FORMATS, type Shot } from './index.ts';

describe('word timings', () => {
  it('spreads a sentence over its own length, by how long each word takes to say', () => {
    const words = wordTimes([{ text: 'A strategically enormous word.', seconds: 3 }]);
    expect(words.map((one) => one.word)).toEqual(['A', 'strategically', 'enormous', 'word.']);
    expect(words[0].at).toBe(0);
    // A long word holds the screen longer than a short one, and none of them is instant.
    expect(words[1].seconds).toBeGreaterThan(words[0].seconds * 2);
    expect(words[0].seconds).toBeGreaterThan(0.1);
    // The words fill the sentence bar the breath at the end of it.
    const end = words.at(-1)!.at + words.at(-1)!.seconds;
    expect(end).toBeGreaterThan(2.5);
    expect(end).toBeLessThanOrEqual(3);
  });

  it('starts each sentence where the last one really ended, and starts the lot where the sound does', () => {
    const words = wordTimes([{ text: 'One two.', seconds: 2 }, { text: 'Three four.', seconds: 4 }], 10);
    expect(words[0].at).toBe(10);
    expect(words[2].word).toBe('Three');
    expect(words[2].at).toBeCloseTo(12, 2);
    expect(words.at(-1)!.at + words.at(-1)!.seconds).toBeLessThanOrEqual(16);
  });

  it('says nothing about a sentence with no words in it, but still keeps its place on the clock', () => {
    const words = wordTimes([{ text: '   ', seconds: 1.5 }, { text: 'After.', seconds: 1 }]);
    expect(words).toHaveLength(1);
    expect(words[0].at).toBe(1.5);
  });
});

describe('caption lines', () => {
  const at = (word: string, from: number, seconds = 0.3) => ({ word, at: from, seconds });

  it('shows one to three words at a time, never a subtitle', () => {
    const words = 'Investors never fund an idea they fund evidence'.split(' ').map((word, index) => at(word, index * 0.32));
    const lines = capLines(words, 40, 3);
    for (const line of lines) expect(line.words.length).toBeLessThanOrEqual(3);
    expect(lines.flatMap((line) => line.words.map((one) => one.word))).toEqual(words.map((one) => one.word));
  });

  it('breaks by width too, so a line never wraps and strands a word underneath itself', () => {
    const lines = capLines([at('Rooms', 0), at('that', 0.4), at('remember', 0.8), at('everything', 1.2)], 20, 4);
    expect(lines.map((line) => line.words.map((one) => one.word).join(' '))).toEqual(['Rooms that remember', 'everything']);
  });

  it('ends a line at the end of a sentence and wherever the speaker stops for a beat', () => {
    const lines = capLines([at('Done.', 0), at('Next', 0.4), at('one', 3)], 40, 4);
    expect(lines).toHaveLength(3);
    expect(lines[0].words[0].word).toBe('Done.');
    expect(lines[2].words[0].word).toBe('one');
  });

  it('groups by phrase: never across a comma or a full stop, never ending a line on a word that leads into the next', () => {
    const said = (text: string) => text.split(' ').map((word, index) => at(word, index * 0.32));
    const shown = (text: string, most = 3) => capLines(said(text), 26, most).map((line) => line.words.map((one) => one.word).join(' '));
    const hero = shown('A small team of AI people works beside a founder; wires are access, so each person reads only what is wired to them.');
    // The script's own casing, word for word.
    expect(hero.join(' ')).toBe('A small team of AI people works beside a founder; wires are access, so each person reads only what is wired to them.');
    expect(hero).not.toContain('AI people works beside');
    for (const line of hero) {
      // Punctuation that ends a clause ends the line it is in.
      expect(line.slice(0, -1)).not.toMatch(/[,;.!?]/);
      // A line that stops on "of", "a", "the" or "beside" is a line cut in the middle of a phrase.
      if (!/[,;.!?]$/.test(line)) expect(line).not.toMatch(/\b(of|a|the|to|beside|and)$/i);
    }
    expect(hero).toContain('wires are access,');
  });

  it('does not let a pause strand the last word of a sentence, or end a line on "beside" in front of it', () => {
    // The site's hero, as measured: the voice leaned on "beside" before "you." — a pause, but not the end of a thought.
    const words = 'Your own AI team works beside you.'.split(' ').map((word, index) => at(word, index * 0.3 + (index === 6 ? 0.4 : 0), 0.25));
    const shown = capLines(words, 18, 3).map((line) => line.words.map((one) => one.word).join(' '));
    expect(shown).not.toContain('you.');
    expect(shown.some((line) => /beside$/.test(line))).toBe(false);
    expect(shown.join(' ')).toBe('Your own AI team works beside you.');
  });

  it('would rather set one more line than end one on a word that leads into the next', () => {
    const said = (text: string) => text.split(' ').map((word, index) => at(word, index * 0.3));
    // The third hero film, at the full-size caption width: "leaves your" and "A canvas where" were both on screen.
    for (const text of ['and nothing leaves your computer that you did not wire.', 'A canvas where a founder works with a small workforce of people.']) {
      const shown = capLines(said(text), 18, 3).map((line) => line.words.map((one) => one.word).join(' '));
      for (const line of shown.slice(0, -1)) expect(line).not.toMatch(/\b(your|where|a|of|the)$/i);
    }
  });

  it('carries every word once and only once, whatever the budget', () => {
    const words = 'one two three four five six seven eight'.split(' ').map((word, index) => at(word, index * 0.3));
    for (const budget of [6, 12, 20, 40]) {
      expect(capLines(words, budget, 4).flatMap((line) => line.words.map((one) => one.word))).toEqual(words.map((one) => one.word));
    }
  });

  it('lights exactly one word in a line: the one the line turns on', () => {
    const lines = capLines([at('they', 0), at('fund', 0.3), at('evidence', 0.6)], 40, 3);
    expect(lines).toHaveLength(1);
    expect(lines[0].words[lines[0].pop!].word).toBe('evidence');
    // The director's own word beats the longest one.
    const marked = capLines([at('they', 0), at('fund', 0.3), at('evidence', 0.6)], 40, 3, ['fund']);
    expect(marked[0].words[marked[0].pop!].word).toBe('fund');
    // A line of nothing but small words lights none of them.
    expect(capLines([at('it', 0), at('is', 0.3), at('the', 0.6)], 40, 3)[0].pop).toBeUndefined();
  });
});

describe('captions in a film', () => {
  const said = (text: string, from = 0, each = 0.4) => text.split(' ').map((word, index) => ({ word, at: from + index * each, seconds: each * 0.85 }));
  const shot = (seconds: number, say: string): Shot => ({ scene: { layout: 'picture', image_prompt: 'a kite', say }, seconds, image: 'shot-0.png' });

  it('is one track on the frame, outside every scene, so a cut cannot carry it away', () => {
    const words = said('Hello there friend');
    // The quiet packs keep the studio's own track; the editorial pack is one of them.
    const page = composition({
      title: 'One', shape: 'tall', look: 'editorial', captions: true, words,
      voice: { file: 'say.wav', seconds: 3 }, shots: [shot(5, 'Hello there friend')],
    });
    expect(page).toContain('<div class="caps" aria-hidden="true">');
    expect(page).toMatch(/<span class="capword[^"]*" id="c0-0">Hello<\/span>/);
    // Outside the sections altogether, so nothing that moves a scene moves the words being said.
    expect(page.indexOf('class="caps"')).toBeGreaterThan(page.lastIndexOf('</section>'));
    // Held well off the bottom edge, where a phone's own furniture sits.
    expect(page).toContain(`--caps: ${FORMATS.tall.caps}px;`);
    // One recording for the whole film, placed once.
    expect(page).toContain('<audio id="say" src="assets/say.wav" data-start="0"');
  });

  it('draws them with the pack\'s registry component where the pack has one — still one track, still outside every scene', () => {
    const words = said('Hello there friend');
    const film = { title: 'One', shape: 'tall' as const, captions: true, words, voice: { file: 'say.wav', seconds: 3 }, shots: [shot(5, 'Hello there friend')] };
    for (const [look, root] of [['clean', 'pill-karaoke'], ['brand', 'pill-karaoke'], ['creator', 'highlight'], ['neon', 'kinetic-slam']] as const) {
      const page = composition({ ...film, look });
      expect(page, look).toContain(`<div id="${root}">`);
      expect(page, look).not.toContain('class="caps"');
      expect(page.indexOf('class="regcaps"'), look).toBeGreaterThan(page.lastIndexOf('</section>'));
      // In the band the studio's own captions sit in, at the measure they have.
      const { margin, caps, width, safeRight } = FORMATS.tall;
      expect(page, look).toContain(`left: ${margin}px; bottom: ${caps}px; width: ${width - margin - (margin + safeRight)}px`);
      // Its own script, on this film's words, handed to the film's one clock — and nothing fetched to draw it.
      expect(page, look).toContain('"text":"Hello"');
      expect(page, look).toContain('tl.add(registryCaptions().paused(false), 0);');
      expect(page, look).not.toMatch(/https?:\/\/(?!hyperframes\.heygen\.com\/schema)/);
      expect(page, look).toContain('class="has-captions"');
    }
    for (const look of ['editorial', 'documentary', 'sketch'] as const) expect(composition({ ...film, look }), look).toContain('class="caps"');
  });

  it('sets a line too wide for the frame smaller rather than cutting its ends off', () => {
    // A nine-letter word at a tenth of a 1280-high frame is wider than the 562px the band has between the
    // margins, and a real reel showed it centred with its first and last letters clipped by the frame.
    const wide = capLines(said('INVESTORS'), 40, 1);
    const shrunk = capHtml(wide, { size: 138, room: 562 });
    const found = /font-size: ([\d.]+)px/.exec(shrunk);
    expect(found).toBeTruthy();
    expect(Number(found![1])).toBeLessThan(138);
    // Never under two thirds, or it stops being a caption.
    expect(Number(found![1])).toBeGreaterThanOrEqual(138 * 0.66);
    // A short line is left at the size the format asked for.
    expect(capHtml(capLines(said('GO'), 40, 1), { size: 138, room: 562 })).not.toContain('font-size');
    // And nothing is sized at all when no measure was given.
    expect(capHtml(wide)).not.toContain('font-size');
  });

  it('takes the line going before the line coming arrives', () => {
    const lines = capLines(said('One two three four'), 20, 2);
    expect(lines.length).toBeGreaterThan(1);
    const steps = capSteps(lines, 4).join('\n');
    const goes = Number(/#c0", \{ opacity: 0, duration: [\d.]+[^}]*\}, ([\d.]+)\)/.exec(steps)![1]);
    const comes = Number(/fromTo\("#c1", \{ opacity: 0, y: 16[^}]*\}[^}]*\}, ([\d.]+)\)/.exec(steps)![1]);
    expect(goes).toBeLessThanOrEqual(comes);
  });

  it('says nothing over a scene that already writes out the line being said', () => {
    const page = composition({
      title: 'One', shape: 'tall', look: 'clean', captions: true, words: said('Hello there friend'),
      voice: { file: 'say.wav', seconds: 3 },
      shots: [{ scene: { layout: 'hook', text: 'Hello there friend', say: 'Hello there friend' }, seconds: 5 }],
    });
    expect(page).not.toContain('class="caps"');
    expect(page).not.toContain('class="regcaps"');
  });

  it('writes none of it when nothing was said, or when the founder turned it off', () => {
    const silent = composition({ title: 'One', shape: 'wide', look: 'clean', captions: true, shots: [{ scene: { layout: 'statement', text: 'A line.' }, seconds: 4 }] });
    expect(silent).not.toContain('class="caps"');
    expect(silent).not.toContain('class="regcaps"');
    const off = composition({ title: 'One', shape: 'wide', look: 'clean', words: said('Hello there'), voice: { file: 'say.wav', seconds: 2 }, shots: [shot(5, 'Hello there')] });
    expect(off).not.toContain('class="caps"');
    expect(off).not.toContain('class="regcaps"');
    expect(off).toContain('<audio id="say"');
  });
});

describe('a caption word before it is spoken', () => {
  const words = [
    { word: 'Investors', at: 0.2, seconds: 0.4 },
    { word: 'chase', at: 0.6, seconds: 0.3 },
    { word: 'sales.', at: 0.9, seconds: 0.4 },
  ];

  it('is at full strength, because a dimmed stroke over a bright picture is a smear', () => {
    const steps = capSteps(capLines(words, 18, 3, ['sales']), 4);
    const perWord = steps.filter((step) => /#c\d+-\d+/.test(step));
    expect(perWord.length).toBeGreaterThan(0);
    for (const step of perWord) expect(step).not.toMatch(/opacity: 0\.\d/);
  });

  it('snaps up in size as it is said, which is the emphasis', () => {
    const steps = capSteps(capLines(words, 18, 3, ['sales']), 4);
    expect(steps.some((step) => /#c\d+-\d+.*scale: 0\.9.*scale: 1/.test(step))).toBe(true);
  });

  it('still brings the whole line up from nothing and takes it away again', () => {
    const steps = capSteps(capLines(words, 18, 3, ['sales']), 4);
    expect(steps.some((step) => /#c0".*opacity: 0, y: 16/.test(step))).toBe(true);
    expect(steps.some((step) => /tl\.to\("#c0".*opacity: 0/.test(step))).toBe(true);
  });
});

// Journey 12: a frame at 12 s read "ISEVENY". The measured words started "eighty" and "seven" at the same instant,
// and the two caption lines arrived on top of each other in the one place captions sit.
describe('two caption lines that start at the same instant', () => {
  const from = 10.35;
  const said: [string, number, number][] = [['We', 0, 0.35], ['have', 0.35, 0.3], ['reached', 0.66, 0.77], ['eighty', 1.43, 0.06],
    ['seven', 1.43, 0.66], ['euros', 2.09, 0.55], ['MRR.', 2.64, 0.36]];
  const words = said.map(([word, at, seconds]) => ({ word, at: from + at, seconds }));

  it('never shows one line while another is on screen', () => {
    const lines = capLines(words, 8, 1);
    expect(lines.map((line) => `${line.words.map((one) => one.word).join(' ')}@${line.at}`)).toMatchInlineSnapshot(`
      [
        "We@10.35",
        "have@10.7",
        "reached@11.04",
        "eighty@11.78",
        "seven@12.12",
        "euros@12.46",
        "MRR.@12.99",
      ]
    `);
    for (const [index, line] of lines.entries()) {
      if (index) expect(line.at - lines[index - 1].at).toBeGreaterThanOrEqual(0.33);
    }
    // And the timeline agrees: each line has faded before the next arrives.
    const steps = capSteps(lines, 14);
    const time = (pattern: RegExp) => [...steps.join('\n').matchAll(pattern)].map((one) => Number(one[2]));
    const arrive = time(/fromTo\("#c(\d+)", \{ opacity: 0[^\n]*?\}, ([\d.]+)\);/g);
    const leave = [...steps.join('\n').matchAll(/to\("#c(\d+)", \{ opacity: 0, duration: ([\d.]+)[^\n]*?\}, ([\d.]+)\);/g)].map((one) => Number(one[3]) + Number(one[2]));
    expect([arrive.length, leave.length]).toEqual([7, 7]);
    for (let index = 1; index < arrive.length; index += 1) expect(arrive[index]).toBeGreaterThanOrEqual(leave[index - 1] - 1e-6);
  });
});
