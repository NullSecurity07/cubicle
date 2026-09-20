import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Attention, ToolEvent } from '../shared/model.ts';
import { createAttention, type AttentionBook } from './attention.ts';
import { tidyLapsed } from './lapsed.ts';
import type { Payloads, Source } from './seams.ts';

// Sunday 20 September 2026, noon where the machine is; the approval below was raised a few minutes before that.
const NOON = new Date(2026, 8, 20, 12).getTime();
const RAISED = NOON - 600_000;
const now = () => NOON;

const waiting = (roomId: string, who: string, event: ToolEvent): Attention =>
  ({ id: `approval:${event.id}`, kind: 'approval', title: event.question ?? event.name, at: RAISED, roomId, who, event });
const email = (id: string): ToolEvent => ({ id, name: 'send_email', args: { to: 'alex@example.com' }, waiting: true, question: 'Send this email?' });

// A turn as the seam sees it at its end: what ran, and whether the founder stopped it.
const ended = (roomId: string, over: { source?: Source; tools?: ToolEvent[]; stopped?: boolean } = {}): Payloads['turn:after'] => ({
  roomId, source: over.source ?? 'chat', query: 'how is it going',
  reply: { text: 'all good', tools: over.tools ?? [], provider: 'fake', model: 'fake', usage: { input: 1, output: 1 }, stopped: over.stopped === true },
});
const ran = (name: string, ok: boolean): ToolEvent => ({ id: `t-${name}`, name, args: {}, ok, result: ok ? 'done' : 'no' });

// A book with one lapsed approval in Maya's room, exactly as a closed app leaves one behind.
async function book(...raise: Attention[]) {
  const dir = await mkdtemp(join(tmpdir(), 'lapsed-'));
  const before = createAttention(dir, now);
  for (const entry of raise.length ? raise : [waiting('marketing', 'Maya', email('c1'))]) await before.raise(entry);
  await before.settled();
  return createAttention(dir, now);
}
const after = async (attention: AttentionBook, payload: Payloads['turn:after']) => {
  await tidyLapsed(attention)(payload, async (given) => given);
  return (await attention.list()).map((one) => one.id);
};

describe('an approval left behind by a closed app', () => {
  let attention: AttentionBook;
  beforeEach(async () => { attention = await book(); });

  it('goes when the same tool runs and works in that room', async () => {
    expect(await after(attention, ended('marketing', { source: 'run', tools: [ran('send_email', true)] }))).toEqual([]);
  });

  it('goes when the founder has spoken to that person again and the turn finished', async () => {
    expect(await after(attention, ended('marketing'))).toEqual([]);
  });

  it('stays when the turn was a task run that did something else', async () => {
    expect(await after(attention, ended('marketing', { source: 'run', tools: [ran('web_search', true)] }))).toEqual(['approval:c1']);
    // The same tool, but it failed: what the founder was asked about still has not happened.
    expect(await after(attention, ended('marketing', { source: 'run', tools: [ran('send_email', false)] }))).toEqual(['approval:c1']);
  });

  it('stays when the founder stopped the turn, whatever ran in it', async () => {
    expect(await after(attention, ended('marketing', { stopped: true, tools: [ran('send_email', true)] }))).toEqual(['approval:c1']);
  });

  it('is never touched by what happens in somebody else\'s room', async () => {
    const two = await book(waiting('marketing', 'Maya', email('c1')), waiting('build', 'Dev', email('c2')));
    expect(await after(two, ended('build', { tools: [ran('send_email', true)] }))).toEqual(['approval:c1']);
  });

  it('leaves alone an approval that is still waiting for an answer here and now', async () => {
    const live = createAttention(await mkdtemp(join(tmpdir(), 'lapsed-')), now);
    await live.raise(waiting('marketing', 'Maya', email('c9')));
    expect(await after(live, ended('marketing'))).toEqual(['approval:c9']);
  });
});
