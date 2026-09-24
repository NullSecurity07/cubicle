import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { leadsChannel, TWENTY_CHANNEL, type LeadsEvent, type TwentyStatus } from '../../shared/leads.ts';
import type { Stage } from '../../shared/model.ts';
import { hub } from '../events.ts';
import type { Slice } from '../install.ts';
import { leadsFor } from '../leads/store.ts';
import { createMirror, createTwentyClient, twentyConfig, type Mirror } from '../leads/twenty.ts';

// Connect Twenty: when the founder runs their own Twenty and puts TWENTY_URL and TWENTY_API_KEY in the .env, every
// lead on every Leads card is mirrored there, and what they change there comes back. Without both, this does nothing.
// It never runs Twenty itself. In fake mode it stays off unless STAGE_TWENTY_IN_FAKE=1, so a test run never writes
// made-up leads into the founder's real Twenty.

const cardsOf = (stage: Stage) => (stage.cards ?? []).filter((card) => card.kind === 'leads').map((card) => card.id);
const OFF: TwentyStatus = { connected: false, url: '', lastSync: null, pushed: 0, pulled: 0 };

export default {
  name: 'twenty',
  install(deps) {
    const config = twentyConfig(process.env);
    const off = !config || (deps.fake && process.env.STAGE_TWENTY_IN_FAKE !== '1');
    let mirror: Mirror | null = null;
    const route = async (req: IncomingMessage, res: ServerResponse, path: string) => {
      if (path !== '/api/twenty/status' || (req.method ?? 'GET') !== 'GET') return false;
      deps.json(res, 200, mirror ? mirror.status() : OFF);
      return true;
    };
    if (off) return { route };

    const say = (cardId: string, event: LeadsEvent) => hub.say(leadsChannel(cardId), event);
    const tell = (status: TwentyStatus) => hub.say(TWENTY_CHANNEL, status);
    mirror = createMirror({
      client: createTwentyClient(config),
      leads: leadsFor(deps.workspace, say),
      cards: async () => cardsOf(await deps.store.loadStage()),
      statePath: join(deps.workspace, 'twenty', 'state.json'),
      onStatus: tell,
    });
    const running = mirror;
    const opening = async () => [{ channel: TWENTY_CHANNEL, data: running.status() }];
    const unopen = hub.open(opening);
    console.log(`Twenty: connected to ${config.url}; leads are mirrored there every half minute.`);

    return {
      route,
      tick: () => running.sync(),
      async close() {
        unopen();
      },
    };
  },
} satisfies Slice;
