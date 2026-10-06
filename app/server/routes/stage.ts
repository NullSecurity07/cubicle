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
    // The revision goes in the ETag header, never the body, so a stage read by a script is plain data it can put back
    // as it is. A stage saved before revisions were counted is at 0.
    if (path === '/api/stage' && req.method === 'GET') {
      const { rev, ...stage } = await store.loadStage();
      res.setHeader('etag', `"${rev ?? 0}"`);
      return answer(res, 200, stage);
    }
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
      // A window that saves over a stage it has not seen is told so, with the stage as it is now, and saves again.
      // The store tells the events feed about every stage it saves, so every other window hears of this one.
      // Only a window sends If-Match, with the revision it last saw; a save without one is taken whole, as ever.
      const match = /^"?(\d+)"?$/.exec(String(req.headers['if-match'] ?? '').trim());
      const { before, next, stale } = await store.putStage((await body(req)) as Stage, match ? Number(match[1]) : undefined);
      if (stale) { const { rev, ...stage } = before; return answer(res, 409, { error: 'the stage changed in another window', stage, rev: rev ?? 0 }); }
      // A browser or source card that left the stage takes its Chrome session with it. No other card has one, and
      // closing a session nobody opened still starts a process to say so.
      for (const card of before.cards ?? []) {
        if ((card.kind === 'browser' || card.kind === 'source') && !next.cards?.some((kept) => kept.id === card.id)) void browser.close(browserSession(card.id));
      }
      if ((before.cards ?? []).length !== (next.cards ?? []).length) void attention.refresh();
      return answer(res, 200, { ok: true, rev: next.rev });
    }
    const asked = /^\/api\/approvals\/([\w.:-]{1,120})$/.exec(path)?.[1];
    if (asked && req.method === 'POST') {
      const said = await body(req);
      const known = approvals.answer(asked, { ok: said.ok === true, args: said.args && typeof said.args === 'object' ? said.args : undefined }, 'founder');
      return answer(res, known ? 200 : 404, known ? { ok: true } : { error: 'nothing is waiting under that id' });
    }
    return false;
  };
}
