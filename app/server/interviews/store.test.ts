import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { InterviewEvent } from '../../shared/interviews.ts';
import { silentWav } from './fixtures.ts';
import { fakeConvert, type Ear } from './hear.ts';
import { createInterviews, NO_CONSENT } from './store.ts';

const ear: Ear = { name: 'test ear', hear: async (_wav, seconds) => ({ lines: [{ at: 0, text: 'hello' }, { at: seconds / 2, text: 'middle' }], engine: 'test ear' }) };
const convert = (input: string) => fakeConvert(input);

async function setup(over: Partial<Parameters<typeof createInterviews>[1]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'interviews-'));
  const told: InterviewEvent[] = [];
  let clock = 1_790_000_000_000;
  const interviews = createInterviews(dir, { ear, convert, tell: (_id, event) => told.push(structuredClone(event)), now: () => (clock += 1000), ...over });
  return { dir, told, interviews };
}
const sound = (seconds: number) => Readable.from([silentWav(seconds)]);

describe('the interviews store', () => {
  it('records nothing until the founder ticks consent, and keeps the tick with its time', async () => {
    const { interviews, dir } = await setup();
    await expect(interviews.add('interview-1', 'call.wav', sound(2), 1e8)).rejects.toThrow(NO_CONSENT);
    const data = await interviews.consent('interview-1', true);
    expect(data.consent).toBe(true);
    expect(data.consentAt).toBeGreaterThan(0);
    await interviews.settled();
    expect(JSON.parse(await readFile(join(dir, 'interviews', 'interview-1.json'), 'utf8')).consent).toBe(true);
  });

  it('keeps a recording, measures it, and writes it down; a second one carries on from where the first ended', async () => {
    const { interviews, told, dir } = await setup();
    await interviews.consent('interview-1', true);
    const first = await interviews.add('interview-1', 'call.wav', sound(4), 1e8);
    expect(first.seconds).toBe(4);
    expect(existsSync(join(dir, 'interviews', first.path))).toBe(true);
    await interviews.settled();
    expect(told.some((event) => event.data.state === 'transcribing')).toBe(true);
    await interviews.add('interview-1', 'second.wav', sound(6), 1e8);
    await interviews.settled();
    const data = await interviews.list('interview-1');
    expect(data.state).toBe('idle');
    expect(data.engine).toBe('test ear');
    expect(data.transcript).toEqual([{ at: 0, text: 'hello' }, { at: 2, text: 'middle' }, { at: 4, text: 'hello' }, { at: 7, text: 'middle' }]);
    // The work folder is gone once it is written down.
    expect(await readdir(join(dir, 'interviews', 'interview-1'))).toHaveLength(2);
    expect(told.at(-1)!.rev).toBeGreaterThan(told[0].rev);
  });

  it('throws away a file that is not a recording, or has no sound in it, and keeps nothing of it', async () => {
    const { interviews, dir } = await setup({ convert: async () => 0 });
    await interviews.consent('interview-1', true);
    await expect(interviews.add('interview-1', 'notes.txt', sound(1), 1e8)).rejects.toThrow('not a recording');
    await expect(interviews.add('interview-1', 'call.wav', sound(1), 1e8)).rejects.toThrow('no sound');
    await expect(interviews.add('interview-1', 'call.wav', sound(1), 10)).rejects.toThrow('too large');
    expect((await readdir(join(dir, 'interviews', 'interview-1'))).filter((name) => name.startsWith('rec-'))).toEqual([]);
    expect((await interviews.list('interview-1')).recordings).toEqual([]);
  });

  it('says why it could not write one down, and tries again when asked', async () => {
    let fail = true;
    const { interviews } = await setup({ ear: { name: 'flaky', hear: async () => { if (fail) throw new Error('no model'); return { lines: [{ at: 0, text: 'ok' }], engine: 'flaky' }; } } });
    await interviews.consent('interview-1', true);
    await interviews.add('interview-1', 'call.wav', sound(2), 1e8);
    await interviews.settled();
    expect(await interviews.list('interview-1')).toMatchObject({ state: 'failed', problem: 'It could not be written down: no model' });
    fail = false;
    await interviews.transcribe('interview-1');
    expect(await interviews.list('interview-1')).toMatchObject({ state: 'idle', transcript: [{ at: 0, text: 'ok' }] });
    expect((await interviews.list('interview-1')).problem).toBeUndefined();
  });

  it('takes a recording off to the trash and writes the rest down again', async () => {
    const { interviews, dir } = await setup();
    await interviews.consent('interview-1', true);
    await interviews.add('interview-1', 'a.wav', sound(2), 1e8);
    await interviews.settled();
    await interviews.add('interview-1', 'b.wav', sound(8), 1e8);
    await interviews.settled();
    await interviews.remove('interview-1', 0);
    await interviews.settled();
    const data = await interviews.list('interview-1');
    expect(data.recordings.map((one) => one.seconds)).toEqual([8]);
    expect(data.transcript).toEqual([{ at: 0, text: 'hello' }, { at: 4, text: 'middle' }]);
    expect(await readdir(join(dir, 'trash'))).toHaveLength(1);
  });

  it('reads a job the app closed on as one to try again, not one still running', async () => {
    const { interviews, dir } = await setup({ ear: { name: 'slow', hear: () => new Promise(() => {}) } });
    await interviews.consent('interview-1', true);
    await interviews.add('interview-1', 'a.wav', sound(2), 1e8);
    await new Promise((done) => { setTimeout(done, 50); });
    const again = createInterviews(dir, { ear, convert });
    expect(await again.list('interview-1')).toMatchObject({ state: 'failed' });
  });
});
