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
// `cut`: the provider stopped the reply at its length limit, mid-thought.
export type ModelTurn = { text: string; calls: ToolCall[]; usage?: Usage; quota?: Quota; cut?: boolean };
export type StepOptions = { tools?: ToolSpec[]; signal?: AbortSignal; onToken: (token: string) => void };

export type ModelClient = {
  name: string;
  model: string;
  maxPromptChars: number;
  tools: boolean;
  vision?: boolean;
  limits: Limits;
  step(messages: ModelMessage[], options: StepOptions): Promise<ModelTurn>;
};

export type Completion = ModelTurn & { client: ModelClient };
export type Failure = { client: ModelClient; error: Error };

export const promptSize = (messages: ModelMessage[]) => messages.reduce((sum, message) => {
  const calls = 'tool_calls' in message && message.tool_calls ? JSON.stringify(message.tool_calls).length : 0;
  const images = 'images' in message && message.images ? message.images.length * 1200 : 0;
  return sum + message.content.length + calls + images;
}, 0);

const MAX_WAIT = 8000;
const sleep = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((done) => {
  const timer = setTimeout(done, milliseconds);
  signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
});

// Milliseconds a provider asked us to wait after a 429, if it said.
export function retryAfter(error: unknown): number | undefined {
  const { status, headers } = error as { status?: number; headers?: Headers };
  if (status !== 429) return undefined;
  const seconds = Number(headers?.get?.('retry-after'));
  return seconds > 0 ? seconds * 1000 : undefined;
}

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
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const turn = await client.step(messages, { ...options, onToken });
        if (text.trim() || turn.calls.length) return { ...turn, text, client };
        failures.push(`${client.name}: empty reply`);
      } catch (error) {
        if (options.signal?.aborted) return { text, calls: [], client };
        if (text.trim()) return { text, calls: [], client };
        // A per-minute limit that clears in a few seconds is worth waiting out once; anything longer goes to the next model.
        const wait = retryAfter(error);
        if (attempt === 1 && wait !== undefined && wait <= MAX_WAIT) { await sleep(wait + 300, options.signal); continue; }
        onFailure({ client, error: error as Error });
        failures.push(`${client.name}: ${(error as Error).message}`);
      }
      break;
    }
  }
  throw new Error(`no provider answered — ${failures.join('; ')}`);
}

// Only the three fields the API knows. Our tools carry more (limits, approval rules), and Gemini refuses a request with any unknown field.
export const wireTools = (tools: ToolSpec[]) => tools.map(({ name, description, parameters }) => ({ type: 'function' as const, function: { name, description, parameters } }));

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

// A turn can change provider half way. Tool calls made by another provider carry no signature, which Gemini insists on,
// so it gets the stand-in Google documents for that case; every other provider gets the calls without Google's extras.
// The wire form of a message: a model that can see gets images as parts, any other gets a line that names them.
export function withImages(messages: ModelMessage[], vision: boolean): unknown[] {
  return messages.map((message) => {
    if (message.role !== 'user' || !message.images?.length) return message;
    const { images, ...rest } = message;
    if (!vision) return { ...rest, content: `${message.content}\n\n[${images.length === 1 ? 'An image was' : `${images.length} images were`} attached (${images.map((image) => image.name).join(', ')}), but the model answering now cannot see images. Say so if the question depends on them.]` };
    return { ...rest, content: [{ type: 'text', text: message.content }, ...images.map((image) => ({ type: 'image_url', image_url: { url: image.url } }))] };
  });
}

export function portable(messages: ModelMessage[], signature?: string): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant' || !message.tool_calls) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map(({ extra_content, ...call }) => (
        signature ? { ...call, extra_content: extra_content ?? { google: { thought_signature: signature } } } : call
      )),
    };
  });
}

type CallPart = { index?: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: unknown };

// Folds streamed pieces of tool calls into whole calls. Most providers number the pieces; Gemini sends each call
// whole and unnumbered, so a piece with an id and no number starts a new call.
export function collectCalls(calls: ToolCall[], parts: CallPart[]) {
  for (const part of parts) {
    const index = part.index ?? (part.id || !calls.length ? calls.length : calls.length - 1);
    const call = (calls[index] ??= { id: '', name: '', args: '' });
    if (part.id) call.id = part.id;
    if (part.function?.name) call.name += part.function.name;
    if (part.function?.arguments) call.args += part.function.arguments;
    if (part.extra_content !== undefined) call.extra = part.extra_content;
  }
}

type Entry = (typeof models)[number] & { vision?: boolean; streamUsage?: boolean; callSignature?: string; extra?: Record<string, unknown>; limits?: Limits };

export function realClients(env: NodeJS.ProcessEnv = process.env): ModelClient[] {
  return (models as Entry[]).filter((entry) => env[entry.keyEnv]).map((entry) => {
    const api = new OpenAI({ apiKey: env[entry.keyEnv], baseURL: entry.baseURL, timeout: 45_000, maxRetries: 0 });
    return {
      name: entry.name,
      model: entry.model,
      maxPromptChars: entry.maxPromptChars,
      tools: entry.tools,
      vision: !!entry.vision,
      limits: entry.limits ?? {},
      async step(history, { tools, signal, onToken }) {
        const messages = withImages(portable(history, entry.callSignature), !!entry.vision);
        const { data: stream, response } = await api.chat.completions.create({
          model: entry.model, messages, stream: true, max_tokens: entry.maxTokens,
          ...(entry.streamUsage === false ? {} : { stream_options: { include_usage: true } }),
          ...(tools?.length ? { tools: wireTools(tools) } : {}),
          ...(entry.extra ?? {}),
        } as OpenAI.Chat.ChatCompletionCreateParamsStreaming, { signal }).withResponse();

        const calls: ToolCall[] = [];
        let usage: Usage | undefined;
        let cut = false;
        for await (const chunk of stream) {
          if (chunk.usage) usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
          const delta = chunk.choices[0]?.delta;
          if (chunk.choices[0]?.finish_reason === 'length') cut = true;
          if (delta?.content) onToken(delta.content);
          collectCalls(calls, delta?.tool_calls ?? []);
        }
        return { text: '', calls: calls.filter(Boolean).map((call, index) => ({ ...call, id: call.id || `call-${index}` })), usage, quota: readQuota(response.headers), ...(cut ? { cut } : {}) };
      },
    };
  });
}

// Deterministic stand-in for browser tests: says who it is, what it heard and which docs it can see.
// `/tool <name> <json>` from the founder makes it call that tool, then report what the tool said. Several of those
// lines are worked through one at a time, which is what a piece of work that took real effort looks like from here.
export const fakeClient: ModelClient = {
  name: 'fake',
  model: 'fake-1',
  maxPromptChars: Infinity,
  tools: true,
  vision: true,
  limits: { rpd: 100_000 },
  async step(messages, { onToken, signal, tools }) {
    const system = messages[0]?.content ?? '';
    const name = /^You are ([^,]+),/.exec(system)?.[1] ?? 'Someone';
    const docs = [...system.matchAll(/^## Doc: (.+)$/gm)].map((match) => match[1]);
    const notes = /Sticky notes the founder connected to your room:\n- ([^\n]+)/.exec(system)?.[1];
    const pages = [...system.matchAll(/^## Page: (.+)$/gm)].map((match) => match[1]);
    const studios = [...system.matchAll(/^- An? (image|voice|video) studio\./gm)].map((match) => match[1]);
    // Said back so a browser test can see that a skill learned on one turn really reached the next one's prompt.
    const playbook = [...(/Your company playbook:[^\n]*\n([\s\S]*?)\nIf one fits/.exec(system)?.[1] ?? '').matchAll(/^- ([^:\n]+):/gm)].map((match) => match[1]);
    const last = messages.at(-1);
    const heard = messages.findLast((message) => message.role === 'user')?.content ?? '';
    // The playbook asks this in json and takes none for an answer twice; a fake person always has something to teach,
    // so a browser test can watch a skill be born without a key to a real model.
    if (/^You keep the one playbook/.test(system)) {
      // The task's own words go through the whole skill, so two different tasks do not teach the same lesson twice
      // and get thrown away as near-copies of each other.
      const task = (/^What the founder asked .+ for:\n(.+)$/m.exec(heard)?.[1]?.replace(/^\/tool \w+ .*/, '').trim() || 'work of this kind').slice(0, 50);
      onToken(JSON.stringify({
        action: 'create', name: `How to ${task}`.slice(0, 60), when: `When the founder asks for ${task}`.slice(0, 160),
        procedure: [`Read what is wired to you before starting on ${task}`, 'Do the work with your tools, one call at a time', `Say in a line or two what changed about ${task}`],
        pitfalls: [`Never say ${task} is done unless a tool said so`], verify: `The founder can see ${task} without asking.`,
      }));
      return { text: '', calls: [], usage: { input: 10, output: 40 } };
    }
    const asked = [...heard.matchAll(/^\/tool (\w+) (\{.*\})$/gm)];
    // Only what has run since the founder spoke: earlier turns leave their own tool messages in the conversation.
    const wanted = asked[messages.slice(messages.findLastIndex((message) => message.role === 'user')).filter((message) => message.role === 'tool').length];
    if (wanted && tools?.some((tool) => tool.name === wanted[1])) {
      return { text: '', calls: [{ id: `call-${messages.length}`, name: wanted[1], args: wanted[2] }], usage: { input: 10, output: 5 } };
    }
    // Drawing a picture and then making a film with it, in one turn — what a person has to be able to do when the
    // founder says "generate an image and use that in the video". The path comes back in the first tool's own
    // words, and goes straight into the second call.
    if (/^\/chain\b/m.test(heard) && tools?.some((tool) => tool.name === 'generate_video')) {
      const drew = last?.role === 'tool' ? /saved at (\S+)/.exec(last.content) : null;
      if (drew) {
        const brief = heard.replace(/^\/chain\s*/m, '').trim() || 'a short film';
        return { text: '', calls: [{ id: `call-${messages.length}`, name: 'generate_video', args: JSON.stringify({ brief, images: [drew[1]] }) }], usage: { input: 10, output: 5 } };
      }
      if (last?.role === 'user' && tools.some((tool) => tool.name === 'generate_image')) {
        return { text: '', calls: [{ id: `call-${messages.length}`, name: 'generate_image', args: JSON.stringify({ prompt: 'an influencer talking to camera' }) }], usage: { input: 10, output: 5 } };
      }
    }
    const reply = last?.role === 'tool'
      ? `Tool said: ${last.content}`
      : heard.startsWith('/markdown') ? '**Bold plan**\n\n- one\n- two'
      : heard.startsWith('/rich') ? 'A flow:\n\n```mermaid\ngraph TD; Idea-->Build; Build-->Launch;\n```\n\nA page:\n\n```html\n<!doctype html><html><body><h1 id="t">Landing</h1><script>document.getElementById("t").textContent += " page";</script></body></html>\n```'
      : last?.role === 'user' && last.images?.length ? `I can see ${last.images.length} picture: ${last.images[0].name.split('/').pop()}.`
      : `${name} here. You said: "${heard}". Docs I can read: ${docs.join(', ') || 'none'}.${notes ? ` Notes: ${notes}.` : ''}${pages.length ? ` Pages: ${pages.join(', ')}.` : ''}${studios.length ? ` Studios: ${studios.join(', ')}.` : ''}${playbook.length ? ` Playbook: ${playbook.join(', ')}.` : ''}`;
    const delay = heard.startsWith('/slow') ? 150 : 15;
    for (const word of reply.split(/(?<= )/)) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (signal?.aborted) throw new Error('aborted');
      onToken(word);
    }
    return { text: '', calls: [], usage: { input: Math.ceil(promptSize(messages) / 4), output: Math.ceil(reply.length / 4) } };
  },
};
