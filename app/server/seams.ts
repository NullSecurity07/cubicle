import type { ToolEvent } from '../shared/model.ts';
import type { TurnResult } from './loop.ts';
import type { ModelMessage } from './prompt.ts';

export type Source = 'chat' | 'run';
// The six places a turn can be opened up. Everything this program adds later — a prompt block, compaction, a safety
// check, the trace — plugs in here instead of becoming another `if` in `loop.ts`.
// `step:error` is the one that can answer back: a handler that shortened the prompt sets `retry`, and the step is
// asked once more with what it left. Nobody setting it means the failure stands.
export type Payloads = {
  'turn:before': { roomId: string; source: Source; query: string; messages: ModelMessage[] };
  'step:before': { roomId: string; step: number; messages: ModelMessage[] };
  'step:error': { roomId: string; step: number; messages: ModelMessage[]; error: string; retry?: boolean };
  // `approved`: the founder already said yes to calls that reach exactly this far, so this one is not put to them
  // again. It never overrules a refusal — a no, wherever it comes from, ends the step.
  'tool:before': { roomId: string; call: { id: string; name: string; args: Record<string, unknown> }; refusal?: string; approved?: true };
  'tool:after': { roomId: string; event: ToolEvent };
  'turn:after': { roomId: string; source: Source; query: string; reply: TurnResult };
};
export type SeamName = keyof Payloads;
// A handler rewrites what it was given and passes it on with `next`. Not calling `next` stops the chain there.
export type Handler<Name extends SeamName> = (payload: Payloads[Name], next: (payload: Payloads[Name]) => Promise<Payloads[Name]>) => Promise<Payloads[Name]>;
export type Seams = ReturnType<typeof createSeams>;

export const SAFETY_FAILED = 'A safety check failed, so this step did not run.';

// One small bus. Handlers run in the order they were added, each free to rewrite the payload for the next one.
// A handler that throws is skipped and the rest still run, because a broken extra must never cost the founder a turn;
// the one exception is `tool:before`, where a throw refuses the call, since a safety check that cannot answer is a no.
// `run` never rejects, which is what lets `turn:after` be fired and forgotten.
export function createSeams(onError: (name: SeamName, error: Error) => void = () => {}) {
  // Each seam's own payload type is kept at the edges, where it is worth having; in here they are only a list.
  const handlers = new Map<SeamName, unknown[]>();

  return {
    on<Name extends SeamName>(name: Name, handler: Handler<Name>) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => { handlers.set(name, (handlers.get(name) ?? []).filter((one) => one !== handler)); };
    },
    async run<Name extends SeamName>(name: Name, payload: Payloads[Name]): Promise<Payloads[Name]> {
      const chain = (handlers.get(name) ?? []) as Handler<Name>[];
      const step = async (index: number, current: Payloads[Name]): Promise<Payloads[Name]> => {
        const handler = chain[index];
        if (!handler) return current;
        // What the rest of the chain made of it, kept in case this handler throws after passing it on.
        let passed: Payloads[Name] | undefined;
        try {
          return await handler(current, async (next) => (passed = await step(index + 1, next)));
        } catch (error) {
          onError(name, error as Error);
          if (name !== 'tool:before') return passed ?? step(index + 1, current);
          const refused = (passed ?? current) as Payloads['tool:before'];
          return { ...refused, refusal: refused.refusal || SAFETY_FAILED } as Payloads[Name];
        }
      };
      return step(0, payload);
    },
  };
}

// A few more words at the end of the system prompt, the way the library, the leads and the coding hint add theirs.
// A payload whose first message is not the system prompt is handed back as it came.
export function withSystem<P extends { messages: ModelMessage[] }>(payload: P, extra: string): P {
  const [system, ...rest] = payload.messages;
  if (system?.role !== 'system' || !extra) return payload;
  return { ...payload, messages: [{ ...system, content: `${system.content}\n\n${extra}` }, ...rest] };
}
