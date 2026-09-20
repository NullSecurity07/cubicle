import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { Maker } from './jobs.ts';
import { lettered, typeset, wordless } from './lettering.ts';

const blank = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 30, g: 52, b: 96 } } }).png().toBuffer();

describe('wordless', () => {
  it('takes the quoted words out, because quotes are what a model tries hardest to spell', () => {
    const said = wordless('a bright studio photograph of a mug with "Peak XV Partners" on it');
    expect(said).not.toMatch(/Peak XV/);
    expect(said).not.toMatch(/"/);
    expect(said).toMatch(/bright studio photograph of a mug/);
  });

  it('takes out the clause that asks for a title, up to the next comma', () => {
    const said = wordless('a modern illustration of Indian city skylines, with the title "India Venture Capital", golden light');
    expect(said).not.toMatch(/title/i);
    expect(said).not.toMatch(/India Venture/);
    expect(said).toMatch(/Indian city skylines/);
    expect(said).toMatch(/golden light/);
  });

  it('swaps the nouns that are made of lettering for ones that are made of pictures', () => {
    expect(wordless('a sleek modern infographic style illustration')).toMatch(/editorial illustration/);
    expect(wordless('a sleek modern infographic style illustration')).not.toMatch(/infographic/i);
    expect(wordless('a bold poster of a rocket')).not.toMatch(/poster/i);
    expect(wordless('a banner for a festival')).not.toMatch(/banner/i);
  });

  it('ends with one firm sentence about there being no lettering, and only ever one', () => {
    const once = wordless('a paper plane over a city');
    expect(once.match(/no text/gi)?.length).toBe(1);
    expect(wordless(once)).toBe(once);
    expect(wordless(wordless(wordless('a paper plane over a city')))).toBe(once);
  });

  it('never hands a model an empty prompt, however much was taken out', () => {
    const said = wordless('with the title "Everything"');
    expect(said.trim().length).toBeGreaterThan(10);
    expect(wordless('')).toBe(wordless(''));
    expect(wordless('').trim().length).toBeGreaterThan(10);
  });

  it('leaves an ordinary scene alone apart from the sentence at the end', () => {
    const scene = 'a golden retriever asleep on a sunlit wooden floor, shallow depth of field, warm afternoon light';
    const said = wordless(scene);
    expect(said.startsWith(scene)).toBe(true);
  });
});

describe('typeset', () => {
  const words = {
    headline: "Top VCs backing India's founders",
    lines: ['Peak XV Partners', 'Accel India', 'Blume Ventures', 'Nexus Venture Partners', 'Kalaari Capital'],
  };

  for (const [width, height] of [[1024, 1024], [1280, 768], [768, 1280]] as const) {
    it(`sets the words on a ${width}×${height} picture and hands back a PNG of the same size`, async () => {
      const before = await blank(width, height);
      const after = await typeset(before, words);
      expect(after.equals(before)).toBe(false);
      const meta = await sharp(after).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['png', width, height]);
    });
  }

  it('hands the picture straight back when there is nothing to set on it', async () => {
    const before = await blank(512, 512);
    expect(await typeset(before, {})).toBe(before);
    expect(await typeset(before, { headline: '   ', lines: ['', ' '] })).toBe(before);
  });

  it('sets characters that would otherwise break the overlay', async () => {
    const before = await blank(1024, 1024);
    const after = await typeset(before, { headline: 'Ben & Co <Ventures>', lines: ['"Series A" & beyond', '<b>not markup</b>'] });
    expect((await sharp(after).metadata()).width).toBe(1024);
  });

  it('holds a headline and a list far longer than they should be', async () => {
    const before = await blank(768, 1280);
    const after = await typeset(before, {
      headline: `${'Absurdly long headline '.repeat(12)}`,
      lines: Array.from({ length: 14 }, (_, index) => `${index} ${'a very long line of names and numbers '.repeat(5)}`),
    });
    expect((await sharp(after).metadata()).height).toBe(1280);
  });
});

describe('lettered', () => {
  const inner = (piece: () => Promise<Buffer>): { maker: Maker; asked: { prompt: string }[] } => {
    const asked: { prompt: string }[] = [];
    return {
      asked,
      maker: {
        name: 'test',
        ready: () => null,
        async make(ask) {
          asked.push({ prompt: String(ask.prompt ?? '') });
          return { ext: 'png', bytes: await piece(), by: 'test' };
        },
      },
    };
  };

  it('asks the model for a wordless picture, whatever it was asked for', async () => {
    const { maker, asked } = inner(() => blank(256, 256));
    await lettered(maker).make({ prompt: 'an infographic with the title "Top VCs"' }, { report: () => {} });
    expect(asked[0].prompt).toBe(wordless('an infographic with the title "Top VCs"'));
  });

  it('sets the words over the picture when there are words, and says it is doing it', async () => {
    const { maker } = inner(() => blank(512, 512));
    const said: string[] = [];
    const plain = await lettered(maker).make({ prompt: 'a city' }, { report: (line) => said.push(line) });
    const set = await lettered(maker).make({ prompt: 'a city', headline: 'Top VCs', lines: ['Accel India'] }, { report: (line) => said.push(line) });
    expect(said.some((line) => /real type/.test(line))).toBe(true);
    expect(set.bytes.equals(plain.bytes)).toBe(false);
    expect(set.by).toBe('test');
    expect(set.ext).toBe('png');
  });

  it('still hands over the picture when the words cannot be set, and says so plainly', async () => {
    const { maker } = inner(async () => Buffer.from('this is not a picture'));
    const said: string[] = [];
    const piece = await lettered(maker).make({ prompt: 'a city', headline: 'Top VCs' }, { report: (line) => said.push(line) });
    expect(piece.bytes.toString()).toBe('this is not a picture');
    expect(said.some((line) => /could not be set/.test(line))).toBe(true);
  });
});
