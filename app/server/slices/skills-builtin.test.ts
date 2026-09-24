import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SkillEvent } from '../../shared/model.ts';
import type { Deps } from '../install.ts';
import { checkFields, createSkills } from '../skills.ts';
import slice, { copyBuiltInSkills } from './skills-builtin.ts';

const FIXTURES = resolve(import.meta.dirname, 'skills-builtin.fixtures');
// The repository itself: the built-ins the founder is given ship in it, and this checks they really arrive.
const root = resolve(import.meta.dirname, '../../..');
const SHIPPED = resolve(root, 'app/skills');
const AT = 1_790_208_000_000;

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'skills-builtin-'));
  return { dir, skills: createSkills(dir, () => AT) };
}

describe('the built-in skills', () => {
  it('copies a built-in into an empty playbook as an active skill taught by nobody in particular', async () => {
    const { dir, skills } = await workspace();
    const said: string[] = [];
    expect(await copyBuiltInSkills(FIXTURES, dir, skills, () => AT, (line) => said.push(line))).toEqual(['ask-first']);
    const [skill] = await skills.list();
    expect(skill).toMatchObject({
      id: 'ask-first', name: 'Ask before drafting', state: 'active', by: { roomId: '', name: 'Built in' },
      source: { kind: 'taught', ref: 'builtin' }, uses: 0, patches: 0, createdAt: AT, history: [],
      procedure: ['Ask for the facts the text needs and wait.', 'Write it from those facts only.'], pitfalls: ['Never invent a number.'],
    });
    // The one that breaks the playbook's rules is named and left out, never cut down to fit; a file whose name is not an
    // id and a file that is not a skill at all are passed over without a word.
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('"rambling"');
    expect(await readdir(join(dir, 'skills'))).toEqual(['ask-first.json']);
  });

  it('leaves a skill the workspace already holds under that id exactly as it is', async () => {
    const { dir, skills } = await workspace();
    await mkdir(join(dir, 'skills'), { recursive: true });
    const theirs = { name: 'Ask before drafting', when: 'Mine now.', procedure: ['My own step.'], pitfalls: [], verify: 'Mine.', state: 'off', editedByFounder: true };
    await writeFile(join(dir, 'skills', 'ask-first.json'), JSON.stringify(theirs));
    expect(await copyBuiltInSkills(FIXTURES, dir, skills, () => AT, () => {})).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, 'skills', 'ask-first.json'), 'utf8'))).toEqual(theirs);
  });

  it('does not hand back a built-in the founder deleted', async () => {
    const { dir, skills } = await workspace();
    await copyBuiltInSkills(FIXTURES, dir, skills, () => AT, () => {});
    await skills.remove('ask-first');
    expect(await copyBuiltInSkills(FIXTURES, dir, skills, () => AT, () => {})).toEqual([]);
    expect(await skills.list()).toEqual([]);
  });

  it('copies nothing, and says nothing, when there is no folder of built-ins', async () => {
    const { dir, skills } = await workspace();
    expect(await copyBuiltInSkills(join(FIXTURES, 'nowhere'), dir, skills)).toEqual([]);
  });

  it('ships skills that each pass the playbook\'s own checks, named by their file', async () => {
    const files = (await readdir(SHIPPED)).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const file of files) {
      expect(file).toMatch(/^[a-z0-9][a-z0-9-]{0,79}\.json$/);
      const held = JSON.parse(await readFile(join(SHIPPED, file), 'utf8')) as Record<string, unknown>;
      expect(Object.keys(held).sort()).toEqual(['name', 'pitfalls', 'procedure', 'verify', 'when']);
      // checkFields throws on anything over a cap, so a pass is the proof; comparing makes sure nothing was trimmed.
      expect(checkFields(held)).toEqual(held);
    }
    const names = await Promise.all(files.map(async (file) => (JSON.parse(await readFile(join(SHIPPED, file), 'utf8')) as { name: string }).name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives a new workspace the whole shipped playbook on its first start, and tells whoever is watching', async () => {
    const { dir, skills } = await workspace();
    const heard: SkillEvent[] = [];
    skills.watch((event) => heard.push(event));
    await slice.install({ workspace: dir, root, skills } as unknown as Deps);
    const shipped = (await readdir(SHIPPED)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort();
    const listed = await skills.list();
    expect(listed.map((one) => one.id).sort()).toEqual(shipped);
    expect(listed.every((one) => one.state === 'active' && one.source.ref === 'builtin')).toBe(true);
    expect(heard).toHaveLength(1);
    // A second start copies nothing and says nothing.
    await slice.install({ workspace: dir, root, skills } as unknown as Deps);
    expect(heard).toHaveLength(1);
  });
});
