import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSeams } from './seams.ts';
import { createTrace } from './trace.ts';

const DAY = 86_400_000;
const at = new Date('2026-09-20T11:00:00').getTime();
const dayOf = (when: number) => { const day = new Date(when); return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`; };

const turn = (roomId: string, provider: string, extra: Partial<{ input: number; output: number; tools: { name: string; ok: boolean }[]; stopped: boolean }> = {}) => ({
  roomId, source: 'chat' as const, query: 'go',
  reply: {
    text: 'done', provider, model: `${provider}-1`, stopped: extra.stopped ?? false,
    usage: { input: extra.input ?? 100, output: extra.output ?? 10 },
    tools: (extra.tools ?? []).map((tool) => ({ id: tool.name, name: tool.name, args: {}, ok: tool.ok })),
  },
});

async function setup(now = () => at) {
  const dir = await mkdtemp(join(tmpdir(), 'trace-'));
  const trace = createTrace(dir, now);
  const seams = createSeams();
  seams.on('turn:after', trace.handler);
  return { dir, trace, seams, folder: join(dir, '.index', 'trace') };
}

describe('trace', () => {
  it('writes one line a turn under the day it happened', async () => {
    const { seams, folder } = await setup();
    await seams.run('turn:after', turn('build', 'groq', { tools: [{ name: 'web_search', ok: true }, { name: 'write_doc', ok: false }] }));
    await seams.run('turn:after', turn('marketing', 'gemini'));
    const lines = (await readFile(join(folder, `${dayOf(at)}.jsonl`), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      at, roomId: 'build', source: 'chat', provider: 'groq', model: 'groq-1',
      usage: { input: 100, output: 10 }, tools: [{ name: 'web_search', ok: true }, { name: 'write_doc', ok: false }], stopped: false,
    });
    expect(lines[1].roomId).toBe('marketing');
  });

  it('adds up the days asked for, by person and by model', async () => {
    let now = at - 2 * DAY;
    const { trace, seams } = await setup(() => now);
    await seams.run('turn:after', turn('build', 'groq', { input: 40 }));
    now = at;
    await seams.run('turn:after', turn('build', 'groq', { input: 60, tools: [{ name: 'web_search', ok: false }] }));
    await seams.run('turn:after', turn('marketing', 'gemini', { input: 5, stopped: true }));

    const week = await trace.summary(7);
    expect(week.turns).toBe(3);
    expect(week.people.build).toEqual({ turns: 2, input: 100, output: 20, tools: 1, failed: 1 });
    expect(week.people.marketing.turns).toBe(1);
    expect(week.providers.gemini).toMatchObject({ turns: 1, input: 5 });
    // Only today: the turn from two days ago is out of the window.
    const today = await trace.summary(1);
    expect(today.turns).toBe(2);
    expect(today.people.build.input).toBe(60);
  });

  it('forgets days older than a month the next time it writes, and steps over a line it cannot read', async () => {
    const { trace, seams, folder } = await setup();
    await seams.run('turn:after', turn('build', 'groq'));
    await writeFile(join(folder, `${dayOf(at - 40 * DAY)}.jsonl`), '{"at":1}\n');
    await writeFile(join(folder, `${dayOf(at - 20 * DAY)}.jsonl`), 'half a li\n');
    // These two were planted after today's first line, which had already swept; the next day's line sweeps them.
    await trace.record({ at: at + DAY, roomId: 'build', source: 'chat', provider: 'groq', model: 'groq-1', usage: { input: 1, output: 1 }, tools: [], stopped: false });
    const left = await readdir(folder);
    expect(left).toContain(`${dayOf(at - 20 * DAY)}.jsonl`);
    expect(left).not.toContain(`${dayOf(at - 40 * DAY)}.jsonl`);
    expect((await trace.summary(30)).turns).toBe(1);
  });

  it('never lets a turn wait on it, nor fail because of it', async () => {
    const { seams } = await setup();
    const broken = createTrace('/nowhere/at/all');
    seams.on('turn:after', broken.handler);
    await expect(seams.run('turn:after', turn('build', 'groq'))).resolves.toBeTruthy();
  });
});
