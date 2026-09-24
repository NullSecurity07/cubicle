import { describe, expect, it } from 'vitest';
import { failWith, jobLines, judgeFor, type Held } from './job.ts';
import { fakeJudge } from './score.ts';

const held = (): Held => ({ state: 'testing', lines: [], calls: 0, models: new Set(), stop: new AbortController() });

describe('the shared job pieces', () => {
  it('keeps the last lines and tells the window each one', () => {
    const told: string[] = [];
    const say = jobLines<Held>((_, line) => told.push(line), 2);
    const job = held();
    say(job, 'one'); say(job, 'two'); say(job, 'three');
    expect(job.lines).toEqual(['two', 'three']);
    expect(told).toEqual(['one', 'two', 'three']);
  });
  it('fails only the job that is still the current one', () => {
    const now = held();
    const old = held();
    const failed = failWith<Held>(() => now, jobLines<Held>(() => {}));
    failed(old, new Error('late'));
    expect(old.state).toBe('testing');
    failed(now, new Error('no provider answered'));
    expect(now).toMatchObject({ state: 'failed', error: 'no provider answered', lines: ['no provider answered'] });
  });
  it('judges with the made-up judge in fake mode, and with `ask` when no provider can judge', async () => {
    const usage = { cool: () => {} } as never;
    expect(judgeFor({ fake: true, clients: [], usage }, held(), async () => '')).toBe(fakeJudge);
    const judge = judgeFor({ fake: false, clients: [], usage: { ...(usage as object), snapshot: () => ({}) } as never }, held(), async () => 'ok');
    expect(judge).not.toBe(fakeJudge);
  });
});
