import { createHash, randomBytes } from 'node:crypto';
import OpenAI from 'openai';
import type { Usage } from '../shared/model.ts';
import models from './models.json' with { type: 'json' };
import { discoverLocal } from './opencode/config.ts';
import { headerWait } from './breaker.ts';
import type { ModelMessage } from './prompt.ts';

// `rpmo`: a hard cap on requests in a calendar month, for a model whose free part is a small credit (Hugging Face's
// router gives $0.10 a month): once it is used the model is never asked again that month, so the credit cannot drain
// without anyone seeing it.
type Limits = { rpm?: number; rpd?: number; tpm?: number; tpd?: number; rpmo?: number };
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
// `args` is the raw JSON text the model wrote. `extra` is whatever else the provider attached to the call;
// it goes back unchanged on the next step, because some providers reject a call they cannot recognise.
export type ToolCall = { id: string; name: string; args: string; extra?: unknown };
export type Quota = { remainingRequests?: number; limitRequests?: number; remainingTokens?: number; limitTokens?: number };
// `cut`: the reply stops mid-thought, at the provider's length limit or, with `broke` saying why, because the stream
// failed part way through.
export type ModelTurn = { text: string; calls: ToolCall[]; usage?: Usage; quota?: Quota; cut?: boolean; broke?: string };
// `onRestart`: the words streamed so far are dropped, because another model is about to answer from the start. A caller
// that does not pass it keeps the old way: a reply that breaks part way is kept as it stands.
// `patient`: this is the last model that can take the turn, so a slow first word is waited for rather than cut off.
// `behind`: another model able to take the turn stands behind this one, so a model given longer for its first word
// (Kimi's minute) gets only the usual 20 s: its long wait is for when it is the last one able.
type StepOptions = { tools?: ToolSpec[]; signal?: AbortSignal; onToken: (token: string) => void; onRestart?: () => void; patient?: boolean; behind?: boolean };

export type ModelClient = {
  name: string;
  model: string;
  maxPromptChars: number;
  tools: boolean;
  vision?: boolean;
  limits: Limits;
  // A model on this machine: free and private, slower and weaker than the hosted ones, so it answers last unless it is
  // pinned, and only when the hosted ones have no room left.
  local?: boolean;
  // A small model kept for the calls around a turn (a summary, a reflection, a compaction note): it is asked first
  // for those, so the big model's per-minute tokens stay with the people, and it never answers a turn.
  side?: boolean;
  // A stronger model kept for the partner's turns alone (Gemini 3.5 Flash, whose free day is small): a colleague, a pin
  // or a side call never reaches it, so its day is all the partner's.
  partnerOnly?: boolean;
  // How many requests this key may have out at once, when the provider says (Z.ai's flash model and Ollama's cloud
  // take one at a time), and whether that many are out now. A busy client is passed over, never queued behind.
  concurrency?: number;
  busy?: () => boolean;
  // Its daily allowance is a pool shared with something else the founder uses (Cloudflare's neurons also draw the
  // pictures): once its own `rpd` is used it is left out for the rest of the day, not kept at the back as a net.
  sharedPool?: boolean;
  // How long this model may keep silent before its first word, when not the usual 20 s (see `FIRST_WORD_MS`).
  firstWordMs?: number;
  // The OpenAI-compatible handle behind this client, when there is one. Nothing in a turn uses it — a turn goes
  // through `step`, which streams and counts — but a library that speaks the OpenAI API for us (the eval scorers)
  // needs the very same key and base URL rather than a second one the founder would have to go and get.
  openai?: OpenAI;
  step(messages: ModelMessage[], options: StepOptions): Promise<ModelTurn>;
};

// `reported`: a broken reply handed back after its model's failure was already told to `onFailure`; whoever records
// usage must not count it as a good answer, which would close the breaker the failure just moved.
// `oversize`: models passed over before this one because the prompt would not fit them, for a line to the founder.
export type Completion = ModelTurn & { client: ModelClient; reported?: boolean; oversize?: string[] };
export type Failure = { client: ModelClient; error: Error };

// A name for one tool call that no other call anywhere shares. Some providers send none, and numbering them from
// nought meant two people waiting on the founder at the same moment were both "call-0": the second approval took the
// first one's place, and the first person's turn waited for an answer that could no longer reach it. The same name
// keys the undo snapshot and the standing yes, so it has to be one call's alone.
export const callId = () => `call_${randomBytes(8).toString('hex')}`;

export const promptSize = (messages: ModelMessage[]) => messages.reduce((sum, message) => {
  const calls = 'tool_calls' in message && message.tool_calls ? JSON.stringify(message.tool_calls).length : 0;
  const images = 'images' in message && message.images ? message.images.length * 1200 : 0;
  return sum + (message.content ?? '').length + calls + images;
}, 0);

const MAX_WAIT = 8000;
const CALLED_UNOFFERED = /tool choice is none, but model called a tool|attempted to call tool/i;
const sleep = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((done) => {
  const timer = setTimeout(done, milliseconds);
  signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
});

// Milliseconds a provider asked us to wait after a 429, if it said.
export function retryAfter(error: unknown): number | undefined {
  return (error as { status?: number }).status === 429 ? headerWait(error) : undefined;
}

const MALFORMED_CALL = /failed_generation|failed to call a function|tool call validation|failed to parse tool/i;
const REJECTED = /INVALID_ARGUMENT|invalid argument|\b400\b.*invalid/i;
const TOO_LARGE = /\b413\b|request too large|payload too large|context length|maximum context/i;
// A provider's own text with what must never reach the founder taken out: JSON bodies, and account, organisation and
// request ids ("org_01m24…", "req_…", "in organization `…`").
export function scrubProvider(message: string): string {
  return message
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\b(?:sk|gsk|csk|nvapi|AIza|hf|key)[-_][\w*.…-]+/gi, '')
    .replace(/\[?\{[\s\S]*\}\]?/g, '')
    .replace(/\s*in organi[sz]ation\s+`[^`]*`/gi, '')
    .replace(/\b(?:org|req|request|proj|user|acct)[_-][\w-]+/gi, '')
    .replace(/`[^`]*`/g, 'the model')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
// Why a model could not answer or a stream broke off, in words the founder can read: for the notice when another
// model steps in and the line under a reply that stops short. `provider` names who, when the words need it.
export function plainBreak(message: string, provider?: string): string {
  if (MALFORMED_CALL.test(message)) return 'its tool call came out malformed';
  if (/no first word/i.test(message)) return message;
  if (TOO_LARGE.test(message)) return `the prompt is too large for ${provider ?? 'this model'}`;
  if (REJECTED.test(message)) return 'the model rejected the request';
  if (/timed? ?out|timeout/i.test(message)) return 'it stopped answering (timed out)';
  // Anything else is said by its kind (down, busy, the key refused) before the provider's own words are ever used, and
  // those only with their tags, keys, addresses and ids taken out.
  const words = failureWords(message);
  if (words !== 'failed') return words;
  return scrubProvider(message || 'the stream broke off').slice(0, 160) || 'it failed';
}

// What one model's failure was, in a few plain words: never the provider's own text, which means nothing to a founder.
function failureWords(message: string): string {
  if (MALFORMED_CALL.test(message)) return 'tool call came out malformed';
  // The long clock is said as such, so the founder knows why the answer took a minute and a half to fail.
  const waited = /no first word within ([\d.]+) s, the last model able/i.exec(message);
  if (waited) return `said nothing for too long (waited ${waited[1]} s: last model able)`;
  if (/no first word/i.test(message)) return 'said nothing for too long';
  if (TOO_LARGE.test(message)) return 'prompt too large';
  if (REJECTED.test(message)) return 'rejected the request';
  if (/\b429\b|too many requests|rate limit|already answering/i.test(message)) return 'busy';
  if (/timed? ?out|timeout/i.test(message)) return 'timed out';
  if (/\b402\b|credit card|payment method/i.test(message)) return 'needs a card on file';
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|invalid api key/i.test(message)) return 'refused the key';
  if (/\b5\d\d\b|overloaded|unavailable|ECONNRESET|ECONNREFUSED|fetch failed|connection error/i.test(message)) return 'down';
  if (/prompt too large/i.test(message)) return 'prompt too large';
  if (/kept off turns with tools/i.test(message)) return 'kept off turns with tools';
  if (/resting/i.test(message)) return 'resting';
  if (/no tool support/i.test(message)) return 'cannot use tools';
  if (/empty reply/i.test(message)) return 'answered with nothing';
  return 'failed';
}

// The error `complete` throws when no model answered, as one plain line: "gemini timed out, groq busy".
export function plainFailure(message: string): string {
  const all = /^no provider answered — (.*)$/s.exec(message);
  if (!all) return failureWords(message);
  return all[1].split('; ').map((part) => {
    const at = part.indexOf(': ');
    return at < 0 ? failureWords(part) : `${part.slice(0, at)} ${failureWords(part.slice(at + 2))}`;
  }).join(', ');
}

// The conversation cut to fit `cap` characters: the system prompt and everything from the founder's latest message
// on stay whole, and the oldest history goes first, never leaving a tool result without the call it answers. Null when
// even that much does not fit.
export function fitHistory(messages: ModelMessage[], cap: number): ModelMessage[] | null {
  if (promptSize(messages) <= cap) return messages;
  const head = messages[0]?.role === 'system' ? 1 : 0;
  const latest = Math.max(head, messages.findLastIndex((message) => message.role === 'user'));
  const top = messages.slice(0, head);
  const tail = messages.slice(latest);
  let middle = messages.slice(head, latest);
  const fits = () => promptSize([...top, ...middle, ...tail]) <= cap;
  while (middle.length && !fits()) {
    middle = middle.slice(1);
    while (middle[0]?.role === 'tool') middle = middle.slice(1);
  }
  return fits() ? [...top, ...middle, ...tail] : null;
}

// A small model on this machine (or one kept for side calls) never takes a turn with tools while a hosted model is
// there: a local 7B made six calls under one id and broke the room for the week. With no hosted model at all it
// still answers, since it is all there is.
// One the founder pinned (first in the order) keeps its turn: the pin is theirs to make.
const smallFor = (client: ModelClient, options: StepOptions, clients: ModelClient[]) =>
  !!options.tools?.length && (!!client.local || !!client.side) && client !== clients[0] && clients.some((other) => !other.local && !other.side);

// Tries each client in order. Moves on when one throws before saying anything, answers with nothing,
// or cannot hold the prompt. A reply that breaks off mid-stream moves on too when the caller can take its words back
// (`onRestart`): the next model answers from the start, and the broken words come back, marked as cut, only when no
// model at all can give a whole answer. A caller that cannot take words back keeps the cut reply as it stands.
export async function complete(
  messages: ModelMessage[], options: StepOptions, clients: ModelClient[], onFailure: (failure: Failure) => void = () => {},
  // Asked right before a client is tried: a key whose breaker is open is passed over, as one too small would be.
  admit: (client: ModelClient) => boolean = () => true,
  // Whether a client is resting (a 429's wait, an open breaker, a refused key) without asking to be let in: only looks.
  resting: (client: ModelClient) => boolean = () => false,
  // Whether a client cannot answer at all right now (a refused key, an open breaker), only looking: such a one behind
  // another is nobody behind it, so the one before keeps its long first-word wait.
  blocked: (client: ModelClient) => boolean = () => false,
): Promise<Completion> {
  // The tool definitions go to the model too, and count against what it can hold.
  const toolChars = toolSize(options.tools);
  const failures: string[] = [];
  // The longest reply that broke off part way, kept in case nobody does better; and what the window shows right now.
  let broken: Completion | undefined;
  let showing = '';
  const oversize: string[] = [];
  // Whether a model could take this turn at all, apart from how it is doing today.
  const able = (client: ModelClient) => (!options.tools?.length || client.tools) && !smallFor(client, options, clients)
    && fitHistory(messages, client.maxPromptChars - toolChars) !== null && !client.busy?.();
  for (const [index, client] of clients.entries()) {
    if (options.tools?.length && !client.tools) { failures.push(`${client.name}: no tool support`); continue; }
    if (smallFor(client, options, clients)) { failures.push(`${client.name}: kept off turns with tools`); continue; }
    // Groq's cap is its per-minute token wall: on a turn with tools it is not squeezed in with the history cut while
    // a model behind it can hold the whole prompt.
    // Only a model that would really be asked counts: not one kept off tool turns, busy, or resting after failing.
    if (options.tools?.length && walled(client) && promptSize(messages) + toolChars > client.maxPromptChars
      && clients.slice(index + 1).some((other) => able(other) && !walled(other) && !resting(other) && promptSize(messages) + toolChars <= other.maxPromptChars)) {
      failures.push(`${client.name}: prompt too large`); oversize.push(client.name); continue;
    }
    // A model that holds less gets the oldest history cut, not the whole turn refused.
    let sent = fitHistory(messages, client.maxPromptChars - toolChars);
    if (!sent) { failures.push(`${client.name}: prompt too large`); oversize.push(client.name); continue; }
    if (!admit(client)) { failures.push(`${client.name}: resting after failing several times in a row`); continue; }
    if (client.busy?.()) { failures.push(`${client.name}: already answering another request`); continue; }
    // Another model is really about to answer: the broken words go from the window first.
    if (showing) { options.onRestart?.(); showing = ''; }
    let text = '';
    const onToken = (token: string) => {
      if (!token || (!text && !token.trim())) return;
      text += token;
      showing += token;
      options.onToken(token);
    };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        // With nobody behind it, a slow model is the answer: its first word is waited for, not cut off at the clock.
        const patient = !clients.slice(index + 1).some((other) => able(other) && !blocked(other));
        const turn = await client.step(sent, { ...options, onToken, patient, behind: !patient });
        if (text.trim() || turn.calls.length) return { ...turn, text, client, ...(oversize.length ? { oversize } : {}) };
        failures.push(`${client.name}: empty reply`);
      } catch (error) {
        if (options.signal?.aborted) return { text, calls: [], client };
        const message = (error as Error).message ?? '';
        // Words already streamed and a tool call it was in the middle of lost: not a whole answer. With nobody to take
        // the words back they stay, marked as broken off; otherwise the breaker hears of it and the next model is asked.
        if (text.trim()) {
          const cut: Completion = { text, calls: [], client, cut: true, broke: plainBreak(message) };
          if (!options.onRestart) return cut;
          onFailure({ client, error: error as Error });
          failures.push(`${client.name}: ${message}`);
          if (!broken || text.length > broken.text.length) broken = { ...cut, reported: true };
          break;
        }
        // Too large after all (a provider counts in tokens, not characters): asked once more with the history cut harder.
        if (attempt === 1 && ((error as { status?: number }).status === 413 || TOO_LARGE.test(message))) {
          const smaller = fitHistory(sent, Math.floor(promptSize(sent) * 0.6));
          if (smaller && smaller.length < sent.length) { sent = smaller; continue; }
        }
        // A per-minute limit that clears in a few seconds is worth waiting out once; anything longer goes to the next model.
        const wait = retryAfter(error);
        if (attempt === 1 && wait !== undefined && wait <= MAX_WAIT) { await sleep(wait + 300, options.signal); continue; }
        // gpt-oss now and then calls a tool it was never offered, and Groq answers that with a 400. It is a slip, not
        // a refusal: asked once more, the same model answers in words.
        if (attempt === 1 && !options.tools?.length && CALLED_UNOFFERED.test(message)) continue;
        onFailure({ client, error: error as Error });
        failures.push(`${client.name}: ${message}`);
      }
      break;
    }
  }
  if (broken) {
    // Nobody gave a whole answer: the best broken one is what the founder gets, shown again if it was taken away.
    if (showing !== broken.text) {
      if (showing) options.onRestart?.();
      options.onToken(broken.text);
    }
    return broken;
  }
  throw new Error(`no provider answered — ${failures.join('; ')}`);
}

// What the tool definitions take of a request, in characters. Groq's free tier walls a request at 7-8k tokens, which is
// less than the whole tool list a person is offered (47k characters for 70 tools on 2026-10-02): a model whose room is
// smaller than that is never sent a tool turn, without a call and without a mark against its breaker (see `complete`).
export const toolSize = (tools?: ToolSpec[]) => (tools?.length ? JSON.stringify(wireTools(tools)).length : 0);
// Whether a model can take a turn with these tools at all: the tools and the prompt, its oldest talk cut, fit its room.
export const holdsTools = (client: Pick<ModelClient, 'maxPromptChars'>, tools: ToolSpec[], messages: ModelMessage[]) =>
  fitHistory(messages, client.maxPromptChars - toolSize(tools)) !== null;

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
      // A call with no words beside it is sent with empty words: Cloudflare refuses a tool-call message whose content
      // is null with a 400, and every other provider takes the empty string as well.
      content: message.content ?? '',
      tool_calls: message.tool_calls.map(({ extra_content, ...call }) => (
        signature ? { ...call, extra_content: extra_content ?? { google: { thought_signature: signature } } } : call
      )),
    };
  });
}

// Mistral refuses a tool call, and the result that answers it, unless its name is exactly nine letters and digits, so
// a call Gemini or anyone else made earlier in the turn is renamed on the way out, the same way every time so the call
// and its result still match. Only the wire copy changes: the conversation kept here keeps the names it had.
const SHORT_ID = /^[A-Za-z0-9]{9}$/;
const shortId = (id: string) => (SHORT_ID.test(id) ? id : createHash('sha256').update(id).digest('hex').slice(0, 9));
export function shortCallIds(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === 'tool') return { ...message, tool_call_id: shortId(message.tool_call_id) };
    if (message.role !== 'assistant' || !message.tool_calls) return message;
    return { ...message, tool_calls: message.tool_calls.map((call) => ({ ...call, id: shortId(call.id) })) };
  });
}
// Kimi on NVIDIA names each call by its tool and its place in the turn ("read_doc:0"), so the same name comes back on
// every turn; such a name, like a missing one, is replaced with one of our own (see `callId`).
const PER_TURN_ID = /^(?:functions\.)?[\w-]+:\d+$/;

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

export type Entry = (typeof models)[number] & { side?: boolean; partnerOnly?: boolean; sharedPool?: boolean; pool?: string; vision?: boolean; streamUsage?: boolean; callSignature?: string; shortCallIds?: boolean; firstWordMs?: number; concurrency?: number; extra?: Record<string, unknown>; limits?: Limits };

// What the free providers give, as their own pages said on 2026-09-24. A line with only `rpm` has no published daily
// cap. Groq and Cerebras count each model apart, so `groq-qwen` and `cerebras-qwen` are a second day's worth on the
// same key. NVIDIA's terms are for prototyping, development and evaluation; kimi-k2.6 is listed there but a free account
// is refused it (404), and kimi-k3 took 106-117 s to a first word on 2026-10-02 even for "say hi", so a turn waited on it
// and then lost it: NVIDIA's own Nemotron 3 Super (120B) answers with a tool call in under 3 s. OpenRouter's free Gemma
// was rate-limited upstream on every tool call that day, so its entry is the same Nemotron on OpenRouter. Mistral's free
// plan is one request a second (`concurrency: 1`), 500k tokens a minute and a billion a month. Z.ai's flash model and Ollama's cloud take
// one request at a time (`concurrency: 1`); Z.ai's 10 a minute is our own guess, it publishes none. Its glm-4.7-flash
// answered every request on 2026-10-02 with "temporarily overloaded" (1305), so it is the older free glm-4.5-flash. Vercel gives $5 of
// credit a month, and buying any ends the free part. Cloudflare gives 10,000 neurons a day (about 130k tokens out on
// Scout) and needs the account id in its address; gpt-oss spends about 236 of them on a 25k-character request, Qwen
// about 394 and Scout 166. Their `rpd` (25, 5, 10 requests, a tool turn being two or three) come to about 9,500 at
// most, and the turns stop at 9,000 neurons counted from the answers, so the pictures keep the rest of the pool. SambaNova is 20 requests a day: the last resort.
// Probed live on 2026-10-06 with the keys already set: NVIDIA's Nemotron 3 Ultra (550B) made a tool call in 2.8 s and
// is the strongest free model behind Gemini, though one call that day came back as an empty stream, which `complete`
// takes as "answered with nothing" and passes to the next model without a mark against the key; Super stays behind it.
// Nemotron 3.5 Lightning (30B) made one in 1.9 s and is the side model behind Groq's small one. Gemini 3.5 Flash made
// one in 2.0 s and reasons better than Flash-Lite, but Google publishes no free daily figure for it and sends no quota
// headers, so its 250 a day is the free Flash day of the models before it, a guess its 429s correct; it answers only
// the partner. Ollama's cloud now runs Nemotron 3 Ultra (a whole reply in 16 s, ahead of gpt-oss there), gpt-oss on
// the same key behind it. Hugging Face's router gives $0.10 of credit a month: DeepSeek V4.1 Flash on it is the very
// last model, 30 requests a month at most. OpenRouter's free models share one 50-a-day pool on a key (`pool`).
export const ENTRIES = models as Entry[];

// Every name in the environment an entry needs: its key, then whatever its address carries as `${NAME}`.
export const needs = (entry: { keyEnv: string; baseURL: string }) => [entry.keyEnv, ...[...entry.baseURL.matchAll(/\$\{(\w+)\}/g)].map((match) => match[1])];
// The address with `${NAME}` filled in from the environment, or undefined when any of them is not set.
export function expand(baseURL: string, env: NodeJS.ProcessEnv): string | undefined {
  let missing = false;
  const filled = baseURL.replace(/\$\{(\w+)\}/g, (_, name: string) => { const value = env[name]?.trim(); if (!value) missing = true; return value ?? ''; });
  return missing ? undefined : filled;
}
// The names an entry needs that are not set here. Empty: the entry can be asked.
export const unset = (entry: { keyEnv: string; baseURL: string }, env: NodeJS.ProcessEnv) => needs(entry).filter((name) => !env[name]?.trim());

// The provider behind a client's name: `groq#2` is Groq's second key. Everything that counts what a key has spent
// works on the name; everything the founder reads works on this.
export const providerOf = (name: string) => name.split('#')[0];
// The account a key's daily requests count against. OpenRouter's 50 free requests a day are the account's, whichever
// free model asks, so `openrouter` and `openrouter-qwen` share one count; a second key (`#2`) is a second account.
export function poolOf(name: string): string {
  const [base, at] = name.split('#');
  const pool = ENTRIES.find((entry) => entry.name === base)?.pool;
  return pool ? (at ? `${pool}#${at}` : pool) : name;
}
// The free daily pool a key's answers draw from when it shares one with the pictures: Cloudflare's neurons, one pool
// per account, named by the variable its address carries the account id in (CLOUDFLARE_ACCOUNT_ID). Every model and
// every token on the account shares it: a second token (`#2`) is still that one account, and so are the pictures.
// Undefined for a key that has no such pool.
export function neuronPoolOf(name: string): string | undefined {
  const entry = ENTRIES.find((one) => one.name === providerOf(name));
  if (!entry?.sharedPool) return undefined;
  const account = needs(entry).slice(1);
  return account.length ? account.join('+') : entry.keyEnv;
}
// The pool Cloudflare's pictures draw from: the same account as its models.
export const PICTURE_POOL = 'CLOUDFLARE_ACCOUNT_ID';
// Groq's free models, whose room is a per-minute token wall (7-8k) rather than what the model can read.
export const walled = (client: Pick<ModelClient, 'name'>) => providerOf(client.name).startsWith('groq');

// A provider may hold more than one free key: `GROQ_API_KEY`, then `GROQ_API_KEY_2`, `_3` and so on, in any order.
// Each becomes a client of its own, so each has its own day's count and its own rest after a 429.
function keysOf(env: NodeJS.ProcessEnv, keyEnv: string): { key: string; at: number }[] {
  const more = new RegExp(`^${keyEnv}_(\\d+)$`);
  const spare = Object.entries(env).flatMap(([name, value]) => { const at = more.exec(name); return at && value ? [{ key: value, at: Number(at[1]) }] : []; });
  return [...(env[keyEnv] ? [{ key: env[keyEnv]!, at: 1 }] : []), ...spare.sort((one, other) => one.at - other.at)];
}

type Shape = { model: string; maxPromptChars: number; maxTokens: number; tools: boolean; side?: boolean; partnerOnly?: boolean; sharedPool?: boolean; vision?: boolean; streamUsage?: boolean; callSignature?: string; shortCallIds?: boolean; firstWordMs?: number; concurrency?: number; extra?: Record<string, unknown>; limits?: Limits; local?: boolean };

// How long a hosted model may keep silent before its first word: a hanging Gemini costs this, not the whole 45 s
// request timeout, and the next model is asked. Once anything streams, the model has all the time the request has.
const FIRST_WORD_MS = 20_000;
const PATIENT_MS = 90_000;
// Once a model has said something, how long it may then say nothing before it is taken as stalled: after the headers the
// SDK's own timeout is gone and only the 300 s body clock is left, so a stream that stops mid-reply held the room for
// five minutes. The last model able waits longer, as it does for its first word.
const IDLE_MS = 30_000;
const PATIENT_IDLE_MS = 90_000;
// A first-word wait longer than this (Kimi's minute) outlasts the 45 s request clock, which would cut the request before
// the wait was up while the provider holds its headers back until the first token: such a request gets the wait and 15 s.
const LONG_WAIT_MS = 30_000;

// `usualMs`: the first-word wait when another model able stands behind this one (`behind`), where `firstWordMs` is longer.
function clientOf(name: string, entry: Shape, api: OpenAI, firstWordMs?: number, usualMs = firstWordMs): ModelClient {
  // Requests out on this key now. Kept here, beside the one handle every copy of the client shares, so a caller that
  // never saw the usage book still cannot send a second.
  let out = 0;
  const busy = () => !!entry.concurrency && out >= entry.concurrency;
  return {
    name,
    model: entry.model,
    maxPromptChars: entry.maxPromptChars,
    tools: entry.tools,
    vision: !!entry.vision,
    limits: entry.limits ?? {},
    ...(entry.local ? { local: true } : {}),
    ...(entry.side ? { side: true } : {}),
    ...(entry.partnerOnly ? { partnerOnly: true } : {}),
    ...(entry.sharedPool ? { sharedPool: true } : {}),
    ...(entry.concurrency ? { concurrency: entry.concurrency, busy } : {}),
    ...(firstWordMs ? { firstWordMs } : {}),
    openai: api,
    async step(history, options) {
      if (busy()) throw new Error(`${name} is already answering another request`);
      out += 1;
      try { return await ask(history, options); } finally { out -= 1; }
    },
  };

  async function ask(history: ModelMessage[], { tools, signal, onToken, patient, behind }: StepOptions): Promise<ModelTurn> {
    const carried = portable(history, entry.callSignature);
    const messages = withImages(entry.shortCallIds ? shortCallIds(carried) : carried, !!entry.vision);
    // The founder's Stop and the first-word clock both end the request; only the clock's is this model's failure.
    // The last model that can take a turn gets four times as long, and never less than a minute and a half: Gemini
    // took 58.8 s to its first word on a verdict, and cutting it left the founder with no answer at all.
    // A model with somebody able behind it gets the usual wait, whatever its own: Kimi's minute cost 60 s a turn while
    // gpt-oss behind it would have answered.
    // A partner-only model keeps its own wait even then: it thinks before its first word (6-12 s on a 40k-token room,
    // more on a busy day), and cut at 20 s the partner's own turn went to Flash-Lite behind it (journey 13 pushback).
    const wait = firstWordMs && patient ? Math.max(PATIENT_MS, firstWordMs * 4) : behind && usualMs && !entry.partnerOnly ? Math.min(firstWordMs ?? usualMs, usualMs) : firstWordMs;
    const silent = wait ? new AbortController() : undefined;
    // One clock, two waits: until the first words or tool call (an empty chunk saying only who speaks does not count, or
    // a provider that sends it and then nothing never tripped the clock), and after them between any two chunks.
    const idle = patient ? PATIENT_IDLE_MS : IDLE_MS;
    let spoken = false;
    let timer = silent ? setTimeout(() => silent.abort(), wait) : undefined;
    const rearm = () => { clearTimeout(timer); timer = setTimeout(() => silent!.abort(), idle); };
    const either = silent ? (signal ? AbortSignal.any([signal, silent.signal]) : silent.signal) : signal;
    try {
      const { data: stream, response } = await api.chat.completions.create({
        model: entry.model, messages, stream: true, max_tokens: entry.maxTokens,
        ...(entry.streamUsage === false ? {} : { stream_options: { include_usage: true } }),
        ...(tools?.length ? { tools: wireTools(tools) } : {}),
        ...(entry.extra ?? {}),
      } as OpenAI.Chat.ChatCompletionCreateParamsStreaming, { signal: either, ...(wait && (patient || wait > LONG_WAIT_MS) ? { timeout: wait + 15_000 } : {}) }).withResponse();

      const calls: ToolCall[] = [];
      let usage: Usage | undefined;
      let cut = false;
      for await (const chunk of stream) {
        const said = chunk.choices[0]?.delta;
        // Thinking out loud counts: gpt-oss (Cloudflare, Groq) and Kimi stream their reasoning before any words, and cut
        // at the first-word clock mid-thought they never answered at all.
        const thinking = said as { reasoning?: string; reasoning_content?: string } | undefined;
        if (said?.content || said?.tool_calls?.length || thinking?.reasoning || thinking?.reasoning_content) spoken = true;
        if (silent && spoken) rearm();
        if (chunk.usage) {
          const neurons = (chunk.usage as { neurons?: number }).neurons;
          usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0, ...(typeof neurons === 'number' ? { neurons } : {}) };
        }
        const delta = chunk.choices[0]?.delta;
        if (chunk.choices[0]?.finish_reason === 'length') cut = true;
        if (delta?.content) onToken(delta.content);
        collectCalls(calls, delta?.tool_calls ?? []);
      }
      return { text: '', calls: calls.filter(Boolean).map((call) => ({ ...call, id: call.id && !PER_TURN_ID.test(call.id) ? call.id : callId() })), usage, quota: readQuota(response.headers), ...(cut ? { cut } : {}) };
    } catch (error) {
      if (silent?.signal.aborted && !signal?.aborted) {
        if (spoken) throw new Error(`stalled: nothing more within ${idle / 1000} s${patient ? ', the last model able' : ''} (timed out)`);
        throw new Error(`no first word within ${Math.round(wait! / 100) / 10} s${patient ? ', the last model able' : ''} (timed out)`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

// The model on this machine that answers for the people when the hosted ones cannot: where it is spoken to and which
// one. The address is the founder's bridge (a 16k window, tidy tool calls) when it is up, Ollama itself otherwise.
type LocalModel = { baseURL: string; model: string };
// Models known to call tools properly through Ollama's own chat template, best first. Others found on the machine
// are not guessed at: a model that answers with a tool call written out as prose is worse than no model at all.
const PREFERRED_LOCAL = ['qwen2.5:7b', 'qwen2.5:14b', 'qwen2.5:3b', 'llama3.1:8b', 'mistral:7b', 'mistral-nemo:12b'];

// Looks, never starts: which model on this machine the people may fall back to, or none. `STAGE_LOCAL_MODEL` names
// one outright; `STAGE_NO_LOCAL=1` keeps the people off this machine's models altogether (the founder needs Ollama
// for something else).
export async function findLocal(env: NodeJS.ProcessEnv = process.env, discover = discoverLocal): Promise<LocalModel | undefined> {
  if (env.STAGE_NO_LOCAL === '1') return undefined;
  const found = await discover().catch(() => undefined);
  if (!found) return undefined;
  const named = env.STAGE_LOCAL_MODEL?.trim();
  const model = named || PREFERRED_LOCAL.find((one) => found.models.includes(one));
  return model ? { baseURL: found.baseURL, model } : undefined;
}

// A local model is patient work: a 7B on this machine takes half a minute over a prompt the hosted ones answer in two
// seconds, and the 16k window is the bridge's. No key, no limits: what it costs is time.
function localClient(local: LocalModel): ModelClient {
  const api = new OpenAI({ apiKey: 'ollama', baseURL: local.baseURL, timeout: 180_000, maxRetries: 0 });
  return clientOf('ollama', { model: local.model, maxPromptChars: 40_000, maxTokens: 2048, tools: true, limits: {}, local: true }, api);
}

export function realClients(env: NodeJS.ProcessEnv = process.env, local?: LocalModel): ModelClient[] {
  // An entry whose key, or any name its address needs, is not set here is left out without a word: the health check
  // says once which are unset. `STAGE_FIRST_TOKEN_MS` changes the first-word clock (a test sets it short).
  // An entry may be given longer (`firstWordMs`): Kimi on NVIDIA takes 13-44 s to its first word, and cut at 20 s it was
  // cut every time and counted towards its breaker. The machine's own setting wins over both.
  const forced = Number(env.STAGE_FIRST_TOKEN_MS) > 0 ? Number(env.STAGE_FIRST_TOKEN_MS) : undefined;
  const hosted = ENTRIES.flatMap((entry) => {
    const baseURL = expand(entry.baseURL, env);
    return baseURL === undefined ? [] : keysOf(env, entry.keyEnv).map(({ key, at }) => ({ entry, key, at, baseURL }));
  }).map(({ entry, key, at, baseURL }) => {
    const api = new OpenAI({ apiKey: key, baseURL, timeout: 45_000, maxRetries: 0 });
    return clientOf(at > 1 ? `${entry.name}#${at}` : entry.name, entry, api, forced ?? entry.firstWordMs ?? FIRST_WORD_MS, forced ?? FIRST_WORD_MS);
  });
  return local ? [...hosted, localClient(local)] : hosted;
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
    // A passage of one of the founder's notes, wired to this person: the note it came from and the line the passage
    // opens with, so a browser test can see that the right part of a long note reached the prompt.
    const library = [...system.matchAll(/^From the founder's notes \(([^)]+)\):\n(.+)$/gm)].map((match) => `${match[1]} — ${match[2].slice(0, 60)}`);
    // Said back so a browser test can see that a skill learned on one turn really reached the next one's prompt:
    // the one written out in full first, then the ones only mentioned.
    const block = system.slice(system.indexOf('Your company playbook:'));
    const playbook = system.includes('Your company playbook:')
      ? [/^[^\n]*\n\n(.+)\nWhen: /.exec(block)?.[1], ...[...(block.split('Others that may fit')[1] ?? '').matchAll(/^- ([^:\n]+):/gm)].map((match) => match[1])].filter((one) => one !== undefined)
      : [];
    const last = messages.at(-1);
    const heard = messages.findLast((message) => message.role === 'user')?.content ?? '';
    // The playbook asks this in json and takes none for an answer twice; a fake person always has something to teach,
    // so a browser test can watch a skill be born without a key to a real model.
    if (/^You keep the one playbook/.test(system)) {
      // A fake person keeps the doctrine the real ones are held to: it takes the kind of thing the work was about,
      // never the whole of what it was asked, so the checks that refuse a lesson copied out of one job let it pass.
      // The kind still tells two skills apart, which is what keeps one from being dropped as a copy of the other.
      const task = /^What the founder asked .+ for:\n(.+)$/m.exec(heard)?.[1]?.replace(/^\/tool \w+ .*/, '').trim() ?? '';
      const said = task.match(/[\p{L}\p{N}]+/gu)?.filter((word) => word.length > 2 && !/^(the|and|for|with|that|this|into|then|from|about|write|make)$/i.test(word)) ?? [];
      const kind = said.slice(-2).join(' ').slice(0, 40) || 'work of this kind';
      onToken(JSON.stringify({
        action: 'create', name: `How to handle a ${kind}`.slice(0, 60), when: `When the founder needs a ${kind} and nobody has done it yet`.slice(0, 160),
        procedure: [`Read what is wired to you before starting on a ${kind}`, 'Do the work with your tools, one call at a time', `Say in a line or two what changed about the ${kind}`],
        pitfalls: [`Never say a ${kind} is done unless a tool said so`], verify: `The founder can see the ${kind} without asking.`,
      }));
      return { text: '', calls: [], usage: { input: 10, output: 40 } };
    }
    // The forge asks for a whole team in json, out of the founder's own notes. A fake one proposes two people who
    // quote the note it was given, and two cases, so a browser test can watch a team be forged, scored and placed
    // with no key to anything. The marker is the first line of `server/forge/propose.ts`'s own prompt.
    if (/^You are the forge\./.test(system)) {
      const title = /^## The founder's note: (.+)$/m.exec(heard)?.[1] ?? "the founder's notes";
      const sections = (/^Its sections, in order: (.+)$/m.exec(heard)?.[1] ?? '').split(' · ').filter((one) => one && one !== '(none)' && one !== title);
      const where = (index: number) => `Work from section "${sections[index] ?? title}" of "${title}".`;
      onToken(JSON.stringify({
        name: 'Forged team',
        rooms: [
          { key: 'finder', name: 'Ada', role: 'Assumption finder', brief: `${where(0)} Name the one belief the whole idea rests on, as a sentence that could be shown to be false.` },
          { key: 'judge', name: 'Bruno', role: 'Verdict judge', brief: `${where(1)} Read what the finder said and give one verdict, in the words the note allows and no others.` },
        ],
        docs: [{ key: 'working', title: 'Working notes', text: `# Working notes\n\n## ${sections[0] ?? 'Findings'}\n` }],
        cards: [],
        wires: [{ from: 'finder', to: 'working' }, { from: 'judge', to: 'working' }, { from: 'judge', to: 'finder' }],
        dataset: [
          { id: 'first-case', keys: ['finder'], input: 'Idea: people rent out a spare room in their own home to travellers. Name the core assumption.', rubric: sections[0] ?? 'The one belief that, if false, makes everything else irrelevant.' },
          { id: 'second-case', keys: ['judge'], input: 'The assumption holds, the flaws are survivable and the pain is real. What is the verdict?', expected: 'STRONG' },
        ],
      }));
      return { text: '', calls: [], usage: { input: 40, output: 200 } };
    }
    const asked = [...heard.matchAll(/^\/tool (\w+) (\{.*\})$/gm)];
    // Only what has run since the founder spoke: earlier turns leave their own tool messages in the conversation.
    const wanted = asked[messages.slice(messages.findLastIndex((message) => message.role === 'user')).filter((message) => message.role === 'tool').length];
    if (wanted && tools?.some((tool) => tool.name === wanted[1])) {
      return { text: '', calls: [{ id: callId(), name: wanted[1], args: wanted[2] }], usage: { input: 10, output: 5 } };
    }
    // Work handed over ends in a shape the asker can read, and nothing else goes back. A fake person can write one,
    // so a browser test can watch a whole piece of work be given away without a key to a real model.
    if (/Finish with one json object and nothing after it/.test(heard)) {
      // What the tools said stays in their own room: a hand-over is what they did, not everything they read.
      const since = messages.slice(messages.findLastIndex((message) => message.role === 'user'));
      const changed = since.flatMap((message) => (message.role === 'assistant' && message.tool_calls ? message.tool_calls.map((call) => call.function.name) : []));
      onToken(JSON.stringify({ done: true, summary: `${name} did what was asked.`, changed }));
      return { text: '', calls: [], usage: { input: 10, output: 20 } };
    }
    // Drawing a picture and then making a film with it, in one turn — what a person has to be able to do when the
    // founder says "generate an image and use that in the video". The path comes back in the first tool's own
    // words, and goes straight into the second call.
    if (/^\/chain\b/m.test(heard) && tools?.some((tool) => tool.name === 'generate_video')) {
      const drew = last?.role === 'tool' ? /saved at (\S+)/.exec(last.content) : null;
      if (drew) {
        const brief = heard.replace(/^\/chain\s*/m, '').trim() || 'a short film';
        return { text: '', calls: [{ id: callId(), name: 'generate_video', args: JSON.stringify({ brief, images: [drew[1]] }) }], usage: { input: 10, output: 5 } };
      }
      if (last?.role === 'user' && tools.some((tool) => tool.name === 'generate_image')) {
        return { text: '', calls: [{ id: callId(), name: 'generate_image', args: JSON.stringify({ prompt: 'an influencer talking to camera' }) }], usage: { input: 10, output: 5 } };
      }
    }
    const reply = last?.role === 'tool'
      ? `Tool said: ${last.content}`
      : heard.startsWith('/markdown') ? '**Bold plan**\n\n- one\n- two'
      : heard.startsWith('/rich') ? 'A flow:\n\n```mermaid\ngraph TD; Idea-->Build; Build-->Launch;\n```\n\nA page:\n\n```html\n<!doctype html><html><body><h1 id="t">Landing</h1><script>document.getElementById("t").textContent += " page";</script></body></html>\n```'
      : last?.role === 'user' && last.images?.length ? `I can see ${last.images.length} picture: ${last.images[0].name.split('/').pop()}.`
      : `${name} here. You said: "${heard}". Docs I can read: ${docs.join(', ') || 'none'}.${notes ? ` Notes: ${notes}.` : ''}${pages.length ? ` Pages: ${pages.join(', ')}.` : ''}${studios.length ? ` Studios: ${studios.join(', ')}.` : ''}${library.length ? ` Library: ${library.join('; ')}.` : ''}${playbook.length ? ` Playbook: ${playbook.join(', ')}.` : ''}`;
    const delay = heard.startsWith('/slow') ? 150 : 15;
    for (const word of reply.split(/(?<= )/)) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (signal?.aborted) throw new Error('aborted');
      onToken(word);
    }
    return { text: '', calls: [], usage: { input: Math.ceil(promptSize(messages) / 4), output: Math.ceil(reply.length / 4) } };
  },
};
