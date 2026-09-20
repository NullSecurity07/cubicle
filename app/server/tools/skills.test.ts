import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedStage } from '../../shared/model.ts';
import { createFounder, FULL } from '../founder.ts';
import { createSkills } from '../skills.ts';
import { createStore } from '../store.ts';
import { founderTools } from './founder.ts';
import { runTool, type ToolContext } from './registry.ts';
import { skillTools } from './skills.ts';

const born = {
  name: 'Ship a launch page', when: 'When the founder asks for a landing page for a launch',
  procedure: ['Read the brand doc for voice', 'Write the headline first'], pitfalls: ['Do not invent a price'],
  verify: 'A stranger can say what the product does.', by: { roomId: 'marketing', name: 'Maya' }, source: { kind: 'run' as const, ref: 'task-1' },
};

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'playbook-tools-'));
  const skills = createSkills(dir);
  const founder = createFounder(dir);
  const tools = [...skillTools(skills), ...founderTools(founder)];
  // A fresh turn each time, so the per-turn cap is only in the way of the test that is about it.
  const context = (): ToolContext => ({ stage: seedStage, roomId: 'marketing', store: createStore(dir), granted: new Map() });
  return { skills, founder, tools, context, run: (name: string, args: Record<string, unknown>) => runTool(tools, name, JSON.stringify(args), context()) };
}

describe('use_skill', () => {
  it('hands over the whole skill and counts that somebody used it', async () => {
    const { skills, run } = await setup();
    await skills.create(born);
    const read = await run('use_skill', { name: 'Ship a launch page' });
    expect(read.ok).toBe(true);
    expect(read.text).toContain('1. Read the brand doc for voice');
    expect(read.text).toContain('Watch out for:\n- Do not invent a price');
    expect(read.text).toContain('Done when: A stranger can say what the product does.');
    expect((await skills.get('ship-a-launch-page'))!.uses).toBe(1);
    // Named loosely, or by the id the panel shows: the same skill either way.
    expect((await run('use_skill', { name: 'launch page' })).text).toContain('Write the headline first');
    expect((await run('use_skill', { name: 'ship-a-launch-page' })).ok).toBe(true);
    // Opened three times in the same few minutes is one piece of work, so one use.
    expect((await skills.get('ship-a-launch-page'))!.uses).toBe(1);
  });

  it('says what there is rather than inventing a skill, and leaves a switched-off one alone', async () => {
    const { skills, run } = await setup();
    expect((await run('use_skill', { name: 'anything' })).text).toBe('There is no skill called "anything" in the playbook.');
    await skills.create(born);
    await skills.setState('ship-a-launch-page', 'off');
    const read = await run('use_skill', { name: 'Ship a launch page' });
    expect(read.text).toContain('There is no skill called');
    expect((await skills.get('ship-a-launch-page'))!.uses).toBe(0);
  });

  it('may be read twice in a turn and no more, and asks the founder for nothing', async () => {
    const { skills, tools, context } = await setup();
    await skills.create(born);
    const use = tools.find((tool) => tool.name === 'use_skill')!;
    expect(use.perTurn).toBe(2);
    expect(use.approval).toBe(undefined);
    const turn = context();
    for (let round = 1; round <= 2; round += 1) expect((await runTool(tools, 'use_skill', '{"name":"Ship a launch page"}', turn)).ok).toBe(true);
    expect((await runTool(tools, 'use_skill', '{"name":"Ship a launch page"}', turn)).text).toContain('already ran 2 times this turn');
  });
});

describe('note_founder', () => {
  it('adds a line everybody will read, and swaps one that stopped being true', async () => {
    const { founder, run } = await setup();
    expect((await run('note_founder', { fact: 'Prefers the short answer first' })).text).toBe('Noted about the founder.');
    expect(await founder.read()).toBe('- Prefers the short answer first');
    expect((await run('note_founder', { fact: 'Prefers the answer in one line', replace: 'short answer' })).text).toContain('now says');
    expect(await founder.read()).toBe('- Prefers the answer in one line');
  });

  it('asks for a line to be replaced rather than growing without end', async () => {
    const { founder, run } = await setup();
    await founder.write('- '.padEnd(1190, 'x'));
    expect((await run('note_founder', { fact: 'One more thing about them' })).text).toContain(FULL);
  });
});
