import { describe, expect, it } from 'vitest';
import { wireTools, collectCalls, complete, portable, readQuota, type ModelClient, type ToolCall } from './providers.ts';

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

describe('collectCalls', () => {
  it('joins numbered pieces of the same call', () => {
    const calls: ToolCall[] = [];
    collectCalls(calls, [{ index: 0, id: 'a', function: { name: 'write_doc', arguments: '{"doc":' } }]);
    collectCalls(calls, [{ index: 0, function: { arguments: '"Brand"}' } }, { index: 1, id: 'b', function: { name: 'list_files', arguments: '{}' } }]);
    expect(calls).toEqual([{ id: 'a', name: 'write_doc', args: '{"doc":"Brand"}' }, { id: 'b', name: 'list_files', args: '{}' }]);
  });

  it('takes whole, unnumbered calls the way Gemini sends them, and keeps the signature it must get back', () => {
    const calls: ToolCall[] = [];
    collectCalls(calls, [{ id: 'x', function: { name: 'list_files', arguments: '{}' }, extra_content: { google: { thought_signature: 'sig' } } }]);
    collectCalls(calls, [{ id: 'y', function: { name: 'read_file', arguments: '{"path":"a.md"}' } }]);
    expect(calls.map((call) => call.id)).toEqual(['x', 'y']);
    expect(calls[0].extra).toEqual({ google: { thought_signature: 'sig' } });
  });
});

describe('changing provider half way through a turn', () => {
  const history = [
    { role: 'user' as const, content: 'go' },
    { role: 'assistant' as const, content: '', tool_calls: [
      { id: 'a', type: 'function' as const, function: { name: 'x', arguments: '{}' } },
      { id: 'b', type: 'function' as const, function: { name: 'y', arguments: '{}' }, extra_content: { google: { thought_signature: 'real' } } },
    ] },
  ];

  it('gives Gemini a stand-in signature only where a real one is missing', () => {
    const [, assistant] = portable(history, 'stand-in') as typeof history;
    expect(assistant.tool_calls!.map((call) => (call as { extra_content?: any }).extra_content.google.thought_signature)).toEqual(['stand-in', 'real']);
  });

  it('strips Google extras for everyone else', () => {
    const [, assistant] = portable(history) as typeof history;
    expect(assistant.tool_calls!.every((call) => !('extra_content' in call))).toBe(true);
  });

  it('waits out a short per-minute limit once, then answers from the same model', async () => {
    let tries = 0;
    const limited: ModelClient = { ...client('groq', []), async step(_messages, { onToken }) {
      tries += 1;
      if (tries === 1) throw Object.assign(new Error('429'), { status: 429, headers: new Headers({ 'retry-after': '0.05' }) });
      onToken('ok');
      return { text: '', calls: [] };
    } };
    const result = await complete(messages, { onToken: () => {} }, [limited, client('other', ['no'])]);
    expect(result.client.name).toBe('groq');
    expect(tries).toBe(2);
  });
});

describe('wireTools', () => {
  it('sends a provider nothing but name, description and parameters', () => {
    const tool = { name: 'web_search', description: 'Search', parameters: { type: 'object' }, perTurn: 3, approval: true, run: async () => ({ text: '' }) };
    expect(wireTools([tool])).toEqual([{ type: 'function', function: { name: 'web_search', description: 'Search', parameters: { type: 'object' } } }]);
  });
});
