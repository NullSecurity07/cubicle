import type { Stage } from '../../shared/model.ts';
import type { Deps, Installed, Slice } from '../install.ts';
import { chatNo, promptLine, proposalOf, saidNoFor, standingNosIn, suggestionIn, type Proposal } from '../partner/saidno.ts';
import { withSystem, type Handler } from '../seams.ts';
import { leadAddresses } from '../tools/outward.ts';

// The founder's "no", heard wherever it is said and held against every proposal after it (server/partner/saidno.ts).
// Here: the founder's answers to approvals and coder questions, a chat reply that opens with "no" to a proposal, the
// list in every person's prompt, and the check on each proposing call before it reaches the founder. The Needs you
// answers (a bet, a plan, a decision declined, a drafted email dismissed) are written where they are answered.

// The calls that put something in front of the founder without an approval of their own, besides every call that
// asks for a yes: a chat "no" right after one of these is a no to it.
export const PROPOSING = new Set(['propose_bet', 'propose_decision', 'propose_tasks', 'propose_task', 'propose_source', 'propose_target', 'draft_email', 'send_email']);

const reasonOf = (args: Record<string, unknown> | undefined) => {
  for (const key of ['reason', 'message', 'answer']) if (typeof args?.[key] === 'string' && (args[key] as string).trim()) return (args[key] as string).trim();
  return undefined;
};

export default {
  name: 'saidno',
  install(deps: Deps): Installed {
    const book = saidNoFor(deps.workspace);
    const leads = (stage: Stage) => leadAddresses(deps.workspace)(stage).catch(() => [] as string[]);
    const proposalNow = async (name: string, args: Record<string, unknown>): Promise<Proposal | null> =>
      proposalOf(name, args, name === 'draft_email' || name === 'send_email' ? await leads(await deps.store.loadStage()) : []);

    // Don't on an approval, Reject on a coder's question: kept with the reason when one was given. A yes to something
    // said no to before means the no no longer stands.
    const offAnswers = deps.approvals.founderAnswers((about, answer) => {
      const event = about.event;
      if (!event) return;
      void (async () => {
        const proposal = await proposalNow(event.name, event.args ?? {});
        if (!proposal) return;
        if (answer.ok) await book.forget(proposal);
        else await book.record({ ...proposal, ...(about.who ? { who: about.who } : {}), ...(reasonOf(answer.args) ? { reason: reasonOf(answer.args) } : {}) });
      })().catch((error: Error) => console.error(`said no: ${error.message}`));
    });

    // A proposal held to what the founder already turned down, in code: put to them once more with the no quoted,
    // then not raised at all, and the person told why.
    const beforeTool: Handler<'tool:before'> = async (payload, next) => {
      if (payload.refusal || payload.call.name === 'ask_founder') return next(payload);
      const proposal = await proposalNow(payload.call.name, payload.call.args).catch(() => null);
      if (!proposal) return next(payload);
      const checked = await book.check(proposal).catch(() => ({ verdict: 'fresh' as const }));
      if (checked.verdict === 'declined') return next({ ...payload, refusal: checked.line });
      if (checked.verdict === 'reask') {
        await book.asked(checked.entry.id).catch(() => {});
        return next({ ...payload, ask: checked.line });
      }
      return next(payload);
    };

    const beforeTurn: Handler<'turn:before'> = async (payload, next) => {
      let out = payload;
      try {
        const stage = await deps.store.loadStage();
        const room = stage.rooms.find((one) => one.id === payload.roomId);
        if (!room) return next(out);
        // "No, too early" right after a proposal is a no to it, with its reason.
        const said = payload.source === 'chat' ? chatNo(payload.query) : null;
        if (said) {
          const chat = await deps.store.readChat(room.id).catch(() => []);
          let at = chat.length - 1;
          while (at >= 0 && chat[at].role === 'user') at -= 1;
          const last = at >= 0 ? chat[at] : undefined;
          const proposed: Proposal[] = [];
          for (const tool of last?.tools ?? []) {
            if (!PROPOSING.has(tool.name) || tool.ok === false) continue;
            const one = await proposalNow(tool.name, tool.args ?? {});
            if (one) proposed.push(one);
          }
          const words = last && !proposed.length ? suggestionIn(last.text) : '';
          if (words) proposed.push({ tool: 'chat', subject: words });
          for (const one of proposed) await book.record({ ...one, who: room.name, ...said });
          // Nothing proposed to say no to, and a reason given: it is why the Don't just pressed was pressed.
          if (!proposed.length && said.reason) await book.explain(said.reason);
        }
        // "Don't propose cold outreach to more makers", said anywhere in a message, stands with its reason; the
        // unasked refresh and the morning note are held to it (journey 15).
        if (payload.source === 'chat') for (const one of standingNosIn(payload.query)) await book.record({ tool: 'chat', ...one, who: room.name });
        // The partner has the same list in their standing facts.
        if (!room.partner) {
          const line = promptLine(await book.list());
          if (line) out = withSystem(out, line);
        }
      } catch (error) { console.error(`said no: ${(error as Error).message}`); }
      return next(out);
    };

    const offTool = deps.seams.on('tool:before', beforeTool);
    const offTurn = deps.seams.on('turn:before', beforeTurn);
    return { async close() { offAnswers(); offTool(); offTurn(); } };
  },
} satisfies Slice;
