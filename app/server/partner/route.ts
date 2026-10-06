import { providerOf, walled, type ModelClient } from '../providers.ts';
import { asksVerdict } from './call.ts';
import { FLOOR, LOW_EFFORT, route, SECOND, STRONG, tier } from '../router.ts';
import type { UsageBook } from '../usage.ts';

// The partner answers the calls that matter (raise, hire, spend, pivot), so their turns go to the strongest free
// models the app has, in the one order every turn now uses (router.ts), and never to the small side model.
// gpt-oss on Cloudflare's day is the neuron pool the pictures share, capped at 9,000 of the 10,000 so they keep their part.
export { STRONG, SECOND, LOW_EFFORT };
const title = (name: string) => name[0].toUpperCase() + name.slice(1);

// The partner-only model (Gemini 3.5 Flash) has 20 free requests a day for the whole project: a founder talking to the
// partner would spend them by noon. So it is kept for the turns that commit: the verdict on the company, the
// founder's pushback in the hour after one, and the morning note. Every other partner turn takes the usual order.
export const PUSHBACK_MS = 60 * 60_000;
const verdicts = new Map<string, number>();
// Heard when a verdict is held in the partner's room (and once at start from the kept state).
export const markVerdict = (roomId: string, at: number) => { if (at > (verdicts.get(roomId) ?? 0)) verdicts.set(roomId, at); };
export const reservedTurn = (roomId: string, query: string, now = Date.now()) => asksVerdict(query) || now - (verdicts.get(roomId) ?? -Infinity) < PUSHBACK_MS;

// The one road every turn of a person takes, whoever started it: the founder's chat, a board run or repeat, a
// colleague handing them work. The partner (unpinned) goes by the partner's route, the partner-only model first only
// on a reserved turn (`asked`); anyone else, or a pinned partner, by the router.
export function turnRoute(room: { id?: string; partner?: boolean; model?: string } | undefined, clients: ModelClient[], usage: UsageBook, want: { promptChars: number; tools: boolean; vision?: boolean; unasked?: boolean }, asked?: { query: string; now?: number }) {
  if (!room?.partner || room.model) return route(clients, usage, { pinned: room?.model, ...want });
  // Unasked work is never a reserved turn: the partner's own model is kept for what the founder asks.
  return partnerRoute(clients, usage, { ...want, reserved: !want.unasked && !!asked && !!room.id && reservedTurn(room.id, asked.query, asked.now) });
}

// `reserved`: a turn the partner-only model may answer (see `reservedTurn`); without it, it is left out.
// `unasked`: work nobody asked for, which never takes the partner-only model or one under a quarter of its day.
export function partnerRoute(clients: ModelClient[], usage: UsageBook, want: { promptChars: number; tools: boolean; vision?: boolean; reserved?: boolean; unasked?: boolean }) {
  const { reserved, ...asked } = want;
  const { order } = route(clients, usage, { ...asked, kind: 'turn', partner: !!reserved && !want.unasked });
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
