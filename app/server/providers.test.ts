import { describe, expect, it } from 'vitest';
import { streamReply, type ModelClient } from './providers.ts';

const client = (name: string, tokens: string[] | Error, maxPromptChars = Infinity): ModelClient => ({
  name,
  maxPromptChars,
  async *stream() {
    if (tokens instanceof Error) throw tokens;
    yield* tokens;
  },
});
const messages = [{ role: 'user' as const, content: 'hello' }];

describe('streamReply', () => {
  it('streams from the first client that answers', async () => {
    const seen: string[] = [];
    const result = await streamReply(messages, (t) => seen.push(t), [client('a', ['Hi', ' there']), client('b', ['no'])]);
    expect(result).toEqual({ text: 'Hi there', provider: 'a' });
    expect(seen).toEqual(['Hi', ' there']);
  });

  it('falls through on an error and on an empty reply', async () => {
    const result = await streamReply(messages, () => {}, [client('a', new Error('429')), client('b', ['', '  ']), client('c', ['ok'])]);
    expect(result).toEqual({ text: 'ok', provider: 'c' });
  });

  it('skips a client whose prompt budget is too small', async () => {
    const result = await streamReply(messages, () => {}, [client('small', ['x'], 3), client('big', ['y'])]);
    expect(result.provider).toBe('big');
  });

  it('reports every failure when nobody answers', async () => {
    await expect(streamReply(messages, () => {}, [client('a', new Error('boom')), client('b', [])])).rejects.toThrow(/a: boom.*b: empty reply/s);
  });
});

describe('streamReply, cut off mid-stream', () => {
  it('keeps what was already streamed instead of answering twice', async () => {
    const flaky: ModelClient = { name: 'flaky', maxPromptChars: Infinity, async *stream() { yield 'Half an'; throw new Error('reset'); } };
    const result = await streamReply(messages, () => {}, [flaky, client('b', ['other'])]);
    expect(result).toEqual({ text: 'Half an', provider: 'flaky' });
  });
});
