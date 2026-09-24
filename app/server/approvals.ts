import type { Attention } from '../shared/model.ts';

export type Answer = { ok: boolean; args?: Record<string, unknown> };
export type Approvals = ReturnType<typeof createApprovals>;

// Outward actions wait here for the founder. One open question per tool call; a stopped turn answers "no" for it.
export function createApprovals() {
  const open = new Map<string, (answer: Answer) => void>();
  return {
    ask(id: string, signal?: AbortSignal): Promise<Answer> {
      return new Promise((settle) => {
        const done = (answer: Answer) => { open.delete(id); settle(answer); };
        open.set(id, done);
        signal?.addEventListener('abort', () => done({ ok: false }), { once: true });
      });
    },
    answer(id: string, answer: Answer) {
      const settle = open.get(id);
      settle?.(answer);
      return !!settle;
    },
  };
}

type Book = { raise(entry: Attention): Promise<void>; clear(id: string): Promise<void> };

// A question put to the founder, in "Needs you" and wherever else they are: the answer is listened for before the
// question is shown, because showing it means a write of the whole list, and an answer given while that write was
// still going reached nothing and came back "nothing is waiting". Resolves once the question is up, with the answer
// still to come; the question leaves "Needs you" when the answer arrives, whatever it is. The approval is kept under
// the id of the event the question is about.
export async function putToFounder(attention: Book, approvals: Approvals, entry: Attention & { event: { id: string } }, signal?: AbortSignal): Promise<{ answer: Promise<Answer> }> {
  const answering = approvals.ask(entry.event.id, signal);
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
export async function askFounder(attention: Book, approvals: Approvals, entry: Attention & { event: { id: string } }, signal?: AbortSignal): Promise<Answer> {
  return (await putToFounder(attention, approvals, entry, signal)).answer;
}
