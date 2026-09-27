import type { ServerResponse } from 'node:http';
import { newMessageId, newTurnId, type Attachment, type ChatEvent, type ChatVia, type Stage, type ToolEvent } from '../shared/model.ts';
import { askFounder, type Approvals } from './approvals.ts';
import type { AttentionBook } from './attention.ts';
import { json } from './http.ts';
import { holdPartner, PRECONDITION_NUDGE } from './partner/pushback.ts';
import { partnerRoute } from './partner/route.ts';
import { runTurn } from './loop.ts';
import type { createMemory } from './memory.ts';
import type { Offered } from './playbook.ts';
import { complete, promptSize, type ModelClient } from './providers.ts';
import type { RoomFeed } from './rooms-feed.ts';
import { route } from './router.ts';
import type { ModelMessage } from './prompt.ts';
import type { Payloads, Seams } from './seams.ts';
import type { Store } from './store.ts';
import type { Consult } from './tools/team.ts';
import type { Tool } from './tools/registry.ts';
import { ANSWER_IN_WORDS, HELD_BACK, proseToolCall } from './truth.ts';
import type { PromptFor } from './turn-prompt.ts';
import type { UsageBook } from './usage.ts';

type Deps = {
  store: Store; roomFeed: RoomFeed; busy: Set<string>; clients: ModelClient[]; usage: UsageBook; seams: Seams;
  attention: AttentionBook; approvals: Approvals; memory: Pick<ReturnType<typeof createMemory>, 'fold'>;
  promptFor: PromptFor;
  // Asked only when a turn starts: the tool list is final only once every slice is installed.
  toolsFor: (stage: Stage, roomId: string) => Tool[];
};

// The founder talking to one person, and one person asking another.
export function createChat(deps: Deps) {
  const { store, roomFeed, busy, clients, usage, seams, attention, approvals, memory, promptFor } = deps;

  // A consult: the question lands in the colleague's room under the asker's name, they answer once without tools, and both are kept there.
  const consult: Consult = async ({ fromRoomId, toRoomId, question, signal }) => {
    const stage = await store.loadStage();
    const asker = stage.rooms.find((room) => room.id === fromRoomId)!;
    const target = stage.rooms.find((room) => room.id === toRoomId)!;
    await store.appendChat(toRoomId, { id: newMessageId(), role: 'user', text: question, at: Date.now(), from: asker.name });
    let messages = await promptFor(stage, toRoomId, []);
    // The colleague is shown what they would be shown in a turn of their own: their playbook, their notes, their
    // cards. Offered nothing, so every procedure that needs a tool is left out, and they still answer in words only.
    // Not while they are in a turn of their own, whose guards and questions to the founder this must not disturb; and
    // as a run, because being asked by a colleague is not the founder answering whatever this person asked them.
    if (!busy.has(toRoomId)) {
      const before: Payloads['turn:before'] & Offered = { roomId: toRoomId, source: 'run', query: question, messages, offered: [] };
      messages = (await seams.run('turn:before', before)).messages;
    }
    const { order } = target.partner && !target.model ? partnerRoute(clients, usage, { promptChars: promptSize(messages), tools: false })
      : route(clients, usage, { pinned: target.model, promptChars: promptSize(messages), tools: false });
    // The same road a turn takes: a key that is resting is passed over, and a key that fails is rested.
    const ask = (these: ModelMessage[]) => complete(these, { onToken: () => {}, signal }, order, ({ client, error }) => usage.failed(client.name, error), (client) => usage.admit(client.name));
    let reply = await ask(messages);
    usage.record(reply.client.name, reply.usage, reply.quota);
    // A tool call written as text would land in the asker's reasoning as if it were the answer: asked once more, then held back.
    if (proseToolCall(reply.text)) {
      reply = await ask([...messages, { role: 'assistant', content: reply.text }, { role: 'user', content: ANSWER_IN_WORDS }]);
      usage.record(reply.client.name, reply.usage, reply.quota);
      if (proseToolCall(reply.text)) reply = { ...reply, text: HELD_BACK };
    }
    await store.appendChat(toRoomId, { id: newMessageId(), role: 'assistant', text: reply.text, at: Date.now(), provider: reply.client.name, model: reply.client.model, usage: reply.usage });
    return reply.text;
  };

  async function chat(roomId: string, text: string, res: ServerResponse, extra: { replace?: string; attachments?: Attachment[]; via?: ChatVia } = {}) {
    const stage = await store.loadStage();
    if (!stage.rooms.some((room) => room.id === roomId)) return json(res, 404, { error: 'unknown room' });
    if (busy.has(roomId)) return json(res, 409, { error: 'this person is still replying' });
    busy.add(roomId);

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (event: ChatEvent) => !res.writableEnded && res.write(`data: ${JSON.stringify(event)}\n\n`);
    // One name for this turn, said on both roads out of here: whoever asked hears it on their own stream, every other
    // window hears it on the feed, and so nobody draws the same reply twice.
    const turn = newTurnId();
    send({ turn });
    // The founder pressing Stop closes the request; the turn ends there and what was said is kept.
    const stop = new AbortController();
    res.on('close', () => stop.abort());
    try {
      // Regenerate and edit: the old message and everything after it leave the conversation (to trash) before the new one goes in.
      if (extra.replace) await store.cutChat(roomId, extra.replace, true);
      await store.appendChat(roomId, { id: newMessageId(), role: 'user', text, at: Date.now(), ...(extra.via ? { via: extra.via } : {}), ...(extra.attachments?.length ? { attachments: extra.attachments } : {}) });
      roomFeed.tell({ roomId, turn, started: { ...(extra.via ? { via: extra.via } : {}) } });
      // The names in the prompt are the narrowed list too: a person is never told about a tool they are not offered.
      const mine = deps.toolsFor(stage, roomId);
      const messages = await promptFor(stage, roomId, mine.map((tool) => tool.name));
      const room = stage.rooms.find((candidate) => candidate.id === roomId)!;
      const vision = messages.some((message) => message.role === 'user' && !!message.images?.length);
      // The partner answers on the strongest free models unless the founder pinned one for them.
      const { order, notice } = room.partner && !room.model ? partnerRoute(clients, usage, { promptChars: promptSize(messages), tools: true, vision })
        : route(clients, usage, { pinned: room.model, promptChars: promptSize(messages), tools: true, vision });
      if (vision && !order[0]?.vision) send({ notice: 'No model that can see images is set up (Gemini can), so the picture is described to the model only by its file name.' });
      if (notice) send({ notice });
      // The reply is kept as it stands after every step a tool finishes, marked stopped, and the finished reply is
      // written over it under the same id: a restart mid-turn keeps what was said and done, not nothing.
      const replyId = newMessageId();
      const kept = { text: '', tools: [] as ToolEvent[], writes: Promise.resolve() };
      const keepSoFar = (tool: ToolEvent) => {
        if (tool.ok === undefined) return;
        kept.tools = [...kept.tools.filter((one) => one.id !== tool.id), tool];
        const draft = { id: replyId, role: 'assistant' as const, text: kept.text, at: Date.now(), tools: kept.tools, stopped: true };
        kept.writes = kept.writes.then(() => store.putMessage(roomId, draft)).catch(() => {});
      };
      const turnOn = (these: typeof messages, offered = mine) => runTurn({
        messages: these, tools: offered, clients: order, usage, signal: stop.signal, seams, source: 'chat', query: text,
        // Listened for before it is shown, so an answer given while Needs you is still being written is heard.
        approve: (event, signal) => askFounder(attention, approvals, { id: `approval:${event.id}`, kind: 'approval', title: event.question ?? event.name.replace(/_/g, ' '), at: Date.now(), roomId, who: room.name, event }, signal),
        context: { stage, roomId, store, granted: new Map() },
        // Both roads at once: the window that asked, and every window that is only watching.
        events: {
          token: (token) => { kept.text += token; send({ token }); roomFeed.tell({ roomId, turn, token }); },
          tool: (tool) => { keepSoFar(tool); send({ tool }); roomFeed.tell({ roomId, turn, tool }); },
          notice: (text) => send({ notice: text }),
          // A model broke off part way and the next one answers from the start: every window empties the bubble.
          restart: () => { kept.text = ''; send({ restart: true }); roomFeed.tell({ roomId, turn, restart: true }); },
        },
      });
      let reply = await turnOn(messages);
      // The partner is held to the precondition check on a raise, hire, spend or pivot plan, and says "My call" once.
      if (room.partner) {
        reply = await holdPartner(text, reply, (first) => {
          // Said first, then the bubble emptied, so no window shows the new answer running on from the old one.
          send({ notice: `${room.name} is taking another look: checking the preconditions.` });
          send({ restart: true });
          roomFeed.tell({ roomId, turn, restart: true });
          kept.text = '';
          // Words only this time, with the first answer and the nudge in front of it: nothing it did is done again.
          return turnOn([...messages, { role: 'assistant', content: first.text }, { role: 'user', content: PRECONDITION_NUDGE }], [])
            .catch((error: Error) => {
              // No model could take the second look: the first answer stands, back in every window, and is labelled
              // as unchecked below. Its tools and usage are already counted once.
              if (stop.signal.aborted) throw error;
              send({ notice: `${room.name} could not take another look (${error.message.slice(0, 160)}), so the first answer stands.` });
              send({ restart: true });
              roomFeed.tell({ roomId, turn, restart: true });
              kept.text = first.text;
              send({ token: first.text });
              roomFeed.tell({ roomId, turn, token: first.text });
              return { ...first, tools: [], usage: { input: 0, output: 0 } };
            });
        });
      }
      const message = {
        id: replyId, role: 'assistant' as const, text: reply.text, at: Date.now(), provider: reply.provider, model: reply.model,
        usage: reply.usage, ...(reply.tools.length ? { tools: reply.tools } : {}), ...(reply.stopped ? { stopped: true } : {}),
      };
      await kept.writes;
      if (reply.text.trim() || reply.tools.length || kept.tools.length) await store.putMessage(roomId, message);
      send({ done: true, message });
      // Older talk folds into the person's memory after the reply, never in the founder's way.
      void memory.fold(roomId).catch(() => {});
    } catch (error) {
      send({ error: (error as Error).message });
    } finally {
      busy.delete(roomId);
      roomFeed.tell({ roomId, turn, ended: true });
      res.end();
    }
  }

  return { chat, consult };
}
