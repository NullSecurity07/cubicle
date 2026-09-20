// How long a film takes to make, in one place, because two things have to agree about it: the card, which tells the
// founder the minutes before they press Make, and the studio, which says them again once it knows the shot list.
// A number the card made up on its own was the old way, and it said "about a minute" for a film that took ten.
//
// Everything here was measured on the founder's own machine rather than hoped for. A picture drawn away comes back
// in about four seconds. Drawn here it is most of a minute at full size, and a little over half that at draft size,
// because the words model and the decoder cost the same however small the picture is.
export const SECONDS_AWAY = 4;
export const SECONDS_HERE = 50;
export const SECONDS_HERE_DRAFT = 30;

// The founder's one choice about time. Full is every shot its own picture at full size. Draft is the film you look
// at to decide whether the film is right: a few pictures shared across the shots at different crops, drawn small,
// nothing moving drawn on this machine, and a quick encode.
export const SPEEDS = ['full', 'draft'] as const;
export type Speed = (typeof SPEEDS)[number];
export const isDraft = (speed: unknown): boolean => speed === 'draft';
// How many pictures a draft draws at the very most. Four is enough that a fifteen-second reel does not read as
// one photograph. Drawn on this computer it is three, because the fourth is the half minute that takes a draft
// from "about three minutes" to nearly four, and three minutes is what a draft is for.
export const DRAFT_PICTURES = 4;
export const DRAFT_PICTURES_HERE = 3;

export const secondsEach = (here: boolean, draft = false): number =>
  (here ? (draft ? SECONDS_HERE_DRAFT : SECONDS_HERE) : SECONDS_AWAY);

// How many pictures a film can wait for. Away from this machine, nearly all of them. Here, as many as fit in the
// minutes a founder will sit through; the rest share the picture nearest them at their own crop.
export function afforded(shots: number, here: boolean, minutes = 8, draft = false): number {
  const room = Math.floor((minutes * 60) / secondsEach(here, draft));
  return Math.max(2, Math.min(shots, draft ? Math.min(here ? DRAFT_PICTURES_HERE : DRAFT_PICTURES, room) : room));
}

// About how many shots a film of this length is cut into, for the card, which has to say the minutes before there
// is a storyboard to count. A reel changes picture a little more often than every two and a half seconds.
export const shotsIn = (seconds: number): number => Math.max(3, Math.round(seconds / 2.2));

export type Making = { seconds: number; pictures: number; clips: number; narrate: boolean; here?: boolean; draft?: boolean };

// The parts of the wait, in seconds. Pictures are drawn while the narration is being listened back to, so the
// listening costs nothing on top of a drawing that is longer than it — which, on this machine, it always is.
export function makingSeconds(ask: Making): { all: number; drawing: number; local: number } {
  // Drawn away, three at a time. Drawn here, one at a time.
  const drawing = ask.here ? ask.pictures * secondsEach(true, ask.draft) : Math.ceil(ask.pictures / 3) * 8;
  const recording = ask.narrate ? ask.seconds * 0.25 : 0;
  const listening = ask.narrate ? ask.seconds * 0.35 : 0;
  // Measured on a fourteen-second draft: twelve seconds checking the page, twenty-two encoding it, five on the
  // poster frame. The full encode is the older figure and has not been beaten yet.
  const rendering = ask.draft ? 20 + ask.seconds * 1.5 : 14 + ask.seconds * 4;
  const local = ask.clips * 180;
  // The storyboard is four or five questions put to a model and usually one correction: measured at fifty seconds
  // for a reel, and much the same whatever the film is.
  const thinking = 45;
  return { all: thinking + recording + Math.max(drawing, listening) + rendering + local, drawing, local };
}

export function makingWords(ask: Making): string {
  const { all, drawing } = makingSeconds(ask);
  const minutes = Math.max(1, Math.round(all / 60));
  const slow = [
    ask.clips ? `${ask.clips * 3} of that is the moving shot${ask.clips === 1 ? '' : 's'} this computer draws` : '',
    ask.here && ask.pictures && drawing >= 45 ? `${Math.max(1, Math.round(drawing / 60))} of it is the ${ask.pictures} picture${ask.pictures === 1 ? '' : 's'} this computer draws` : '',
  ].filter(Boolean);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}${slow.length ? ` — ${slow.join(', and ')}` : ''}`;
}
