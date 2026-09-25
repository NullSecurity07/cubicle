import type { Stage } from '../../shared/model.ts';
import type { Approvals } from '../approvals.ts';
import type { AttentionBook } from '../attention.ts';
import type { Browser } from '../browser.ts';
import type { createEvents } from '../events.ts';
import { answer, body, openFeed, type Route } from '../http.ts';
import type { Store } from '../store.ts';
import { browserSession } from '../tools/web.ts';

// The stage itself, the one live feed a window holds, and the founder's answers to what was put to them.
export function stageRoutes(deps: { store: Store; events: ReturnType<typeof createEvents>; browser: Pick<Browser, 'close'>; attention: Pick<AttentionBook, 'refresh'>; approvals: Approvals }): Route {
  const { store, events, browser, attention, approvals } = deps;
  return async (req, res, path) => {
    if (path === '/api/stage' && req.method === 'GET') return answer(res, 200, await store.loadStage());
    // One connection for the whole window, carrying every feed below it under its own channel name. The comment on
    // opening, and the pulse, are the rooms feed's for the rooms feed's reasons: a window knows it is listening
    // before the first word arrives, and it can tell a feed that has gone quiet from one that has died.
    if (path === '/api/events' && req.method === 'GET') {
      openFeed(res);
      res.write(': listening\n\n');
      // A window that goes away while its opening is still being read has to leave whenever it does arrive.
      let leave = () => {};
      res.on('close', () => leave());
      const stop = await events.join((envelope) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(envelope)}\n\n`); });
      if (res.writableEnded) stop(); else leave = stop;
      return true;
    }
    if (path === '/api/stage' && req.method === 'PUT') {
      // In turn with every change made here, and keeping whatever one of those put down that this window has not heard of.
      const { before, next } = await store.putStage((await body(req)) as Stage);
      // The window's one feed follows the stage: a board card put down here is live before this answer goes back.
      events.restage(next);
      // A browser or source card that left the stage takes its Chrome session with it. No other card has one, and
      // closing a session nobody opened still starts a process to say so.
      for (const card of before.cards ?? []) {
        if ((card.kind === 'browser' || card.kind === 'source') && !next.cards?.some((kept) => kept.id === card.id)) void browser.close(browserSession(card.id));
      }
      if ((before.cards ?? []).length !== (next.cards ?? []).length) void attention.refresh();
      return answer(res, 200, { ok: true });
    }
    const asked = /^\/api\/approvals\/([\w.:-]{1,120})$/.exec(path)?.[1];
    if (asked && req.method === 'POST') {
      const said = await body(req);
      const known = approvals.answer(asked, { ok: said.ok === true, args: said.args && typeof said.args === 'object' ? said.args : undefined });
      return answer(res, known ? 200 : 404, known ? { ok: true } : { error: 'nothing is waiting under that id' });
    }
    return false;
  };
}
