import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFounder, FULL, PROFILE_CHARS } from './founder.ts';

const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'founder-'));
  return { dir, founder: createFounder(dir) };
};

describe('the founder profile', () => {
  it('starts empty and keeps a line at a time', async () => {
    const { dir, founder } = await setup();
    expect(await founder.read()).toBe('');
    expect(await founder.note('Prefers the short answer first, the reasoning after')).toBe('Noted about the founder.');
    await founder.note('Ships on Thursdays');
    expect(await founder.read()).toBe('- Prefers the short answer first, the reasoning after\n- Ships on Thursdays');
    expect(JSON.parse(await readFile(join(dir, 'founder.json'), 'utf8')).text).toContain('Ships on Thursdays');
    expect(await founder.note('Ships on Thursdays')).toBe('Already noted.');
    expect((await founder.read()).split('\n')).toHaveLength(2);
  });

  it('replaces the line it was pointed at, and says when there is no such line', async () => {
    const { founder } = await setup();
    await founder.note('Ships on Thursdays');
    await founder.note('Hates jargon');
    expect(await founder.note('Ships on Tuesdays now', 'Thursdays')).toBe('That line about the founder now says the new thing.');
    expect(await founder.read()).toBe('- Ships on Tuesdays now\n- Hates jargon');
    await expect(founder.note('Something else', 'their dog')).rejects.toThrow(/no line about "their dog"/);
  });

  it('is full rather than quietly shorter', async () => {
    const { founder } = await setup();
    for (let line = 0; line < 20; line += 1) await founder.note(`A fact about the founder that takes up room, number ${line}`.padEnd(60, '.')).catch(() => {});
    const text = await founder.read();
    expect(text.length).toBeLessThanOrEqual(PROFILE_CHARS);
    await expect(founder.note('One more thing'.padEnd(80, '.'))).rejects.toThrow(FULL);
    expect(await founder.read()).toBe(text);
    // Swapping a line for another is always allowed, full or not.
    expect(await founder.note('Something shorter', 'number 0')).toContain('now says');
  });

  it('takes what the founder wrote themselves, up to the cap', async () => {
    const { founder } = await setup();
    await founder.write('- Their own words\n- On two lines');
    expect(await founder.read()).toBe('- Their own words\n- On two lines');
    await founder.write('x'.repeat(PROFILE_CHARS + 500));
    expect((await founder.read()).length).toBe(PROFILE_CHARS);
  });
});
