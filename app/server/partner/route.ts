import { providerOf, walled, type ModelClient } from '../providers.ts';
import { FLOOR, route } from '../router.ts';
import type { UsageBook } from '../usage.ts';

// The partner answers the calls that matter (raise, hire, spend, pivot), so their turns go to the strongest free
// models the app has, in this order, and never to the small side model. Gemini held its ground in the live runs;
// gpt-oss at low reasoning effort (Groq, Cerebras) drafted a raise plan for a company with no users, so it stands last
// and answers only while every stronger one is resting.
export const STRONG = ['gemini', 'nvidia', 'mistral', 'sambanova'];
// Behind them, the hosted models that held a 25-40k room prompt with a tool call in the round-5 probes, best answer
// first: gpt-oss on Cloudflare said "don't raise" where Scout was generic, and Qwen invented one claim. OpenRouter's
// Qwen is only there when its key is set. Everything else follows in the router's own order.
export const SECOND = ['cloudflare-gpt-oss', 'openrouter-qwen', 'cloudflare-qwen'];
export const LOW_EFFORT = ['groq', 'cerebras'];
const title = (name: string) => name[0].toUpperCase() + name.slice(1);

const tier = (client: ModelClient) => {
  const name = providerOf(client.name);
  const at = [...STRONG, ...SECOND].indexOf(name);
  const rest = STRONG.length + SECOND.length;
  return at >= 0 ? at : LOW_EFFORT.includes(name) ? rest + 1 : rest;
};

export function partnerRoute(clients: ModelClient[], usage: UsageBook, want: { promptChars: number; tools: boolean; vision?: boolean }) {
  const { order } = route(clients, usage, { ...want, kind: 'turn' });
  const roomy = (client: ModelClient) => usage.left(client) > FLOOR && !usage.hot(client, want.promptChars);
  // Roomy before resting, hosted before this machine, then by strength; the router's order breaks ties.
  const key = (client: ModelClient) => [roomy(client) ? 0 : 1, client.local ? 1 : 0, tier(client), order.indexOf(client)];
  const compare = (a: ModelClient, b: ModelClient) => { const x = key(a); const y = key(b); const at = x.findIndex((value, index) => value !== y[index]); return at < 0 ? 0 : x[at] - y[at]; };
  // A small model on this machine never answers the partner while a hosted one is set up: the calls that matter are
  // exactly the ones a local 7B gets wrong, and one that took over made six tool calls under one id and broke the room.
  const hosted = order.some((client) => !client.local && !client.side);
  // Groq's free tier is walled at 7-8k tokens a minute: a room prompt fits once a minute at best, and its gpt-oss told
  // a founder with no users to raise. It never answers the partner while any other hosted model is set up.
  const others = order.some((client) => !client.local && !client.side && !walled(client));
  const sorted = [...order].filter((client) => (!hosted || (!client.local && !client.side)) && (!others || !walled(client))).sort(compare);
  const first = sorted[0];
  const notice = first && !STRONG.includes(providerOf(first.name)) && clients.some((one) => STRONG.includes(providerOf(one.name)))
    ? `Your partner's stronger models are resting, so ${title(providerOf(first.name))} answers for now.` : undefined;
  return { order: sorted, notice };
}
