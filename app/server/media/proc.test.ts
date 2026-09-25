import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ff } from './ff.ts';
import { inTurn } from './on-this-machine.ts';
import { runLines } from './proc.ts';
import { connectWithin, hands, serial } from './turns.ts';

// A job that was stopped before it started — a picture the measured cut no longer wants, waiting its turn behind
// another — must never start. Every one of these used to register its stop after spawning, so it ran to the end.

const stopped = () => { const stop = new AbortController(); stop.abort(); return stop.signal; };

describe('a program the studio runs', () => {
  it('hears it a line at a time, split where the caller says', async () => {
    const lines: string[] = [];
    const ran = await runLines('sh', ['-c', 'printf "one\\ntwo\\rthree\\n"'], { cwd: tmpdir(), split: /[\n\r]/, onLine: (line) => lines.push(line), collect: 100 });
    expect(ran.code).toBe(0);
    expect(lines).toEqual(['one', 'two', 'three']);
    expect(ran.out).toBe('one\ntwo\rthree\n');
  });

  it('keeps only the end of what a chatty program printed', async () => {
    const ran = await runLines('sh', ['-c', 'i=0; while [ $i -lt 2000 ]; do echo "line $i"; i=$((i+1)); done; echo last'], { cwd: tmpdir(), collect: 64 });
    expect(ran.out.length).toBeLessThanOrEqual(64);
    expect(ran.out.trim().split('\n').at(-1)).toBe('last');
    // …and nothing at all unless asked.
    expect((await runLines('sh', ['-c', 'echo hello'], { cwd: tmpdir() })).out).toBe('');
  });

  it('never starts one whose job was already stopped', async () => {
    const at = await mkdtemp(join(tmpdir(), 'proc-'));
    await expect(runLines('sh', ['-c', 'touch ran'], { cwd: at, signal: stopped() })).rejects.toThrow('stopped');
    expect(existsSync(join(at, 'ran'))).toBe(false);
  });

  it('stops one that is running when its job is stopped', async () => {
    const stop = new AbortController();
    const running = runLines('sh', ['-c', 'sleep 5'], { cwd: tmpdir(), signal: stop.signal });
    setTimeout(() => stop.abort(), 50);
    const started = Date.now();
    expect((await running).code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('never runs ffmpeg for a job already stopped, and says stopped when one is stopped mid-way', async () => {
    const at = await mkdtemp(join(tmpdir(), 'ff-'));
    await expect(ff('sh', ['-c', `touch ${join(at, 'ran')}`], stopped())).rejects.toThrow('stopped');
    expect(existsSync(join(at, 'ran'))).toBe(false);
    const stop = new AbortController();
    const running = ff('sh', ['-c', 'sleep 5'], stop.signal);
    setTimeout(() => stop.abort(), 50);
    await expect(running).rejects.toThrow('stopped');
  });

  it('leaves no listener behind on a job that runs ffmpeg many times', async () => {
    const stop = new AbortController();
    let added = 0;
    let removed = 0;
    const signal = stop.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof add>) => { added += 1; return add(...args); }) as typeof add;
    signal.removeEventListener = ((...args: Parameters<typeof remove>) => { removed += 1; return remove(...args); }) as typeof remove;
    for (let one = 0; one < 3; one += 1) await ff('sh', ['-c', 'true'], signal);
    expect(added).toBe(removed);
  });
});

describe('one heavy job at a time', () => {
  it('skips a job stopped while it waited, and runs the next one', async () => {
    const ran: string[] = [];
    let release!: () => void;
    const first = inTurn(() => new Promise<void>((done) => { release = done; ran.push('first'); }));
    const stop = new AbortController();
    const waiting = inTurn(async () => { ran.push('stopped one'); }, stop.signal);
    const after = inTurn(async () => { ran.push('next'); });
    stop.abort();
    await Promise.resolve();
    release();
    await first;
    await expect(waiting).rejects.toThrow('stopped');
    await after;
    expect(ran).toEqual(['first', 'next']);
  });

  it('never starts a job whose stop came before it asked', async () => {
    let ran = false;
    await expect(inTurn(async () => { ran = true; }, stopped())).rejects.toThrow('stopped');
    expect(ran).toBe(false);
  });

  it('keeps each queue its own, and a failure in one never stops the next', async () => {
    const one = serial();
    const order: string[] = [];
    await expect(one(async () => { order.push('a'); throw new Error('no'); })).rejects.toThrow('no');
    await one(async () => { order.push('b'); });
    expect(order).toEqual(['a', 'b']);
    // Two queues do not wait on each other.
    const two = serial();
    let hold!: () => void;
    const held = one(() => new Promise<void>((done) => { hold = done; }));
    expect(await two(async () => 'free')).toBe('free');
    hold();
    await held;
    expect(typeof hands(2)).toBe('function');
  });
});

describe('a Space that never answers the door', () => {
  it('is given up on after the time allowed, and one that answers is used', async () => {
    await expect(connectWithin(new Promise(() => {}), 20)).rejects.toThrow('the Space did not answer');
    expect(await connectWithin(Promise.resolve('open'), 20)).toBe('open');
  });
});
