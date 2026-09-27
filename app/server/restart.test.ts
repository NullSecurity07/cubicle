import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { answers, guardProcess, restartBudget, serviceHolds } from './restart.ts';

describe('restartBudget', () => {
  it('allows three restarts in a minute, refuses the fourth, and allows again once the first is a minute old', () => {
    let now = 0;
    const budget = restartBudget({ times: 3, within: 60_000, now: () => now });
    expect([budget.allow(), budget.allow(), budget.allow()]).toEqual([true, true, true]);
    now = 30_000;
    expect(budget.allow()).toBe(false);
    now = 60_001;
    expect(budget.allow()).toBe(true);
  });
});

describe('guardProcess', () => {
  it('writes down a promise nobody caught and keeps running, and leaves with a failure on a throw nobody caught', () => {
    const proc = new EventEmitter();
    const lines: string[] = [];
    const exits: number[] = [];
    guardProcess(proc, (line) => lines.push(line), (code) => exits.push(code));
    proc.emit('unhandledRejection', new Error('a board tick broke'));
    expect(lines.join('\n')).toContain('a board tick broke');
    expect(exits).toEqual([]);
    proc.emit('uncaughtException', new Error('something worse'));
    expect(lines.join('\n')).toContain('something worse');
    expect(exits).toEqual([1]);
  });
});

describe('answers', () => {
  it('says whether something already listens on a port, so a second api is not started into a taken one', async () => {
    const { createServer } = await import('node:net');
    const server = createServer();
    await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done); });
    const port = (server.address() as { port: number }).port;
    expect(await answers(port)).toBe(true);
    await new Promise((done) => { server.close(done); });
    expect(await answers(port)).toBe(false);
  });
});

describe('serviceHolds', () => {
  it('uses a server on the api port only when it is the Cubicle service, running', async () => {
    const { createServer } = await import('node:net');
    const server = createServer();
    await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done); });
    const port = (server.address() as { port: number }).port;
    const asked: string[][] = [];
    // Something listens, but the service is not running: a stale api, an orphaned check, another program. The api is
    // started as before, and falls over loudly if the port is taken.
    expect(await serviceHolds(port, async (args) => { asked.push(args); return 'inactive'; })).toBe(false);
    expect(asked[0]).toEqual(['is-active', 'cubicle.service']);
    expect(await serviceHolds(port, async () => null)).toBe(false);
    expect(await serviceHolds(port, async () => 'active')).toBe(true);
    await new Promise((done) => { server.close(done); });
    // The service says it is running, but nothing answers on this port: it is on another one, so this api starts.
    expect(await serviceHolds(port, async () => 'active')).toBe(false);
  });
});
