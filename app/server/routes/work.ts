import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AttentionBook } from '../attention.ts';
import type { createBoards } from '../boards.ts';
import type { createDecisions } from '../decisions.ts';
import type { createFounder } from '../founder.ts';
import { answer, body, openFeed, type Route } from '../http.ts';
import { missionsOf } from '../missions.ts';
import { overlap, proposalOf, SAID_NO_OVERLAP, saidNoFor } from '../partner/saidno.ts';
import type { Recall } from '../playbook.ts';
import type { Turn } from '../reflect.ts';
import type { RoomFeed } from '../rooms-feed.ts';
import type { createSources } from '../sources.ts';
import type { Skills } from '../skills.ts';
import { allChats, type Store } from '../store.ts';
import { threadsOf } from '../threads.ts';
import { leadAddresses } from '../tools/outward.ts';
import type { createTrace } from '../trace.ts';

// "Learn this": the founder asking for the reflection a turn can also set off by itself, on work already finished.
export type Learn = (turn: Turn) => Promise<{ learned: { name: string; action: string } | null }>;

// What the founder works from rather than on: the first steps, search, the trace, decisions, the playbook, the page
// about them, the conversations as threads, and everything waiting for them.
export function workRoutes(deps: {
  store: Store; workspace: string; busy: Set<string>; learn: Learn; roomFeed: RoomFeed;
  boards: ReturnType<typeof createBoards>; decisions: ReturnType<typeof createDecisions>; recall: Recall; trace: ReturnType<typeof createTrace>;
  skills: Skills; founder: ReturnType<typeof createFounder>; attention: AttentionBook; sources: ReturnType<typeof createSources>;
}): Route {
  const { store, workspace, busy, learn, roomFeed, boards, decisions, recall, trace, skills, founder, attention, sources } = deps;
  return async (req, res, path, url) => {
    if (path === '/api/missions' && req.method === 'GET') {
      const stage = await store.loadStage();
      const [chats, docs] = [await allChats(store, stage), {} as Record<string, string>];
      for (const one of stage.docs) docs[one.id] = await store.readDoc(one.id).catch(() => '');
      const tasks = (await Promise.all((stage.cards ?? []).filter((card) => card.kind === 'board').map((card) => boards.list(card.id)))).flat();
      const dismissed = await readFile(resolve(workspace, 'missions.json'), 'utf8').then((text) => JSON.parse(text).dismissed === true, () => false);
      return answer(res, 200, { dismissed, missions: missionsOf({ stage, chats, docs, decisions: await decisions.list(), tasks }) });
    }
    if (path === '/api/missions/dismiss' && req.method === 'POST') { await writeFile(resolve(workspace, 'missions.json'), JSON.stringify({ dismissed: true })); return answer(res, 200, { ok: true }); }
    if (path === '/api/search' && req.method === 'GET') {
      const hits = await recall.search(url.searchParams.get('q') ?? '', { top: 12 });
      return answer(res, 200, { hits, mode: recall.mode() });
    }
    // What the people have spent and done lately. No screen reads it yet; the file behind it is the founder's to keep.
    if (path === '/api/trace' && req.method === 'GET') return answer(res, 200, await trace.summary(Number(url.searchParams.get('days')) || 7));
    if (path === '/api/decisions' && req.method === 'GET') return answer(res, 200, await decisions.list());
    if (path === '/api/decisions' && req.method === 'POST') return answer(res, 200, await decisions.record(await body(req)));
    const ruled = /^\/api\/decisions\/([a-z0-9-]{1,100})(?:\/(decide))?$/.exec(path);
    // A proposed decision declined, or decided against what its proposer would pick, is a no kept in the said-no log.
    if (ruled && ruled[2] === 'decide' && req.method === 'POST') {
      const made = await decisions.decide(ruled[1], await body(req));
      if (made.recommendation && made.chosen && overlap(made.chosen, made.recommendation) < SAID_NO_OVERLAP) {
        await saidNoFor(workspace).record({ tool: 'propose_decision', subject: `${made.title}: ${made.recommendation}`, options: made.options, pick: made.recommendation, ...(made.proposedBy ? { who: made.proposedBy } : {}), ...(made.why ? { reason: made.why } : {}) }).catch(() => {});
      }
      return answer(res, 200, made);
    }
    if (ruled && !ruled[2] && req.method === 'DELETE') {
      const held = (await decisions.list()).find((one) => one.id === ruled[1]);
      // Journey 17: Decline with a Why kept the no with no reason, and the re-ask had nothing to quote.
      const said = (await body(req).catch(() => ({}))) as { why?: unknown };
      const why = typeof said.why === 'string' && said.why.trim() ? said.why.trim() : '';
      await decisions.remove(ruled[1]);
      if (held?.status === 'proposed') await saidNoFor(workspace).record({ tool: 'propose_decision', subject: held.title, options: held.options, ...(held.recommendation ? { pick: held.recommendation } : {}), ...(held.proposedBy ? { who: held.proposedBy } : {}), ...(why ? { reason: why } : {}) }).catch(() => {});
      return answer(res, 200, { ok: true });
    }
    // The playbook. Everything in it was written without asking, so everything in it can be edited, switched off,
    // put back or thrown away by the founder, and the panel hears about every change on one feed.
    if (path === '/api/skills' && req.method === 'GET') return answer(res, 200, await skills.list());
    if (path === '/api/skills/events' && req.method === 'GET') {
      openFeed(res);
      const tell = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      tell({ skills: await skills.list() });
      res.on('close', skills.watch(tell));
      return true;
    }
    const taught = /^\/api\/skills\/([a-z0-9-]{1,80})$/.exec(path)?.[1];
    if (taught && req.method === 'PATCH') {
      const asked = await body(req);
      let skill = await skills.get(taught);
      if (!skill) return answer(res, 404, { error: 'unknown skill' });
      if (asked.undo === true) skill = await skills.undo(taught);
      else if (['name', 'when', 'procedure', 'pitfalls', 'verify'].some((field) => asked[field] !== undefined)) skill = await skills.edit(taught, asked);
      if (typeof asked.state === 'string') skill = await skills.setState(taught, asked.state);
      return answer(res, 200, skill);
    }
    if (taught && req.method === 'DELETE') { await skills.remove(taught); return answer(res, 200, { ok: true }); }
    if (path === '/api/founder' && req.method === 'GET') return answer(res, 200, { text: await founder.read() });
    if (path === '/api/founder' && req.method === 'PUT') { await founder.write(String((await body(req)).text ?? '')); return answer(res, 200, { ok: true }); }
    const learns = /^\/api\/rooms\/([^/]+)\/learn$/.exec(path)?.[1];
    if (learns && req.method === 'POST') {
      // A failed turn is nothing to learn from: the last real answer and its question are.
      const talk = (await store.readChat(learns)).filter((one) => !one.failed);
      const at = talk.findLastIndex((one) => one.role === 'assistant');
      const asked = at > 0 ? talk.slice(0, at).findLast((one) => one.role === 'user') : undefined;
      if (at < 0 || !asked) return answer(res, 400, { error: 'there is nothing finished here to learn from yet' });
      const said = talk[at];
      return answer(res, 200, await learn({ roomId: learns, source: 'chat', query: asked.text, reply: { text: said.text, tools: said.tools ?? [], provider: said.provider ?? '', model: said.model ?? '', usage: said.usage ?? { input: 0, output: 0 }, stopped: false } }));
    }
    if (path === '/api/threads' && req.method === 'GET') {
      const stage = await store.loadStage();
      return answer(res, 200, threadsOf(stage, await allChats(store, stage), busy, url.searchParams.get('q') ?? ''));
    }
    // One feed for every conversation on the stage, the way the studios have one: a card only draws what happened in
    // its own room, and a turn started anywhere reaches all of them.
    if (path === '/api/rooms/events' && req.method === 'GET') {
      openFeed(res);
      // Nothing is sent on opening, and a browser is told a feed is open only once something comes down it. A comment
      // costs one line and means a card knows it is listening before the founder's first word arrives, not after.
      res.write(': listening\n\n');
      res.on('close', roomFeed.watch((event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); }));
      return true;
    }
    if (path === '/api/attention' && req.method === 'GET') return answer(res, 200, await attention.list());
    if (path === '/api/attention/events' && req.method === 'GET') {
      openFeed(res);
      const tell = (list: unknown) => res.write(`data: ${JSON.stringify(list)}\n\n`);
      tell(await attention.list());
      res.on('close', attention.watch(tell));
      return true;
    }
    // Every id on this list has a colon in it (`approval:call-1`, `run-failed:t2:5`), and a colon travels here as
    // `%3A`. Without the `%` and the decoding, Dismiss reached nothing at all and the founder pressed it for nothing.
    const dismissed = /^\/api\/attention\/([\w.:%-]{1,160})\/dismiss$/.exec(path)?.[1];
    if (dismissed && req.method === 'POST') {
      const id = decodeURIComponent(dismissed);
      const held = (await attention.list()).find((one) => one.id === id);
      // Opening a drafted email in Gmail takes it off the list too, and that is the founder acting on it, not a no:
      // journey 15 found the Gmail chip logged as "You said no", and every later email to that lead refused.
      const sent = await body(req).catch(() => ({})) as { opened?: unknown; to?: unknown; subject?: unknown };
      const opened = sent.opened === true;
      await attention.dismiss(id);
      // Journey 19: the room's button named the draft by the words the person wrote, Needs you by the words that went
      // to Gmail (the name filled in), so the row stayed four days. Opened from anywhere, the same email's row goes.
      if (opened && typeof sent.to === 'string') {
        const same = (address: string) => address.split(/[,;\s]+/).filter(Boolean).map((one) => one.toLowerCase()).sort().join(',');
        for (const one of await attention.list()) {
          const to = /^Email to (.+) ready to send$/.exec(one.title)?.[1];
          if (one.kind !== 'mail-draft' || one.id === id || !to || same(to) !== same(sent.to)) continue;
          if (typeof sent.subject === 'string' && (one.detail ?? '').split('\n')[0] !== sent.subject) continue;
          await attention.dismiss(one.id);
        }
      }
      // A drafted email waved away with Dismiss is a no to it, kept so the same email is not drafted again.
      if (held?.kind === 'mail-draft' && !opened) {
        const to = /^Email to (.+) ready to send$/.exec(held.title)?.[1] ?? '';
        const stage = await store.loadStage();
        const proposal = proposalOf('draft_email', { to, subject: held.detail ?? '' }, await leadAddresses(workspace)(stage).catch(() => []));
        if (proposal) await saidNoFor(workspace).record({ ...proposal, ...(held.who ? { who: held.who } : {}) }).catch(() => {});
      }
      return answer(res, 200, { ok: true });
    }
    const droppedSource = /^\/api\/sources\/([a-z0-9-]{1,100})\/drop$/.exec(path)?.[1];
    if (droppedSource && req.method === 'POST') { await sources.drop(droppedSource); return answer(res, 200, { ok: true }); }
    return false;
  };
}
