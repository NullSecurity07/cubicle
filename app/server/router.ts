import type { ModelClient } from './providers.ts';
import type { UsageBook } from './usage.ts';

const FLOOR = 0.05;
const title = (name: string) => name[0].toUpperCase() + name.slice(1);

// The order in which to try models for one turn, and a line for the founder when it is not the usual one.
// A pinned model always goes first; the rest stay behind it only as a net for a hard failure.
// Auto keeps the configured order but moves any model that is out of room, or about to be, to the back.
export function route(clients: ModelClient[], usage: UsageBook, want: { pinned?: string; promptChars: number; tools: boolean }) {
  const able = clients.filter((client) => client.maxPromptChars >= want.promptChars && (!want.tools || client.tools));
  const pool = able.length ? able : clients;
  const pinned = want.pinned && want.pinned !== 'auto' ? pool.find((client) => client.name === want.pinned) : undefined;
  const roomy = (client: ModelClient) => usage.left(client) > FLOOR && !usage.hot(client, want.promptChars);

  if (pinned) {
    const share = usage.left(pinned);
    const notice = share <= FLOOR ? `${title(pinned.name)} has no free quota left today. Another model answers if it fails.`
      : share < 0.2 ? `${title(pinned.name)} has ${Math.round(share * 100)}% of today's free quota left.` : undefined;
    return { order: [pinned, ...pool.filter((client) => client !== pinned && roomy(client))], notice };
  }
  if (want.pinned && want.pinned !== 'auto') {
    return { order: [...pool.filter(roomy), ...pool.filter((client) => !roomy(client))], notice: `${title(want.pinned)} is not set up here, so another model answers.` };
  }
  const order = [...pool.filter(roomy), ...pool.filter((client) => !roomy(client))];
  const first = pool[0];
  const notice = order[0] && first && order[0] !== first
    ? `${title(first.name)} is near its free limit, so ${title(order[0].name)} answers for now.` : undefined;
  return { order, notice };
}
