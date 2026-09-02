import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { ProviderConfig } from './config.js';

export type ChatMessage = ChatCompletionMessageParam;
export type ToolDef = ChatCompletionTool;

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON string
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: { prompt_tokens: number; completion_tokens: number };
  raw?: unknown;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'none' | 'required';
  temperature?: number;
  maxTokens?: number;
  responseFormatJson?: boolean;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export class RateLimitedError extends Error {
  constructor(public readonly provider: string, public readonly model: string, public readonly retryAfterMs: number | null, message: string) {
    super(message);
    this.name = 'RateLimitedError';
  }
}
export class ProviderError extends Error {
  constructor(public readonly provider: string, public readonly model: string, public readonly status: number | null, message: string, public readonly permanent = false) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function apiKeyFor(p: ProviderConfig, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!p.api_key_env) return 'local';
  const v = env[p.api_key_env];
  return v && v.trim() ? v : null;
}

export function makeClient(p: ProviderConfig, env: NodeJS.ProcessEnv = process.env, timeoutMs = 60_000): OpenAI {
  const key = apiKeyFor(p, env);
  return new OpenAI({ apiKey: key ?? 'missing', baseURL: p.base_url, maxRetries: 0, timeout: timeoutMs });
}

function parseRetryAfter(headers: Headers | Record<string, string> | undefined): number | null {
  if (!headers) return null;
  const get = (k: string) => (headers instanceof Headers ? headers.get(k) : headers[k] ?? headers[k.toLowerCase()]);
  const ms = get('retry-after-ms');
  if (ms && !Number.isNaN(Number(ms))) return Number(ms);
  const s = get('retry-after');
  if (!s) return null;
  if (!Number.isNaN(Number(s))) return Number(s) * 1000;
  const d = Date.parse(s);
  return Number.isNaN(d) ? null : Math.max(0, d - Date.now());
}

/** One chat completion against one provider+model. Throws RateLimitedError / ProviderError; never retries. */
export async function chatOnce(p: ProviderConfig, modelId: string, req: ChatRequest, env: NodeJS.ProcessEnv = process.env): Promise<ChatResult> {
  const client = makeClient(p, env);
  const body: Record<string, unknown> = {
    model: modelId,
    messages: req.messages,
    temperature: req.temperature ?? 0.3,
    max_tokens: req.maxTokens,
  };
  if (req.tools?.length) { body.tools = req.tools; body.tool_choice = req.toolChoice ?? 'auto'; }
  if (req.responseFormatJson) body.response_format = { type: 'json_object' };
  try {
    if (req.onDelta) {
      const stream = await client.chat.completions.create({ ...(body as object), stream: true, stream_options: { include_usage: true } } as never, { signal: req.signal }) as unknown as AsyncIterable<{ choices: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]; usage?: { prompt_tokens: number; completion_tokens: number } | null }>;
      let content = '';
      const calls = new Map<number, ToolCall>();
      let finish: string | null = null;
      let usage = { prompt_tokens: 0, completion_tokens: 0 };
      for await (const chunk of stream) {
        const ch = chunk.choices?.[0];
        if (ch?.delta?.content) { content += ch.delta.content; req.onDelta(ch.delta.content); }
        for (const tc of ch?.delta?.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: tc.id ?? `call_${tc.index}`, name: '', arguments: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          calls.set(tc.index, cur);
        }
        if (ch?.finish_reason) finish = ch.finish_reason;
        if (chunk.usage) usage = { prompt_tokens: chunk.usage.prompt_tokens ?? 0, completion_tokens: chunk.usage.completion_tokens ?? 0 };
      }
      return { content, toolCalls: [...calls.values()], finishReason: finish, usage };
    }
    const res = await client.chat.completions.create(body as never, { signal: req.signal });
    const choice = res.choices?.[0];
    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).flatMap((tc) => {
      const fn = (tc as { function?: { name: string; arguments: string } }).function;
      return fn ? [{ id: tc.id, name: fn.name, arguments: fn.arguments ?? '{}' }] : [];
    });
    return {
      content: choice?.message?.content ?? '',
      toolCalls,
      finishReason: choice?.finish_reason ?? null,
      usage: { prompt_tokens: res.usage?.prompt_tokens ?? 0, completion_tokens: res.usage?.completion_tokens ?? 0 },
      raw: res,
    };
  } catch (err) {
    const e = err as { status?: number; headers?: Headers | Record<string, string>; message?: string; name?: string };
    const msg = e.message ?? String(err);
    if (e.status === 429) throw new RateLimitedError(p.id, modelId, parseRetryAfter(e.headers), msg);
    if (e.status && e.status >= 500) throw new ProviderError(p.id, modelId, e.status, msg);
    if (e.status && e.status >= 400) throw new ProviderError(p.id, modelId, e.status, msg, true);
    throw new ProviderError(p.id, modelId, null, msg); // network / timeout
  }
}
