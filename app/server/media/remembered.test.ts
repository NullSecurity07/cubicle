import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filmMemory, MOST_SUBJECTS, storyboardKey, subjectKey } from './remembered.ts';

let dir = '';
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'film-memory-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const asked = { brief: 'a reel about pricing', told: { seconds: 15, shape: 'tall' }, lines: ['it costs nine dollars'], assets: ['logo'] };

describe('the film a draft turns into', () => {
  it('films the draft\'s own storyboard when the full film is asked for next', async () => {
    const memory = filmMemory(dir);
    const key = storyboardKey(asked);
    await memory.keepStoryboard('card-1', { key, speed: 'draft', directed: { title: 'the draft' } });
    expect(await memory.storyboard('card-1', key, 'full')).toEqual({ title: 'the draft' });
  });

  it('directs a new film whenever Make is pressed again at the same speed, because that has always meant "another"', async () => {
    const memory = filmMemory(dir);
    const key = storyboardKey(asked);
    await memory.keepStoryboard('card-1', { key, speed: 'draft', directed: { title: 'the draft' } });
    expect(await memory.storyboard('card-1', key, 'draft')).toBe(null);
    await memory.keepStoryboard('card-1', { key, speed: 'full', directed: { title: 'the film' } });
    expect(await memory.storyboard('card-1', key, 'full')).toBe(null);
  });

  it('forgets the draft the moment anything that decides what the film says has changed', async () => {
    const memory = filmMemory(dir);
    await memory.keepStoryboard('card-1', { key: storyboardKey(asked), speed: 'draft', directed: { title: 'the draft' } });
    expect(await memory.storyboard('card-1', storyboardKey({ ...asked, brief: 'a reel about hiring' }), 'full')).toBe(null);
    expect(await memory.storyboard('card-1', storyboardKey({ ...asked, told: { seconds: 30, shape: 'tall' } }), 'full')).toBe(null);
    expect(await memory.storyboard('card-1', storyboardKey({ ...asked, lines: [] }), 'full')).toBe(null);
    // Another card's draft is another film, and a film nobody's card asked for remembers nothing.
    expect(await memory.storyboard('card-2', storyboardKey(asked), 'full')).toBe(null);
    expect(await memory.storyboard(undefined, storyboardKey(asked), 'full')).toBe(null);
  });
});

describe('what was put under a line', () => {
  const slot = { line: 'It costs nine dollars', kind: 'detail', room: 'foot' };

  it('gives the same line in the same style the same picture, which is what lets the cache find it', async () => {
    const memory = filmMemory(dir);
    const key = subjectKey(slot, 'quiet documentary photography');
    await memory.keepSubjects([[key, { subject: 'nine coins in a saucer on a cafe counter', metaphor: 'small change' }]]);
    const found = await filmMemory(dir).subjects([key, 'never-seen']);
    expect(found.get(key)).toEqual({ subject: 'nine coins in a saucer on a cafe counter', metaphor: 'small change' });
    expect(found.has('never-seen')).toBe(false);
    // How it is capitalised is not a different line; how it is framed, and the look of the film, are.
    expect(subjectKey({ ...slot, line: '  it costs nine dollars ' }, 'quiet documentary photography')).toBe(key);
    expect(subjectKey({ ...slot, kind: 'wide' }, 'quiet documentary photography')).not.toBe(key);
    expect(subjectKey(slot, 'neon night photography')).not.toBe(key);
  });

  it('keeps the newest and lets the oldest go, so it never grows past what is read in one go', async () => {
    const memory = filmMemory(dir);
    await memory.keepSubjects([['first', { subject: 'the oldest one' }]]);
    await memory.keepSubjects(Array.from({ length: MOST_SUBJECTS }, (_, at): [string, { subject: string }] => [`k${at}`, { subject: `picture ${at}` }]));
    const found = await memory.subjects(['first', 'k0', `k${MOST_SUBJECTS - 1}`]);
    expect(found.has('first')).toBe(false);
    expect(found.has('k0')).toBe(true);
    expect(found.has(`k${MOST_SUBJECTS - 1}`)).toBe(true);
  });

  it('is a kindness and never a requirement: with nowhere to keep anything, a film is simply made', async () => {
    const memory = filmMemory(undefined);
    await memory.keepSubjects([['a', { subject: 'b' }]]);
    await memory.keepStoryboard('card', { key: 'k', speed: 'draft', directed: {} });
    expect((await memory.subjects(['a'])).size).toBe(0);
    expect(await memory.storyboard('card', 'k', 'full')).toBe(null);
    // A folder that cannot be made, because there is a file where it would go.
    await writeFile(join(dir, 'in-the-way'), 'x');
    const nowhere = filmMemory(join(dir, 'in-the-way', 'films'));
    await expect(nowhere.keepSubjects([['a', { subject: 'b' }]])).resolves.toBeUndefined();
  });
});
