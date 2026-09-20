import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSkills } from '../skills.ts';
import { createTrace, type TraceLine } from '../trace.ts';
import { createInsights, shares } from './insights.ts';

const at = new Date('2026-09-20T11:00:00').getTime();
const DAY = 86_400_000;
const line = (extra: Partial<TraceLine> = {}): TraceLine => ({
  at, roomId: 'marketing', source: 'chat', provider: 'groq', model: 'gpt-oss-120b',
  usage: { input: 1000, output: 200 }, tools: [{ name: 'web_search', ok: true }], stopped: false, ...extra,
});

const setup = async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'insights-'));
  const skills = createSkills(workspace, () => at);
  const names: Record<string, string> = { marketing: 'Maya', build: 'Dev' };
  const today = () => [{ name: 'groq', left: 0.42, requests: 12, tokens: 3400 }];
  return { workspace, skills, insights: createInsights({ workspace, skills, nameOf: async (id) => names[id] ?? id, today, now: () => at }) };
};

describe('insights', () => {
  it('say so kindly when nothing has happened yet', async () => {
    const { insights } = await setup();
    // Nothing has been written down, and today's free allowance is still worth saying: it is what the founder has left.
    expect(await insights.read(7)).toMatchObject({
      days: 7, turns: 0, input: 0, output: 0, people: [], providers: [], skills: { learned: 0, active: 0, used: 0 },
      today: [{ name: 'groq', left: 0.42, requests: 12, tokens: 3400 }],
    });
    expect((await createInsights({ workspace: (await setup()).workspace, skills: (await setup()).skills, nameOf: async (id) => id }).read(7)).today).toEqual([]);
  });

  it('add up what the work came to, by person and by provider, biggest first', async () => {
    const { workspace, insights } = await setup();
    const trace = createTrace(workspace, () => at);
    await trace.record(line());
    await trace.record(line({ tools: [{ name: 'web_fetch', ok: false }] }));
    await trace.record(line({ roomId: 'build', provider: 'gemini', usage: { input: 60_000, output: 900 }, tools: [] }));
    // A turn from a month back counts in the thirty days and not in the seven.
    await trace.record(line({ at: at - 20 * DAY, roomId: 'build', usage: { input: 5, output: 5 } }));

    const week = await insights.read(7);
    expect(week).toMatchObject({ days: 7, turns: 3, input: 62_000, output: 1300, tools: 2, failed: 1 });
    expect(week.people).toEqual([
      { name: 'Dev', turns: 1, tokens: 60_900, failed: 0 },
      { name: 'Maya', turns: 2, tokens: 2400, failed: 1 },
    ]);
    expect(week.providers.map((one) => one.name)).toEqual(['gemini', 'groq']);
    expect((await insights.read(30)).turns).toBe(4);
  });

  it('count what the people learned inside the days being looked at', async () => {
    const { skills, insights } = await setup();
    const born = {
      name: 'Ship a launch page', when: 'When the founder asks for a landing page',
      procedure: ['Write the headline first'], pitfalls: [], verify: 'The founder can read it.',
      by: { roomId: 'marketing', name: 'Maya' }, source: { kind: 'run' as const, ref: 'task-1' },
    };
    const one = await skills.create(born);
    await skills.used(one.id);
    await skills.setState((await skills.create({ ...born, name: 'Answer a waiting customer' })).id, 'off');
    expect((await insights.read(7)).skills).toEqual({ learned: 2, active: 1, used: 1 });
  });

  it('put a name to a room, and leave the id when there is none', () => {
    const totals = { marketing: { turns: 1, input: 10, output: 2, tools: 0, failed: 0 }, ghost: { turns: 9, input: 1, output: 1, tools: 0, failed: 3 } };
    expect(shares(totals, (id) => ({ marketing: 'Maya' })[id] ?? '')).toEqual([
      { name: 'Maya', turns: 1, tokens: 12, failed: 0 },
      { name: 'ghost', turns: 9, tokens: 2, failed: 3 },
    ]);
  });
});
