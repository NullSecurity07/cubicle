import { modelTitle } from '../shared/modelNames.ts';
import { sideClient } from './cache.ts';
import { providerOf, type ModelClient } from './providers.ts';
import { unaskedAllowed, type UsageBook } from './usage.ts';

// Below this share of a day's free quota a provider is treated as spent: what is left would not survive a turn.
export const FLOOR = 0.05;
// Every model is said by its name, never by the id the config gives it.
const title = modelTitle;

// One order for every turn, the partner's and everyone else's: the strongest free models first. Gemini held its ground
// in the live runs; gpt-oss on Cloudflare held a 25-40k room prompt with a tool call and answered best and fast; Kimi on
// NVIDIA took 13-44 s to a first word, so it stands behind both, where a colleague's turn in journey 10 waited 20 s on
// Gemini and then 60 s on it before gpt-oss answered. SambaNova is 20 requests a day.
// The same gpt-oss-120b on Ollama's cloud (answering with all 70 tools on 2026-10-02, no daily cap published) goes
// right after Gemini, ahead of Cloudflare's copy: every turn it takes leaves Cloudflare's neurons to the pictures.
// NVIDIA is now its own Nemotron 3 Super, quick to answer; Kimi on the same key (`nvidia-kimi`) took two minutes to
// a first word, so it is not among these and is reached only when they cannot answer.
// 2026-10-06: Gemini 3.5 Flash (`gemini-flash`, 20 free requests a day for the project: its 429 says so) answers the
// partner ahead of Flash-Lite and nobody else; NVIDIA's Nemotron 3 Ultra stands right behind Gemini (a tool call in
// 2.8 s), then Ollama's cloud (now Nemotron 3 Ultra too, one request at a time), Super on NVIDIA, and gpt-oss on Ollama behind the models that took its place. Mistral and SambaNova
// keep their places for a founder whose plan or card turns them on; with no key they are simply not there.
// The whole order a turn is tried in, with every key set:
//   partner:   gemini-flash, gemini, nvidia-ultra, ollama-cloud, cloudflare-gpt-oss, nvidia, ollama-gpt-oss, mistral,
//              sambanova, openrouter-qwen, cloudflare-qwen, then the rest as listed in models.json, groq and cerebras,
//              and Hugging Face (`hf`) last of all
//   colleague: gemini, nvidia-ultra, ollama-cloud, nvidia, ollama-gpt-oss, mistral, sambanova, cloudflare-gpt-oss, then
//              the same tail
// Side calls: groq-small, then nvidia-lightning (Nemotron 3.5 Lightning, a tool call in 1.9 s), then the turn order.
export const STRONG = ['gemini-flash', 'gemini', 'nvidia-ultra', 'ollama-cloud', 'cloudflare-gpt-oss', 'nvidia', 'ollama-gpt-oss', 'mistral', 'sambanova'];
// A colleague's turns take the same strong models with gpt-oss on Cloudflare last among them: its 25 requests a day
// are kept for the partner, whose calls matter most, where a busy team would spend them by mid-morning.
const COLLEAGUE = ['gemini', 'nvidia-ultra', 'ollama-cloud', 'nvidia', 'ollama-gpt-oss', 'mistral', 'sambanova', 'cloudflare-gpt-oss'];
export const tierOrder = (partner = false) => [...(partner ? STRONG : COLLEAGUE), ...SECOND];
// Behind them, the Qwens that also held a room prompt: OpenRouter's (only there when its key is set), then
// Cloudflare's, which invented one claim. Everything else follows in the order it is listed.
export const SECOND = ['openrouter-qwen', 'cloudflare-qwen'];
// gpt-oss at low reasoning effort (Groq, Cerebras) drafted a raise plan for a company with no users: last.
export const LOW_EFFORT = ['groq', 'cerebras'];
// Paid out of a small monthly credit, so it is the very last of all: only when nothing free can answer.
export const LAST = ['hf'];
// Where a model stands in that order; a sort by it is stable, so the listed order breaks ties.
export const tier = (client: ModelClient, partner = false) => {
  const name = providerOf(client.name);
  const at = tierOrder(partner).indexOf(name);
  const rest = STRONG.length + SECOND.length;
  return at >= 0 ? at : LAST.includes(name) ? rest + 2 : LOW_EFFORT.includes(name) ? rest + 1 : rest;
};

// A turn is a person answering; a side call is one of the calls around it (a summary, a reflection, a compaction
// note). Side calls go to the small side model first and may be answered from the cache; a turn never reaches either.
type CallRoute = 'turn' | 'side';
// `partner`: the partner's own turn, the only one a partner-only model may answer.
// `unasked`: work nobody asked for (usage.ts, createUnasked). It never goes to a partner-only model or to one with under a
// quarter of its day left, even when that leaves nobody: the work waits rather than spend the founder's day.
type Want = { pinned?: string; promptChars: number; tools: boolean; vision?: boolean; kind?: CallRoute; partner?: boolean; unasked?: boolean };

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
export function route(all: ModelClient[], usage: UsageBook, want: Want) {
  // A partner-only model is not there for anyone else; one whose month is used (`rpmo`) is not there at all, even when it
  // is all there is: its credit is the founder's money.
  const clients = all.filter((client) => (want.partner || !client.partnerOnly) && !(client.limits.rpmo && usage.spent?.(client)));
  if (want.unasked) return routeUnasked(clients.filter((client) => unaskedAllowed(client, usage)), usage, want);
  // A side call keeps the order it was given: summaries read the list backwards on purpose.
  // A side model only writes the short calls around a turn. Pinned to a person, it cannot answer their turn, and the
  // founder hears that, not that it is missing: its key is there.
  const pin = want.pinned && want.pinned !== 'auto' ? clients.filter((client) => providerOf(client.name) === want.pinned) : [];
  if ((want.kind ?? 'turn') === 'turn' && pin.length && pin.every((client) => client.side)) {
    const found = rank([...clients.filter((client) => !client.side)].sort((a, b) => tier(a) - tier(b)), usage, { ...want, pinned: undefined });
    return { order: found.order, notice: `${title(want.pinned!)} is a side model (short answers); the turn uses the normal order.` };
  }
  if ((want.kind ?? 'turn') === 'turn') return rank([...clients.filter((client) => !client.side)].sort((a, b) => tier(a) - tier(b)), usage, want);
  const found = rank(clients, usage, want);
  // The small model first while it has room; the rest behind it keep the fallthrough as it always was.
  const side = found.order.filter((client) => client.side && usage.left(client) > FLOOR && !usage.hot(client, want.promptChars));
  const order = [...side, ...found.order.filter((client) => !side.includes(client))];
  return { order: order.map((client) => sideClient(client, usage, usage.clock)), notice: found.notice };
}

function routeUnasked(clients: ModelClient[], usage: UsageBook, want: Want) {
  const { unasked: _, partner: __, ...rest } = want;
  if ((want.kind ?? 'turn') === 'turn') return rank([...clients.filter((client) => !client.side)].sort((a, b) => tier(a) - tier(b)), usage, rest);
  return rank(clients, usage, rest);
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
