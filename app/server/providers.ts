import OpenAI from 'openai';
import type { Usage } from '../shared/model.ts';
import models from './models.json' with { type: 'json' };
import type { ModelMessage } from './prompt.ts';

export type Limits = { rpm?: number; rpd?: number; tpm?: number; tpd?: number };
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
// `args` is the raw JSON text the model wrote. `extra` is whatever else the provider attached to the call;
// it goes back unchanged on the next step, because some providers reject a call they cannot recognise.
export type ToolCall = { id: string; name: string; args: string; extra?: unknown };
export type Quota = { remainingRequests?: number; limitRequests?: number; remainingTokens?: number; limitTokens?: number };
export type ModelTurn = { text: string; calls: ToolCall[]; usage?: Usage; quota?: Quota };
export type StepOptions = { tools?: ToolSpec[]; signal?: AbortSignal; onToken: (token: string) => void };

export type ModelClient = {
  name: string;
  model: string;
  maxPromptChars: number;
  tools: boolean;
  limits: Limits;
  step(messages: ModelMessage[], options: StepOptions): Promise<ModelTurn>;
};

export type Completion = ModelTurn & { client: ModelClient };
export type Failure = { client: ModelClient; error: Error };

export const promptSize = (messages: ModelMessage[]) => messages.reduce((sum, message) => {
  const calls = 'tool_calls' in message && message.tool_calls ? JSON.stringify(message.tool_calls).length : 0;
  return sum + message.content.length + calls;
}, 0);

// Tries each client in order. Moves on when one throws before saying anything, answers with nothing,
// or cannot hold the prompt. A reply cut off mid-stream is kept: the founder has already seen it.
export async function complete(
  messages: ModelMessage[], options: StepOptions, clients: ModelClient[], onFailure: (failure: Failure) => void = () => {},
): Promise<Completion> {
  const size = promptSize(messages);
  const failures: string[] = [];
  for (const client of clients) {
    if (size > client.maxPromptChars) { failures.push(`${client.name}: prompt too large`); continue; }
    if (options.tools?.length && !client.tools) { failures.push(`${client.name}: no tool support`); continue; }
    let text = '';
    const onToken = (token: string) => {
      if (!token || (!text && !token.trim())) return;
      text += token;
      options.onToken(token);
    };
    try {
      const turn = await client.step(messages, { ...options, onToken });
      if (text.trim() || turn.calls.length) return { ...turn, text, client };
      failures.push(`${client.name}: empty reply`);
    } catch (error) {
      if (options.signal?.aborted) return { text, calls: [], client };
      if (text.trim()) return { text, calls: [], client };
      onFailure({ client, error: error as Error });
      failures.push(`${client.name}: ${(error as Error).message}`);
    }
  }
  throw new Error(`no provider answered — ${failures.join('; ')}`);
}

const number = (value: string | null) => (value === null || value === '' || Number.isNaN(Number(value)) ? undefined : Number(value));

export function readQuota(headers: Headers): Quota | undefined {
  const quota: Quota = {
    remainingRequests: number(headers.get('x-ratelimit-remaining-requests')),
    limitRequests: number(headers.get('x-ratelimit-limit-requests')),
    remainingTokens: number(headers.get('x-ratelimit-remaining-tokens')),
    limitTokens: number(headers.get('x-ratelimit-limit-tokens')),
  };
  return Object.values(quota).some((value) => value !== undefined) ? quota : undefined;
}

type Entry = (typeof models)[number] & { streamUsage?: boolean; extra?: Record<string, unknown>; limits?: Limits };

export function realClients(env: NodeJS.ProcessEnv = process.env): ModelClient[] {
  return (models as Entry[]).filter((entry) => env[entry.keyEnv]).map((entry) => {
    const api = new OpenAI({ apiKey: env[entry.keyEnv], baseURL: entry.baseURL, timeout: 45_000, maxRetries: 0 });
    return {
      name: entry.name,
      model: entry.model,
      maxPromptChars: entry.maxPromptChars,
      tools: entry.tools,
      limits: entry.limits ?? {},
      async step(messages, { tools, signal, onToken }) {
        const { data: stream, response } = await api.chat.completions.create({
          model: entry.model, messages, stream: true, max_tokens: entry.maxTokens,
          ...(entry.streamUsage === false ? {} : { stream_options: { include_usage: true } }),
          ...(tools?.length ? { tools: tools.map((tool) => ({ type: 'function', function: tool })) } : {}),
          ...(entry.extra ?? {}),
        } as OpenAI.Chat.ChatCompletionCreateParamsStreaming, { signal }).withResponse();

        const calls: ToolCall[] = [];
        let usage: Usage | undefined;
        for await (const chunk of stream) {
          if (chunk.usage) usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) onToken(delta.content);
          for (const part of delta?.tool_calls ?? []) {
            const call = (calls[part.index] ??= { id: '', name: '', args: '' });
            if (part.id) call.id = part.id;
            if (part.function?.name) call.name += part.function.name;
            if (part.function?.arguments) call.args += part.function.arguments;
            const extra = (part as { extra_content?: unknown }).extra_content;
            if (extra !== undefined) call.extra = extra;
          }
        }
        return { text: '', calls: calls.filter(Boolean).map((call, index) => ({ ...call, id: call.id || `call-${index}` })), usage, quota: readQuota(response.headers) };
      },
    };
  });
}

// Deterministic stand-in for browser tests: says who it is, what it heard and which docs it can see.
// `/tool <name> <json>` from the founder makes it call that tool, then report what the tool said.
export const fakeClient: ModelClient = {
  name: 'fake',
  model: 'fake-1',
  maxPromptChars: Infinity,
  tools: true,
  limits: { rpd: 100_000 },
  async step(messages, { onToken, signal, tools }) {
    const system = messages[0]?.content ?? '';
    const name = /^You are ([^,]+),/.exec(system)?.[1] ?? 'Someone';
    const docs = [...system.matchAll(/^## Doc: (.+)$/gm)].map((match) => match[1]);
    const last = messages.at(-1);
    const wanted = last?.role === 'user' ? /^\/tool (\w+) (\{.*\})$/s.exec(last.content) : null;
    if (wanted && tools?.some((tool) => tool.name === wanted[1])) {
      return { text: '', calls: [{ id: `call-${messages.length}`, name: wanted[1], args: wanted[2] }], usage: { input: 10, output: 5 } };
    }
    const heard = messages.findLast((message) => message.role === 'user')?.content ?? '';
    const reply = last?.role === 'tool'
      ? `Tool said: ${last.content}`
      : heard.startsWith('/markdown') ? '**Bold plan**\n\n- one\n- two'
      : `${name} here. You said: "${heard}". Docs I can read: ${docs.join(', ') || 'none'}.`;
    const delay = heard.startsWith('/slow') ? 150 : 15;
    for (const word of reply.split(/(?<= )/)) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (signal?.aborted) throw new Error('aborted');
      onToken(word);
    }
    return { text: '', calls: [], usage: { input: Math.ceil(promptSize(messages) / 4), output: Math.ceil(reply.length / 4) } };
  },
};
