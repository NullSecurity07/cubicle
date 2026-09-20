import { describe, expect, it } from 'vitest';
import { completeJson, firstJson } from './json.ts';
import type { ModelMessage } from './prompt.ts';
import type { ModelClient } from './providers.ts';

// A model that says what it was told to say, keeping the prompt it was given each time.
const says = (...replies: string[]): ModelClient & { seen: ModelMessage[][] } => {
  const seen: ModelMessage[][] = [];
  return {
    name: 'script', model: 's-1', maxPromptChars: Infinity, tools: true, limits: {}, seen,
    async step(messages, { onToken }) {
      seen.push(messages);
      onToken(replies.shift() ?? 'nothing left to say');
      return { text: '', calls: [], usage: { input: 1, output: 1 } };
    },
  };
};

const asked: ModelMessage[] = [{ role: 'user', content: 'Answer in json.' }];
const shaped = (value: unknown) => {
  const name = (value as { name?: unknown }).name;
  if (typeof name !== 'string') throw new Error('"name" is missing');
  return { name };
};

describe('firstJson', () => {
  it('reads it out of a fence, out of prose, and out of a value that quotes a brace', () => {
    expect(firstJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(firstJson('Sure, here it is:\n{"a": [1, 2]}\nHope that helps.')).toEqual({ a: [1, 2] });
    expect(firstJson('{"a": "a } and a \\" in it"}')).toEqual({ a: 'a } and a " in it' });
    expect(firstJson('[{"a": 1}]')).toEqual([{ a: 1 }]);
  });

  it('says so when there is no json, or it never ends', () => {
    expect(() => firstJson('I would rather not.')).toThrow(/no json/);
    expect(() => firstJson('{"a": 1')).toThrow(/never closed/);
  });
});

describe('completeJson', () => {
  it('asks once when the answer is the shape asked for', async () => {
    const client = says('```json\n{"name": "ship it"}\n```');
    expect(await completeJson(asked, shaped, [client])).toEqual({ name: 'ship it' });
    expect(client.seen).toHaveLength(1);
  });

  it('tells the model what was wrong and takes one more answer', async () => {
    const client = says('{"title": "ship it"}', '{"name": "ship it"}');
    const replies: string[] = [];
    expect(await completeJson(asked, shaped, [client], { onReply: (reply) => replies.push(reply.text) })).toEqual({ name: 'ship it' });
    expect(client.seen).toHaveLength(2);
    expect(replies).toHaveLength(2);
    const correction = client.seen[1].at(-1)!.content;
    expect(correction).toContain('"name" is missing');
    expect(correction).toContain('json');
    expect(client.seen[1].at(-2)).toMatchObject({ role: 'assistant', content: '{"title": "ship it"}' });
  });

  it('gives up after the second try, saying what was wrong with it', async () => {
    const client = says('no.', 'still no.');
    await expect(completeJson(asked, shaped, [client])).rejects.toThrow(/did not answer in the shape asked for: there was no json/);
    expect(client.seen).toHaveLength(2);
  });
});
