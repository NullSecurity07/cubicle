import { providerOf, type ModelClient } from './providers.ts';
import type { UsageBook } from './usage.ts';

// Below this share of a day's free quota a provider is treated as spent: what is left would not survive a turn.
export const FLOOR = 0.05;
const title = (name: string) => name[0].toUpperCase() + name.slice(1);

// The order in which to try models for one turn, and a line for the founder when it is not the usual one.
// A pinned model always goes first; the rest stay behind it only as a net for a hard failure.
// Auto keeps the configured order but moves any model that is out of room, or about to be, to the back.
export function route(clients: ModelClient[], usage: UsageBook, want: { pinned?: string; promptChars: number; tools: boolean; vision?: boolean }) {
  const able = clients.filter((client) => client.maxPromptChars >= want.promptChars && (!want.tools || client.tools));
  // A turn with a picture in it goes to a model that can see, when one is set up.
  const seeing = want.vision ? able.filter((client) => client.vision) : [];
  const pool = seeing.length ? [...seeing, ...able.filter((client) => !client.vision)] : able.length ? able : clients;
  // A pinned provider means every key it has here, the roomiest first: one key resting on a 429 is not the founder
  // asking for another provider.
  const pinned = want.pinned && want.pinned !== 'auto' ? pool.filter((client) => providerOf(client.name) === want.pinned) : [];
  const roomy = (client: ModelClient) => usage.left(client) > FLOOR && !usage.hot(client, want.promptChars);
  // A model on this machine stands behind every hosted one that still has room, wherever it was listed: it is the
  // net under the free quotas, not a peer of them. It still comes before a hosted model that is out of room.
  const settle = (list: ModelClient[]) => [...list.filter((client) => !client.local), ...list.filter((client) => client.local)];

  if (pinned.length) {
    const share = Math.max(...pinned.map((client) => usage.left(client)));
    const notice = share <= FLOOR ? `${title(want.pinned!)} has no free quota left today. Another model answers if it fails.`
      : share < 0.2 ? `${title(want.pinned!)} has ${Math.round(share * 100)}% of today's free quota left.` : undefined;
    return { order: [...pinned.filter(roomy), ...pinned.filter((client) => !roomy(client)), ...settle(pool.filter((client) => !pinned.includes(client) && roomy(client)))], notice };
  }
  if (want.pinned && want.pinned !== 'auto') {
    return { order: [...settle(pool.filter(roomy)), ...settle(pool.filter((client) => !roomy(client)))], notice: `${title(want.pinned)} is not set up here, so another model answers.` };
  }
  const order = [...settle(pool.filter(roomy)), ...settle(pool.filter((client) => !roomy(client)))];
  const first = settle(pool)[0];
  const notice = order[0] && first && order[0] !== first
    ? `${title(first.name)} is near its free limit, so ${title(order[0].name)} answers for now.` : undefined;
  return { order, notice };
}
