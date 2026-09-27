import { describe, expect, it } from 'vitest';
import { runTurn } from '../loop.ts';
import type { ModelMessage } from '../prompt.ts';
import { promptSize, type ModelClient } from '../providers.ts';
import { createSeams } from '../seams.ts';
import type { ToolContext } from '../tools/registry.ts';
import { createUsage } from '../usage.ts';
import { budgetOf, createCompaction, edges, squeeze, trimResults } from './compact.ts';

const client = (name: string, maxPromptChars: number, answer: string | Error = 'what happened, in short'): ModelClient => ({
  name, model: `${name}-1`, maxPromptChars, tools: true, limits: {},
  async step(_messages, { onToken }) {
    if (answer instanceof Error) throw answer;
    onToken(answer);
    return { text: '', calls: [], usage: { input: 120, output: 8 } };
  },
});

// A long piece of work: an opening, then rounds of calls whose results are the bulk of it, then words at the end.
function work(rounds: number, resultChars = 900): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: 'system', content: 'You are Maya.' }, { role: 'user', content: 'go and do the launch' }];
  for (let at = 0; at < rounds; at += 1) {
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${at}`, type: 'function', function: { name: 'web_fetch', arguments: '{"urls":["https://example.com"]}' } }] });
    messages.push({ role: 'tool', tool_call_id: `c${at}`, content: `result ${at} ${'x'.repeat(resultChars)}` });
    messages.push({ role: 'assistant', content: `Step ${at} is done.` });
  }
  return messages;
}

// Nobody is left holding half a round: every result has its call above it, and every call has its results.
function paired(messages: ModelMessage[]) {
  const open = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls) for (const call of message.tool_calls) open.add(call.id);
    if (message.role === 'tool' && !open.has(message.tool_call_id)) return false;
  }
  return true;
}

describe('shortening a piece of work', () => {
  it('spends four fifths of the smallest prompt any configured model will hold', () => {
    expect(budgetOf([client('big', 400_000), client('small', 18_000)])).toBe(14_400);
    expect(budgetOf([client('fake', Infinity)])).toBe(Infinity);
  });

  it('cuts the results of all but the last two rounds, and says how much went', () => {
    const trimmed = trimResults(work(5));
    const results = trimmed.filter((message) => message.role === 'tool');
    expect(results.slice(0, 3).map((one) => one.content.length)).toEqual([264, 264, 264]);
    expect(results[0].content).toContain('(709 characters cut to make room');
    expect(results.slice(3).every((one) => one.content.length === 909)).toBe(true);
    expect(paired(trimmed)).toBe(true);
    // Two rounds or fewer is all recent work: nothing is touched.
    expect(trimResults(work(2))).toEqual(work(2));
  });

  it('keeps the opening and the last stretch word for word, whole rounds at a time', () => {
    const messages = work(12);
    const { head, tail } = edges(messages);
    // The boundary stepped back off a result and onto the call above it rather than splitting the two.
    expect(messages[head].role).not.toBe('tool');
    expect(messages[tail].role).not.toBe('tool');
    expect(head).toBeLessThanOrEqual(4);
    expect(messages.length - tail).toBeGreaterThanOrEqual(20);
  });

  it('asks one model to write the middle as a note, and writes down what that cost', async () => {
    const usage = createUsage(null);
    const clients = [client('summariser', 400_000)];
    const messages = work(14);
    const shorter = await squeeze(messages, { clients, usage }, 5000);
    expect(promptSize(shorter)).toBeLessThan(promptSize(messages));
    expect(shorter[0]).toEqual(messages[0]);
    expect(shorter.at(-1)).toEqual(messages.at(-1));
    const note = shorter.find((message) => message.content.startsWith('Earlier in this piece of work, in short:'))!;
    expect(note.role).toBe('user');
    expect(note.content).toContain('what happened, in short');
    expect(note.content.length).toBeLessThanOrEqual(1500 + 'Earlier in this piece of work, in short:\n'.length);
    expect(paired(shorter)).toBe(true);
    expect(usage.info(clients)[0]).toMatchObject({ name: 'summariser', requests: 1, tokens: 128 });
  });

  it('does not count a note every model broke off part way as a good answer', async () => {
    const usage = createUsage(null);
    const broken: ModelClient = { ...client('summariser', 400_000), async step(_messages, { onToken }) { onToken('what hap'); throw Object.assign(new Error('503 overloaded'), { status: 503 }); } };
    await squeeze(work(14), { clients: [broken], usage }, 5000);
    expect(usage.info([broken])[0]).toMatchObject({ name: 'summariser', requests: 0 });
  });

  it('leaves the free pass standing when no model will write the note', async () => {
    const messages = work(14);
    const shorter = await squeeze(messages, { clients: [client('down', 400_000, new Error('502'))], usage: createUsage(null) }, 5000);
    expect(shorter).toEqual(trimResults(messages));
    expect(paired(shorter)).toBe(true);
  });

  it('does nothing at all while the work still fits', async () => {
    const seams = createSeams();
    const compaction = createCompaction({ clients: [client('roomy', 400_000)], usage: createUsage(null) });
    seams.on('step:before', compaction.before);
    const messages = work(3);
    expect((await seams.run('step:before', { roomId: 'marketing', step: 2, messages })).messages).toEqual(messages);
  });

  it('shortens the step that does not fit, before anybody is asked', async () => {
    const seams = createSeams();
    const compaction = createCompaction({ clients: [client('small', 18_000)], usage: createUsage(null) });
    seams.on('step:before', compaction.before);
    const messages = work(20);
    const shorter = (await seams.run('step:before', { roomId: 'marketing', step: 5, messages })).messages;
    expect(promptSize(shorter)).toBeLessThan(14_400);
    expect(paired(shorter)).toBe(true);
  });

  it('shortens once more and says the step is worth asking again, but only when it was the size they refused', async () => {
    const compaction = createCompaction({ clients: [client('small', 18_000)], usage: createUsage(null) });
    const seams = createSeams();
    seams.on('step:error', compaction.error);
    const messages = work(20);
    const refused = { roomId: 'marketing', step: 3, messages };
    const again = await seams.run('step:error', { ...refused, error: 'no provider answered — groq: prompt too large; gemini: prompt too large' });
    expect(again.retry).toBe(true);
    expect(promptSize(again.messages)).toBeLessThan(promptSize(messages));
    const down = await seams.run('step:error', { ...refused, error: 'no provider answered — groq: fetch failed' });
    expect(down.retry).toBeUndefined();
    expect(down.messages).toEqual(messages);
    // Nothing left to cut is not a reason to ask again.
    const short = { roomId: 'marketing', step: 3, messages: [{ role: 'user' as const, content: 'hello' }], error: 'prompt too long' };
    expect((await seams.run('step:error', short)).retry).toBeUndefined();
  });

  it('carries a turn that every model refused for its size through to an answer', async () => {
    const seams = createSeams();
    const small = client('small', 6000);
    // Only the second half is installed, so the step really is refused before anything is shortened.
    seams.on('step:error', createCompaction({ clients: [client('summariser', 400_000)], usage: createUsage(null) }).error);
    const heard: number[] = [];
    const step = small.step.bind(small);
    small.step = async (messages, options) => { heard.push(promptSize(messages)); return step(messages, options); };
    const reply = await runTurn({
      messages: work(20), tools: [], clients: [small], usage: createUsage(null), seams,
      context: { roomId: 'marketing' } as ToolContext,
      events: { token: () => {}, tool: () => {} },
    });
    expect(reply.text).toBe('what happened, in short');
    // The first try never reached the model at all — nothing that size is sent — and the second one fitted.
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBeLessThan(6000);
  });
});
