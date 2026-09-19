// The shape of the moving-picture backend the video studio asks for b-roll and a talking head, written down here so
// this half of the studio can be built, tested and reviewed against it before the backend itself lands.
//
// `media/spaces.ts` is the real implementation and is owned elsewhere; it exports `createClips`, `fakeClips` and a
// `Clips` type identical to this one. Nothing in this file imports it: the studio takes a `Clips` and never asks
// where it came from, so the two meet at one injection point in `server/index.ts` and nowhere else.
//
// These calls spend a small free daily quota on somebody else's machine, which is why the studio bounds them hard:
// at most two such scenes in a film, only when the card's switch is on, and the founder says yes when a person asks.
export type Clips = {
  // Why nothing can be made yet, in the founder's words, or nothing when the backend is ready.
  ready(): string | null;
  // A few seconds of b-roll from a description, optionally starting from a still we already drew.
  broll(ask: { prompt: string; image?: Buffer; seconds: number }, help: { report: (line: string) => void; signal?: AbortSignal }): Promise<{ ext: 'mp4'; bytes: Buffer }>;
  // A face and a recording, made into the face saying it.
  presenter(ask: { portrait: Buffer; speech: Buffer }, help: { report: (line: string) => void; signal?: AbortSignal }): Promise<{ ext: 'mp4'; bytes: Buffer }>;
};

// Stands in for the backend until it is wired up, and in every test and fake-model run: it says what it needs, so
// every clip and presenter scene takes the graceful way out instead of the network.
export const noClips: Clips = {
  ready: () => 'AI clips are not set up on this machine yet.',
  broll: async () => { throw new Error('AI clips are not set up on this machine yet.'); },
  presenter: async () => { throw new Error('AI clips are not set up on this machine yet.'); },
};
