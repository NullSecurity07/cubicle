// The one definition of what a moving-picture backend is, and the order the studio asks them in.
//
// Two of them exist. `local-clips.ts` makes b-roll on this machine with stable-diffusion.cpp and Wan2.1 — slow
// (minutes a clip) but unlimited and private. `spaces.ts` asks free Hugging Face Spaces — fast, but it spends a small
// daily quota and is the only one that can make a talking head. The studio takes whichever answers first and falls
// back in plain words when neither can.
export type ClipAsk = { prompt: string; image?: Buffer; seconds: number };
// `about` is what the portrait was drawn from, in words. A backend that cannot animate the picture itself can still
// draw somebody of that description moving, which is nearer what was asked for than the photograph held still.
export type PresenterAsk = { portrait: Buffer; speech: Buffer; about?: string };
export type Help = { report: (line: string) => void; signal?: AbortSignal };
export type Clip = { ext: 'mp4'; bytes: Buffer };
export type Clips = {
  // Why nothing can be made yet, in the founder's words, or nothing when the backend is ready.
  ready(): string | null;
  // A few seconds of b-roll from a description, optionally starting from a still we already drew.
  broll(ask: ClipAsk, help: Help): Promise<Clip>;
  // A face and a recording, made into the face saying it.
  presenter(ask: PresenterAsk, help: Help): Promise<Clip>;
};

// Stands in for a backend that is not there: it says what it needs, so every clip and presenter scene takes the
// graceful way out instead of the network.
export const noClips: Clips = {
  ready: () => 'AI clips are not set up on this machine yet.',
  broll: async () => { throw new Error('AI clips are not set up on this machine yet.'); },
  presenter: async () => { throw new Error('AI clips are not set up on this machine yet.'); },
};

// Several backends as one, tried in the order given: the first that is ready makes it, and a failure hands on to the
// next rather than ending the scene. `ready()` is nothing when any of them is ready, and otherwise the first hint —
// the one the founder is most likely to be able to act on.
// The same backends in two different orders, because b-roll and a person on camera want opposite things: b-roll is
// made here first because it is unlimited and nobody is waiting on a particular face, while a person is asked of the
// free Spaces first because they are the only ones that can make the founder's own picture speak.
export function orderedClips(order: { broll: Clips[]; presenter: Clips[] }): Clips {
  const both = [...new Set([...order.broll, ...order.presenter])];
  return {
    ready: () => (both.some((one) => !one.ready()) ? null : both.map((one) => one.ready()).find(Boolean) ?? null),
    broll: (ask, help) => firstClips(...order.broll).broll(ask, help),
    presenter: (ask, help) => firstClips(...order.presenter).presenter(ask, help),
  };
}

export function firstClips(...backends: Clips[]): Clips {
  const able = () => backends.filter((one) => !one.ready());
  const hint = () => backends.map((one) => one.ready()).find(Boolean) ?? null;
  const tryEach = async <T>(what: (one: Clips) => Promise<Clip>, help: Help): Promise<Clip> => {
    const ready = able();
    if (!ready.length) throw new Error(hint() ?? 'nothing can make moving pictures on this machine');
    const failures: string[] = [];
    for (const one of ready) {
      try { return await what(one); } catch (error) {
        if (help.signal?.aborted) throw error;
        failures.push((error as Error).message);
        if (ready.indexOf(one) < ready.length - 1) help.report(`that did not work (${(error as Error).message}); trying another way…`);
      }
    }
    throw new Error(failures.join('; '));
  };
  return {
    ready: () => (able().length ? null : hint()),
    broll: (ask, help) => tryEach((one) => one.broll(ask, help), help),
    presenter: (ask, help) => tryEach((one) => one.presenter(ask, help), help),
  };
}
