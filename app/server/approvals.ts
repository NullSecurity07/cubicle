import type { Attention } from '../shared/model.ts';

export type Answer = { ok: boolean; args?: Record<string, unknown> };
export type Approvals = ReturnType<typeof createApprovals>;

// Outward actions wait here for the founder. One open question per tool call; a stopped turn answers "no" for it.
// `about` is what was put to the founder, kept so whoever listens for the founder's own answers (the said-no log)
// knows what the yes or no was to. Only an answer marked as the founder's reaches them: a stopped turn, the safety
// net's timeout or a coder that went away also answer no, and none of those is the founder saying it.
export function createApprovals() {
  const open = new Map<string, { settle: (answer: Answer) => void; about?: Attention }>();
  const heard = new Set<(about: Attention, answer: Answer) => void>();
  return {
    ask(id: string, signal?: AbortSignal, about?: Attention): Promise<Answer> {
      return new Promise((settle) => {
        const done = (answer: Answer) => { open.delete(id); settle(answer); };
        open.set(id, { settle: done, ...(about ? { about } : {}) });
        signal?.addEventListener('abort', () => done({ ok: false }), { once: true });
      });
    },
    answer(id: string, answer: Answer, by?: 'founder') {
      const held = open.get(id);
      held?.settle(answer);
      if (held?.about && by === 'founder') for (const tell of heard) { try { tell(held.about, answer); } catch { /* a listener never stops an answer */ } }
      return !!held;
    },
    // The founder's own answers, each with what it was to. Hand back the result to stop listening.
    founderAnswers(tell: (about: Attention, answer: Answer) => void) { heard.add(tell); return () => { heard.delete(tell); }; },
  };
}

type Book = { raise(entry: Attention): Promise<void>; clear(id: string): Promise<void> };

// A question put to the founder, in "Needs you" and wherever else they are: the answer is listened for before the
// question is shown, because showing it means a write of the whole list, and an answer given while that write was
// still going reached nothing and came back "nothing is waiting". Resolves once the question is up, with the answer
// still to come; the question leaves "Needs you" when the answer arrives, whatever it is. The approval is kept under
// the id of the event the question is about.
export async function putToFounder(attention: Book, approvals: Pick<Approvals, 'ask' | 'answer'>, entry: Attention & { event: { id: string } }, signal?: AbortSignal): Promise<{ answer: Promise<Answer> }> {
  const answering = approvals.ask(entry.event.id, signal, entry);
  try {
    await attention.raise(entry);
  } catch (error) {
    // A question that could not be shown cannot be answered: nobody is left listening for it.
    approvals.answer(entry.event.id, { ok: false });
    throw error;
  }
  return { answer: answering.finally(() => attention.clear(entry.id)) };
}

// The same, waited out: what the founder said.
export async function askFounder(attention: Book, approvals: Pick<Approvals, 'ask' | 'answer'>, entry: Attention & { event: { id: string } }, signal?: AbortSignal): Promise<Answer> {
  return (await putToFounder(attention, approvals, entry, signal)).answer;
}
