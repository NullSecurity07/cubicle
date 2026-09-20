import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SkillEvent } from '../shared/model.ts';
import { bodyOf, CAPS, createSkills } from './skills.ts';

const at = new Date('2026-09-20T11:00:00').getTime();
const born = {
  name: 'Ship a launch page', when: 'When the founder asks for a landing page for a launch',
  procedure: ['Read the brand doc for voice', 'Write the headline first', 'One call to action above the fold'],
  pitfalls: ['Do not invent a price'], verify: 'The founder can read it and knows what the product does.',
  by: { roomId: 'marketing', name: 'Maya' }, source: { kind: 'run' as const, ref: 'task-1' },
};
const setup = async (now = () => at) => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-'));
  return { dir, skills: createSkills(dir, now) };
};

describe('skills', () => {
  it('writes one file a skill, named after it, and reads it back', async () => {
    const { dir, skills } = await setup();
    const skill = await skills.create(born);
    expect(skill.id).toBe('ship-a-launch-page');
    expect(skill).toMatchObject({ state: 'active', uses: 0, patches: 0, createdAt: at, history: [], by: { name: 'Maya' } });
    expect(await readdir(join(dir, 'skills'))).toEqual(['ship-a-launch-page.json']);
    expect(JSON.parse(await readFile(join(dir, 'skills', 'ship-a-launch-page.json'), 'utf8')).name).toBe(born.name);
    expect((await skills.list())[0].verify).toBe(born.verify);
    // Two skills that would be called the same keep their own files.
    expect((await skills.create({ ...born, name: 'ship a launch page' })).id).toBe('ship-a-launch-page-2');
  });

  it('refuses what is over a cap instead of cutting it', async () => {
    const { skills } = await setup();
    await expect(skills.create({ ...born, name: 'x'.repeat(CAPS.name + 1) })).rejects.toThrow(/"name" is too long \(61 characters, the limit is 60\)/);
    await expect(skills.create({ ...born, when: 'x'.repeat(CAPS.when + 1) })).rejects.toThrow(/"when" is too long/);
    await expect(skills.create({ ...born, procedure: Array.from({ length: 9 }, (_, step) => `step ${step}`) })).rejects.toThrow(/"procedure" has 9 lines, and the limit is 8/);
    await expect(skills.create({ ...born, procedure: ['x'.repeat(CAPS.step + 1)] })).rejects.toThrow(/a line of "procedure" is too long/);
    await expect(skills.create({ ...born, pitfalls: Array.from({ length: 6 }, () => 'watch out') })).rejects.toThrow(/"pitfalls" has 6 lines/);
    await expect(skills.create({ ...born, verify: 'x'.repeat(CAPS.verify + 1) })).rejects.toThrow(/"verify" is too long/);
    // Every line inside its own cap, and the whole still too much to read.
    await expect(skills.create({ ...born, procedure: Array.from({ length: 8 }, () => 'x'.repeat(200)) })).rejects.toThrow(/the whole skill is too long \(\d+ characters, the limit is 1500\)/);
    await expect(skills.create({ ...born, procedure: [] })).rejects.toThrow(/"procedure" is missing/);
    expect(await skills.list()).toEqual([]);
  });

  it('applies a change to the field it names and keeps what was there before', async () => {
    const { skills } = await setup();
    await skills.create(born);
    const patched = await skills.patch('ship-a-launch-page', [
      { field: 'procedure', old: 'Write the headline first', new: 'Write the headline first and read it aloud' },
      { field: 'procedure', old: '', new: 'Ask the founder before it goes live' },
      { field: 'pitfalls', old: 'Do not invent a price', new: '' },
      { field: 'when', old: '', new: 'When the founder asks for a landing page, for a launch or a feature' },
    ]);
    expect(patched.procedure).toEqual(['Read the brand doc for voice', 'Write the headline first and read it aloud', 'One call to action above the fold', 'Ask the founder before it goes live']);
    expect(patched.pitfalls).toEqual([]);
    expect(patched.when).toContain('or a feature');
    expect(patched.patches).toBe(1);
    expect(patched.history).toHaveLength(1);
    expect(patched.history[0]).toMatchObject({ procedure: born.procedure, pitfalls: born.pitfalls, when: born.when, at });

    const back = await skills.undo('ship-a-launch-page');
    expect(back.procedure).toEqual(born.procedure);
    expect(back.pitfalls).toEqual(born.pitfalls);
    expect(back.when).toBe(born.when);
    expect(back.history).toEqual([]);
    // What was counted stays counted: an undo takes back the words, not the history of using it.
    expect(back.patches).toBe(1);
    await expect(skills.undo('ship-a-launch-page')).rejects.toThrow(/no earlier version/);
  });

  it('says so rather than half-applying a change it cannot place, and keeps five versions at most', async () => {
    const { skills } = await setup();
    await skills.create(born);
    await expect(skills.patch('ship-a-launch-page', [{ field: 'procedure', old: 'Something nobody wrote', new: 'x' }])).rejects.toThrow(/is not in "procedure"/);
    await expect(skills.patch('ship-a-launch-page', [{ field: 'colour', old: '', new: 'blue' }])).rejects.toThrow(/is not a field of a skill/);
    await expect(skills.patch('ship-a-launch-page', [{ field: 'when', old: '', new: '' }])).rejects.toThrow(/"when" cannot be emptied/);
    await expect(skills.patch('ship-a-launch-page', [])).rejects.toThrow(/at least one change/);
    expect((await skills.get('ship-a-launch-page'))!.procedure).toEqual(born.procedure);

    for (let round = 1; round <= 7; round += 1) await skills.patch('ship-a-launch-page', [{ field: 'verify', old: '', new: `It worked, round ${round}.` }]);
    const skill = (await skills.get('ship-a-launch-page'))!;
    expect(skill.history).toHaveLength(5);
    expect(skill.history[0].verify).toBe('It worked, round 2.');
    expect(skill.verify).toBe('It worked, round 7.');
  });

  it('lets the founder edit, switch off and throw away, and marks what they touched as theirs', async () => {
    const { dir, skills } = await setup();
    await skills.create(born);
    const edited = await skills.edit('ship-a-launch-page', { name: 'Ship a launch page (ours)' });
    expect(edited).toMatchObject({ name: 'Ship a launch page (ours)', editedByFounder: true });
    expect(edited.procedure).toEqual(born.procedure);
    expect((await skills.setState('ship-a-launch-page', 'off')).state).toBe('off');
    await expect(skills.setState('ship-a-launch-page', 'gone' as 'off')).rejects.toThrow(/active, off or stale/);
    await skills.remove('ship-a-launch-page');
    expect(await skills.list()).toEqual([]);
    expect((await readdir(join(dir, 'trash'))).some((name) => name.endsWith('-ship-a-launch-page.json'))).toBe(true);
  });

  it('counts a use and tells whoever is watching after every change', async () => {
    const { skills } = await setup();
    const heard: SkillEvent[] = [];
    const stop = skills.watch((event) => heard.push(event));
    await skills.create(born);
    const used = await skills.used('ship-a-launch-page');
    expect(used).toMatchObject({ uses: 1, usedAt: at });
    expect(heard).toHaveLength(2);
    expect((heard[1] as { skills: unknown[] }).skills).toHaveLength(1);
    stop();
    await skills.setState('ship-a-launch-page', 'off');
    expect(heard).toHaveLength(2);
  });

  // The founder can open any of these files in an editor. Whatever comes back out of one, what leaves the store is a
  // whole skill or nothing at all: a skill with half its fields reaches a screen and leaves the founder looking at nothing.
  it('makes a hand-edited file whole again, and keeps back one with no lesson in it', async () => {
    const { dir, skills } = await setup();
    await mkdir(join(dir, 'skills'), { recursive: true });
    await writeFile(join(dir, 'skills', 'hand-edited.json'), JSON.stringify({ name: 'How we answer late', when: 'When somebody has waited a day', procedure: ['Say sorry first', ''], verify: 'They got an answer.' }));
    await writeFile(join(dir, 'skills', 'half-a-thought.json'), JSON.stringify({ name: 'Something', procedure: [] }));
    const [whole, ...rest] = await skills.list();
    expect(rest).toHaveLength(0);
    expect(whole).toMatchObject({
      id: 'hand-edited', name: 'How we answer late', procedure: ['Say sorry first'], pitfalls: [], history: [],
      state: 'active', by: { roomId: '', name: 'Somebody' }, source: { kind: 'run', ref: '' }, uses: 0, patches: 0, createdAt: 0,
    });
    // And it is still the founder's to work on: what was made whole can be edited, undone and switched off like any other.
    expect((await skills.setState('hand-edited', 'off')).state).toBe('off');
  });

  it('reads out the way a person is meant to read it', async () => {
    const { skills } = await setup();
    const skill = await skills.create(born);
    expect(bodyOf(skill)).toBe(
      'Ship a launch page. When the founder asks for a landing page for a launch\n\n'
      + '1. Read the brand doc for voice\n2. Write the headline first\n3. One call to action above the fold\n\n'
      + 'Watch out for:\n- Do not invent a price\n\nDone when: The founder can read it and knows what the product does.',
    );
  });
});
