import { providerOf, walled, type ModelClient } from '../providers.ts';
import { FLOOR, LOW_EFFORT, route, SECOND, STRONG, tier } from '../router.ts';
import type { UsageBook } from '../usage.ts';

// The partner answers the calls that matter (raise, hire, spend, pivot), so their turns go to the strongest free
// models the app has, in the one order every turn now uses (router.ts), and never to the small side model.
// gpt-oss on Cloudflare's day is the neuron pool the pictures share, capped at 9,000 of the 10,000 so they keep their part.
export { STRONG, SECOND, LOW_EFFORT };
const title = (name: string) => name[0].toUpperCase() + name.slice(1);

// The one road every turn of a person takes, whoever started it: the founder's chat, a board run or repeat, a
// colleague handing them work. The partner (unpinned) goes by the partner's route, so a turn of theirs that did not
// start in their chat still reaches the partner-only model first; anyone else, or a pinned partner, by the router.
export function turnRoute(room: { partner?: boolean; model?: string } | undefined, clients: ModelClient[], usage: UsageBook, want: { promptChars: number; tools: boolean; vision?: boolean }) {
  return room?.partner && !room.model ? partnerRoute(clients, usage, want) : route(clients, usage, { pinned: room?.model, ...want });
}

export function partnerRoute(clients: ModelClient[], usage: UsageBook, want: { promptChars: number; tools: boolean; vision?: boolean }) {
  const { order } = route(clients, usage, { ...want, kind: 'turn', partner: true });
  const roomy = (client: ModelClient) => usage.left(client) > FLOOR && !usage.hot(client, want.promptChars);
  // Roomy before resting, hosted before this machine, then by strength; the router's order breaks ties.
  const key = (client: ModelClient) => [roomy(client) ? 0 : 1, client.local ? 1 : 0, tier(client, true), order.indexOf(client)];
  const compare = (a: ModelClient, b: ModelClient) => { const x = key(a); const y = key(b); const at = x.findIndex((value, index) => value !== y[index]); return at < 0 ? 0 : x[at] - y[at]; };
  // A small model on this machine never answers the partner while a hosted one is set up: the calls that matter are
  // exactly the ones a local 7B gets wrong, and one that took over made six tool calls under one id and broke the room.
  const hosted = order.some((client) => !client.local && !client.side);
  // Groq's free tier is walled at 7-8k tokens a minute: a room prompt fits once a minute at best, and its gpt-oss told
  // a founder with no users to raise. It never answers the partner while any other hosted model is set up.
  const others = order.some((client) => !client.local && !client.side && !walled(client));
  const sorted = [...order].filter((client) => (!hosted || (!client.local && !client.side)) && (!others || !walled(client))).sort(compare);
  const first = sorted[0];
  // Journey 13: the partner's own model (Gemini 3.5 Flash, 20 free requests a day for the whole project) was spent,
  // and the founder's pushback went to Flash-Lite without a word. Said now, with which wall it was.
  const own = sorted.find((client) => client.partnerOnly);
  const ownWhy = !own || own === first ? '' : usage.dead?.(own.name) ? 'had its key refused' : usage.left(own) <= FLOOR ? "has used today's free requests"
    : usage.resting(own.name) ? 'is resting after a limit' : '';
  const notice = first && own && ownWhy ? `Your partner's own model (${title(own.name)}) ${ownWhy}, so ${title(providerOf(first.name))} answers for now.`
    : first && !STRONG.includes(providerOf(first.name)) && clients.some((one) => STRONG.includes(providerOf(one.name)))
      ? `Your partner's stronger models are resting, so ${title(providerOf(first.name))} answers for now.` : undefined;
  return { order: sorted, notice };
}
