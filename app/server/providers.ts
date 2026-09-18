import OpenAI from 'openai';
import models from './models.json' with { type: 'json' };
import type { ModelMessage } from './prompt.ts';

export type ModelClient = {
  name: string;
  maxPromptChars: number;
  stream(messages: ModelMessage[]): AsyncIterable<string>;
};

// Tries each client in order. Moves on when one throws before saying anything, answers with nothing,
// or cannot hold the prompt. A reply cut off mid-stream is kept: the founder has already seen it.
export async function streamReply(messages: ModelMessage[], onToken: (token: string) => void, clients: ModelClient[]) {
  const size = messages.reduce((sum, message) => sum + message.content.length, 0);
  const failures: string[] = [];
  for (const client of clients) {
    if (size > client.maxPromptChars) { failures.push(`${client.name}: prompt too large`); continue; }
    let text = '';
    try {
      for await (const token of client.stream(messages)) {
        if (!token) continue;
        if (!text && !token.trim()) continue;
        text += token;
        onToken(token);
      }
    } catch (error) {
      if (!text.trim()) { failures.push(`${client.name}: ${(error as Error).message}`); continue; }
    }
    if (text.trim()) return { text, provider: client.name };
    failures.push(`${client.name}: empty reply`);
  }
  throw new Error(`no provider answered — ${failures.join('; ')}`);
}

export function realClients(env: NodeJS.ProcessEnv = process.env): ModelClient[] {
  return models.filter((entry) => env[entry.keyEnv]).map((entry) => {
    const api = new OpenAI({ apiKey: env[entry.keyEnv], baseURL: entry.baseURL, timeout: 45_000, maxRetries: 0 });
    return {
      name: entry.name,
      maxPromptChars: entry.maxPromptChars,
      async *stream(messages) {
        const stream = await api.chat.completions.create({
          model: entry.model, messages, stream: true, max_tokens: entry.maxTokens, ...(entry.extra ?? {}),
        } as OpenAI.Chat.ChatCompletionCreateParamsStreaming);
        for await (const chunk of stream) yield chunk.choices[0]?.delta?.content ?? '';
      },
    };
  });
}

// Deterministic stand-in for browser tests: says who it is, what it heard and which docs it can see.
export const fakeClient: ModelClient = {
  name: 'fake',
  maxPromptChars: Infinity,
  async *stream(messages) {
    const system = messages[0]?.content ?? '';
    const name = /^You are ([^,]+),/.exec(system)?.[1] ?? 'Someone';
    const docs = [...system.matchAll(/^## Doc: (.+)$/gm)].map((match) => match[1]);
    const heard = messages.at(-1)?.content ?? '';
    const reply = `${name} here. You said: "${heard}". Docs I can read: ${docs.join(', ') || 'none'}.`;
    for (const word of reply.split(/(?<= )/)) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      yield word;
    }
  },
};
