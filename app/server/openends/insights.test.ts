import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSkills } from '../skills.ts';
import { createTrace, type TraceLine } from '../trace.ts';
import { createUsage } from '../usage.ts';
import { createInsights, savings, shares } from './insights.ts';

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

  it('put today by what each call was for, by tool, and what the savers kept off the quotas', async () => {
    const usage = createUsage(null, () => at);
    usage.record('groq', { input: 1000, output: 100 });
    usage.record('groq-small', { input: 200, output: 50 }, undefined, 'compaction');
    usage.record('groq-small', { input: 100, output: 20 }, undefined, 'side');
    usage.shrunk('web_fetch', 6000, 2500);
    usage.shrunk('run_code', 9000, 3000);
    usage.shrunk('read_doc', 400, 400);
    const put = savings(usage.today());
    expect(put.byKind).toEqual([
      { kind: 'turn', requests: 1, tokens: 1100 },
      { kind: 'compaction', requests: 1, tokens: 250 },
      { kind: 'side', requests: 1, tokens: 120 },
    ]);
    expect(put.byTool.map((one) => one.tool)).toEqual(['run_code', 'web_fetch', 'read_doc']);
    expect(put.saved).toEqual({ foldedChars: 9500, cacheHits: 0, cacheMisses: 0, cacheTokensSaved: 0, webHits: 0, webMisses: 0 });
    const { workspace, skills } = await setup();
    const read = await createInsights({ workspace, skills, nameOf: async (id) => id, counts: () => usage.today(), now: () => at }).read(7);
    expect(read.saved?.foldedChars).toBe(9500);
    expect(read.byKind?.[0].kind).toBe('turn');
  });

  it('read a usage file written before kinds, tools and the cache were counted', async () => {
    const { workspace } = await setup();
    const { writeFile } = await import('node:fs/promises');
    const file = join(workspace, 'usage.json');
    await writeFile(file, JSON.stringify({ day: new Date(at).toISOString().slice(0, 10), providers: { groq: { requests: 3, input: 30, output: 3 } } }));
    const usage = createUsage(file, () => at);
    await usage.load();
    expect(usage.carried('groq').day).toBe(33);
    expect(savings(usage.today()).byKind).toEqual([]);
    usage.record('groq', { input: 1, output: 1 });
    expect(savings(usage.today()).byKind).toEqual([{ kind: 'turn', requests: 1, tokens: 2 }]);
  });
});
