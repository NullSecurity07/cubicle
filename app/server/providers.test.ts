import { describe, expect, it } from 'vitest';
import { complete, readQuota, type ModelClient } from './providers.ts';

const client = (name: string, tokens: string[] | Error, maxPromptChars = Infinity): ModelClient => ({
  name, model: `${name}-1`, maxPromptChars, tools: true, limits: {},
  async step(_messages, { onToken }) {
    if (tokens instanceof Error) throw tokens;
    tokens.forEach(onToken);
    return { text: '', calls: [] };
  },
});
const streamReply = async (input: typeof messages, onToken: (token: string) => void, clients: ModelClient[]) => {
  const result = await complete(input, { onToken }, clients);
  return { text: result.text, provider: result.client.name };
};
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
    const flaky: ModelClient = { ...client('flaky', []), async step(_messages, { onToken }) { onToken('Half an'); throw new Error('reset'); } };
    const result = await streamReply(messages, () => {}, [flaky, client('b', ['other'])]);
    expect(result).toEqual({ text: 'Half an', provider: 'flaky' });
  });
});

describe('complete, with tools', () => {
  it('accepts a step that only calls tools, and skips a model without tool support', async () => {
    const mute: ModelClient = { ...client('mute', ['hi']), tools: false };
    const caller: ModelClient = { ...client('caller', []), async step() { return { text: '', calls: [{ id: '1', name: 'x', args: '{}' }] }; } };
    const result = await complete(messages, { onToken: () => {}, tools: [{ name: 'x', description: '', parameters: {} }] }, [mute, caller]);
    expect(result.client.name).toBe('caller');
    expect(result.calls).toHaveLength(1);
  });

  it('reads rate-limit headers when a provider sends them', () => {
    expect(readQuota(new Headers({ 'x-ratelimit-remaining-requests': '998', 'x-ratelimit-limit-requests': '1000' }))).toMatchObject({ remainingRequests: 998, limitRequests: 1000 });
    expect(readQuota(new Headers())).toBeUndefined();
  });
});
