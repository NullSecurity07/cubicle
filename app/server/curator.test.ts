import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCurator, GONE_DAYS, STALE_DAYS } from './curator.ts';
import { createSkills } from './skills.ts';

const DAY = 86_400_000;
const at = new Date('2026-09-20T11:00:00').getTime();
const born = (name: string) => ({
  name, when: 'When this kind of work comes round again', procedure: ['Do the first thing', 'Do the second thing'],
  pitfalls: [], verify: 'It is done.', by: { roomId: 'build', name: 'Dev' }, source: { kind: 'run' as const, ref: 'task-1' },
});

async function setup() {
  let now = at;
  const dir = await mkdtemp(join(tmpdir(), 'curator-'));
  const skills = createSkills(dir, () => now);
  return { skills, curator: createCurator(skills, () => now), go: (days: number) => { now = at + days * DAY; }, when: () => now };
}

describe('the curator', () => {
  it('sets aside what nobody uses, and throws it away long after that', async () => {
    const { skills, curator, go } = await setup();
    await skills.create(born('Ship a launch page'));
    expect(await curator.sweep()).toEqual({ stale: [], gone: [] });

    go(STALE_DAYS + 1);
    expect((await curator.sweep()).stale).toEqual(['ship-a-launch-page']);
    expect((await skills.get('ship-a-launch-page'))!.state).toBe('stale');

    go(GONE_DAYS + 1);
    expect((await curator.sweep()).gone).toEqual(['ship-a-launch-page']);
    expect(await skills.list()).toEqual([]);
  });

  it('counts from the last time somebody reached for it', async () => {
    const { skills, curator, go } = await setup();
    await skills.create(born('Chase an unpaid invoice'));
    go(STALE_DAYS - 1);
    await skills.used('chase-an-unpaid-invoice');
    go(STALE_DAYS + 1);
    expect((await curator.sweep()).stale).toEqual([]);
    go(2 * STALE_DAYS + 2);
    expect((await curator.sweep()).stale).toEqual(['chase-an-unpaid-invoice']);
  });

  it('never ages a skill the founder edited', async () => {
    const { skills, curator, go } = await setup();
    await skills.create(born('Prepare the weekly update'));
    await skills.edit('prepare-the-weekly-update', { verify: 'The founder read it without asking anything.' });
    go(GONE_DAYS * 2);
    expect(await curator.sweep()).toEqual({ stale: [], gone: [] });
    expect((await skills.get('prepare-the-weekly-update'))!.state).toBe('active');
  });

  it('does the round once a day and nothing the rest of the time', async () => {
    const { skills, curator, go } = await setup();
    await skills.create(born('Answer a support ticket'));
    expect(await curator.tick()).toEqual({ stale: [], gone: [] });
    go(STALE_DAYS + 1);
    // The day's round already happened at the moment the last one did, so nothing looks again until tomorrow.
    expect(await curator.tick()).toEqual({ stale: ['answer-a-support-ticket'], gone: [] });
    expect(await curator.tick()).toBe(null);
  });
});
