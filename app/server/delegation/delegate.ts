import { newMessageId, type Stage } from '../../shared/model.ts';
import type { Handover } from '../../shared/delegation.ts';
import { runTurn } from '../loop.ts';
import { colleagueIds } from '../prompt.ts';
import type { ModelMessage } from '../prompt.ts';
import { complete, promptSize, type ModelClient } from '../providers.ts';
import { route } from '../router.ts';
import type { Seams } from '../seams.ts';
import type { Store } from '../store.ts';
import { text, type Tool } from '../tools/registry.ts';
import type { UsageBook } from '../usage.ts';
import { correction, HANDOVER_SHAPE, readHandover, spoken, told } from './handover.ts';

// Depth is one. A colleague doing somebody else's work hands it on to nobody, asks nobody, and keeps nothing: what
// they learned about this piece of work belongs to the person who asked for it, not to a memory of their own.
const DEPTH = new Set(['delegate_task', 'ask_person', 'remember', 'note_founder']);
// Nothing is watched by the clock: tokens and tool events are. A colleague thinking through a long search is alive;
// one that has said nothing for two minutes is stuck, and the founder is waiting on the other side of it.
const STALL = 120_000;

export type DelegateDeps = {
  store: Store; clients: ModelClient[]; usage: UsageBook; busy: Set<string>; seams?: Seams;
  promptFor: (stage: Stage, roomId: string, toolNames: string[], fresh?: boolean) => Promise<ModelMessage[]>;
  toolsFor: (stage: Stage, roomId: string) => Tool[];
  stallMs?: number;
};

export function delegationTools(deps: DelegateDeps): Tool[] {
  return [{
    name: 'delegate_task',
    perTurn: 2,
    description: 'Hand a whole piece of work to a colleague connected to your room, and get back what they did. '
      + 'They start with a clean sheet: their own documents, their own room and their own tools, and nothing of this conversation — so put everything they need into goal and context. '
      + 'They work on their own until it is finished and hand back a summary; they cannot pass it on again. '
      + 'Use this when the work is theirs and takes several steps; for one question, ask_person is far cheaper. '
      + 'Anything of theirs that reaches outside still waits for the founder, who is told you asked for it.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The colleague\'s name' },
        goal: { type: 'string', description: 'What they are to have done by the end, in their terms' },
        context: { type: 'string', description: 'Everything they need that they cannot see from their own room: the facts, the decisions already made, what good looks like' },
      },
      required: ['to', 'goal'],
    },
    async run(args, context) {
      const { stage, roomId } = context;
      const asker = stage.rooms.find((room) => room.id === roomId)!;
      const wanted = text(args, 'to', 80).trim().toLowerCase();
      const colleagues = colleagueIds(stage, roomId).map((id) => stage.rooms.find((room) => room.id === id)!);
      const target = colleagues.find((room) => room.name.trim().toLowerCase() === wanted);
      if (!target) throw new Error(`no colleague called "${args.to}" is connected to your room. Connected: ${colleagues.map((room) => room.name).join(', ') || 'nobody'}. The founder connects people by drawing a wire between them.`);
      // A busy colleague is a refusal, never a queue: the founder is waiting on this turn, not on the last one.
      if (deps.busy.has(target.id)) throw new Error(`${target.name} is in the middle of something else. Do this piece yourself, or ask again when they are free.`);

      const goal = text(args, 'goal', 4000);
      const extra = typeof args.context === 'string' ? args.context.slice(0, 8000).trim() : '';
      const asked = [goal, extra].filter(Boolean).join('\n\n');
      const brief = [
        `${asker.name} has handed you this piece of work. Do it now with your own tools. Nothing of their conversation is in front of you, so work from what is written here and what your own room holds.`,
        `Goal: ${goal}`, extra ? `What they told you:\n${extra}` : '', HANDOVER_SHAPE,
      ].filter(Boolean).join('\n\n');

      deps.busy.add(target.id);
      const stop = new AbortController();
      const passOn = () => stop.abort();
      let stalled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const alive = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { stalled = true; stop.abort(); }, deps.stallMs ?? STALL);
      };
      try {
        // Stopping the asker stops them: the founder pressed one Stop, and it means the whole of it.
        context.signal?.addEventListener('abort', passOn, { once: true });
        if (context.signal?.aborted) passOn();
        // The exchange lands in their room the way a consult does, so the founder can open it and read the whole thing.
        await deps.store.appendChat(target.id, { id: newMessageId(), role: 'user', text: asked, at: Date.now(), from: asker.name });
        context.report?.({ kind: 'chat-changed', id: target.id });

        const mine = deps.toolsFor(stage, target.id).filter((tool) => !DEPTH.has(tool.name));
        const messages = await deps.promptFor(stage, target.id, mine.map((tool) => tool.name), true);
        messages.push({ role: 'user', content: brief });
        const { order } = route(deps.clients, deps.usage, { pinned: target.model, promptChars: promptSize(messages), tools: true });
        alive();
        const reply = await runTurn({
          messages, tools: mine, clients: order, usage: deps.usage, signal: stop.signal, seams: deps.seams, source: 'run', query: goal,
          context: { stage, roomId: target.id, store: deps.store, granted: new Map() },
          events: {
            token: () => alive(),
            tool: (event) => { alive(); if (event.effect) context.report?.(event.effect); },
          },
          // Their outward step is still the founder's to allow, asked through the path the asker's own turn is on,
          // and the question says who wants it and who it is for.
          approve: context.approve && ((event, signal) => context.approve!({ ...event, question: `${target.name} is doing this for ${asker.name}. ${event.question || 'Allow this step?'}` }, signal)),
        });

        let hand: Handover | null = null;
        try { hand = readHandover(reply.text); } catch (error) {
          // One correction, the same one `completeJson` allows. A second failure is not worth another call: their
          // plain words are better than nothing, and they are handed over marked as what they are.
          if (!reply.stopped) {
            const fix = await complete([...messages, { role: 'assistant', content: reply.text }, { role: 'user', content: correction((error as Error).message) }], { onToken: () => alive(), signal: stop.signal }, order).catch(() => null);
            if (fix) {
              deps.usage.record(fix.client.name, fix.usage, fix.quota);
              try { hand = readHandover(fix.text); } catch { /* their own words go back instead */ }
            }
          }
        }

        const said = spoken(reply.text, hand);
        if (said || reply.tools.length) {
          await deps.store.appendChat(target.id, {
            id: newMessageId(), role: 'assistant', text: said, at: Date.now(), provider: reply.provider, model: reply.model,
            usage: reply.usage, ...(reply.tools.length ? { tools: reply.tools } : {}), ...(reply.stopped ? { stopped: true } : {}),
          });
        }
        const body = hand ? told(target.name, hand) : `${target.name} did not finish in the shape this asks for, so these are their own words, unsorted:\n${said || '(they said nothing)'}`;
        const cut = reply.stopped ? `${target.name} ${stalled ? 'went quiet and was stopped' : 'was stopped'}, so this is as far as it got.\n` : '';
        return { text: `${cut}${body}`, effect: { kind: 'chat-changed', id: target.id } };
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', passOn);
        deps.busy.delete(target.id);
      }
    },
  }];
}
