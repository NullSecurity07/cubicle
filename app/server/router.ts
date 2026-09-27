import { sideClient } from './cache.ts';
import { providerOf, type ModelClient } from './providers.ts';
import type { UsageBook } from './usage.ts';

// Below this share of a day's free quota a provider is treated as spent: what is left would not survive a turn.
export const FLOOR = 0.05;
const title = (name: string) => name[0].toUpperCase() + name.slice(1);

// One order for every turn, the partner's and everyone else's: the strongest free models first. Gemini held its ground
// in the live runs; gpt-oss on Cloudflare held a 25-40k room prompt with a tool call and answered best and fast; Kimi on
// NVIDIA took 13-44 s to a first word, so it stands behind both, where a colleague's turn in journey 10 waited 20 s on
// Gemini and then 60 s on it before gpt-oss answered. SambaNova is 20 requests a day.
export const STRONG = ['gemini', 'cloudflare-gpt-oss', 'nvidia', 'mistral', 'sambanova'];
// Behind them, the Qwens that also held a room prompt: OpenRouter's (only there when its key is set), then
// Cloudflare's, which invented one claim. Everything else follows in the order it is listed.
export const SECOND = ['openrouter-qwen', 'cloudflare-qwen'];
// gpt-oss at low reasoning effort (Groq, Cerebras) drafted a raise plan for a company with no users: last.
export const LOW_EFFORT = ['groq', 'cerebras'];
// Where a model stands in that order; a sort by it is stable, so the listed order breaks ties.
export const tier = (client: ModelClient) => {
  const name = providerOf(client.name);
  const at = [...STRONG, ...SECOND].indexOf(name);
  const rest = STRONG.length + SECOND.length;
  return at >= 0 ? at : LOW_EFFORT.includes(name) ? rest + 1 : rest;
};

// A turn is a person answering; a side call is one of the calls around it (a summary, a reflection, a compaction
// note). Side calls go to the small side model first and may be answered from the cache; a turn never reaches either.
type CallRoute = 'turn' | 'side';
type Want = { pinned?: string; promptChars: number; tools: boolean; vision?: boolean; kind?: CallRoute };

// One provider's keys take turns: within the places the order already gives that provider, the key that has carried
// least goes first, the last minute counting before the day, so `groq` and `groq#2` share the load instead of the
// first being drained before the second is touched. Nothing moves between providers.
export function spread(order: ModelClient[], usage: UsageBook): ModelClient[] {
  const load = new Map(order.map((client) => [client, usage.carried(client.name)]));
  const lighter = (one: ModelClient, other: ModelClient) => {
    const a = load.get(one)!;
    const b = load.get(other)!;
    return a.minute - b.minute || a.requests - b.requests || a.day - b.day;
  };
  const keys = new Map<string, ModelClient[]>();
  for (const client of order) keys.set(providerOf(client.name), [...(keys.get(providerOf(client.name)) ?? []), client]);
  for (const [name, list] of keys) if (list.length > 1) keys.set(name, [...list].sort(lighter));
  const taken = new Map<string, number>();
  return order.map((client) => {
    const name = providerOf(client.name);
    const at = taken.get(name) ?? 0;
    taken.set(name, at + 1);
    return keys.get(name)![at];
  });
}

// The order in which to try models for one call, and a line for the founder when it is not the usual one.
// A pinned model always goes first; the rest stay behind it only as a net for a hard failure.
// Auto keeps the configured order but moves any model that is out of room, or about to be, to the back.
export function route(clients: ModelClient[], usage: UsageBook, want: Want) {
  // A side call keeps the order it was given: summaries read the list backwards on purpose.
  if ((want.kind ?? 'turn') === 'turn') return rank([...clients.filter((client) => !client.side)].sort((a, b) => tier(a) - tier(b)), usage, want);
  const found = rank(clients, usage, want);
  // The small model first while it has room; the rest behind it keep the fallthrough as it always was.
  const side = found.order.filter((client) => client.side && usage.left(client) > FLOOR && !usage.hot(client, want.promptChars));
  const order = [...side, ...found.order.filter((client) => !side.includes(client))];
  return { order: order.map((client) => sideClient(client, usage, usage.clock)), notice: found.notice };
}

function rank(clients: ModelClient[], usage: UsageBook, want: Want) {
  const able = clients.filter((client) => client.maxPromptChars >= want.promptChars && (!want.tools || client.tools));
  // A turn with a picture in it goes to a model that can see, when one is set up.
  const seeing = want.vision ? able.filter((client) => client.vision) : [];
  const found = seeing.length ? [...seeing, ...able.filter((client) => !client.vision)] : able.length ? able : clients;
  // A model whose day is a pool it shares with the pictures is left out once its own daily turns are used, unless it
  // is all there is: asking it more would spend the neurons the founder's pictures need.
  const open = found.filter((client) => !(client.sharedPool && usage.spent?.(client)));
  const pool = open.length ? open : found;
  // A pinned provider means every key it has here, the roomiest first: one key resting on a 429 is not the founder
  // asking for another provider.
  const pinned = want.pinned && want.pinned !== 'auto' ? pool.filter((client) => providerOf(client.name) === want.pinned) : [];
  const roomy = (client: ModelClient) => usage.left(client) > FLOOR && !usage.hot(client, want.promptChars);
  // A model on this machine stands behind every hosted one that still has room, wherever it was listed: it is the
  // net under the free quotas, not a peer of them. It still comes before a hosted model that is out of room.
  const settle = (list: ModelClient[]) => spread([...list.filter((client) => !client.local), ...list.filter((client) => client.local)], usage);

  if (pinned.length) {
    const share = Math.max(...pinned.map((client) => usage.left(client)));
    const notice = share <= FLOOR ? `${title(want.pinned!)} has no free quota left today. Another model answers if it fails.`
      : share < 0.2 ? `${title(want.pinned!)} has ${Math.round(share * 100)}% of today's free quota left.` : undefined;
    return { order: [...spread(pinned.filter(roomy), usage), ...spread(pinned.filter((client) => !roomy(client)), usage), ...settle(pool.filter((client) => !pinned.includes(client) && roomy(client)))], notice };
  }
  if (want.pinned && want.pinned !== 'auto') {
    return { order: [...settle(pool.filter(roomy)), ...settle(pool.filter((client) => !roomy(client)))], notice: `${title(want.pinned)} is not set up here, so another model answers.` };
  }
  const order = [...settle(pool.filter(roomy)), ...settle(pool.filter((client) => !roomy(client)))];
  const first = settle(pool)[0];
  // One that is only busy with another request for a moment is not near any limit, and nothing is said. Otherwise
  // the founder hears which wall it was: a refused key, the day's quota (what the dashboard's "left" counts) or only
  // this minute, so the notice never says "limit" while the dashboard says most of the day is left.
  const why = !first ? '' : usage.dead?.(first.name) ? 'refused its key' : usage.left(first) <= FLOOR ? "has used today's free quota"
    : usage.slow?.(first.name) ? 'was slow to start answering twice' : 'is busy this minute';
  const notice = order[0] && first && order[0] !== first && !first.busy?.()
    ? why === 'refused its key' ? `${title(providerOf(first.name))}'s key was refused, so ${title(providerOf(order[0].name))} answers. Fix it in Keys.`
      : `${title(first.name)} ${why}, so ${title(order[0].name)} answers for now.` : undefined;
  return { order, notice };
}
