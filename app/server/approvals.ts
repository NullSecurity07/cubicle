export type Answer = { ok: boolean; args?: Record<string, unknown> };

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
