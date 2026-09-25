// A customer interview, recorded and written down on this machine. The card carries who it was with and when; the
// recordings, the transcript and who was asked for the insights live in a sidecar the server owns,
// `<workspace>/interviews/<cardId>.json`, with the sound itself beside it in `<workspace>/interviews/<cardId>/`.

// One recording of the call. `seconds` is measured from the sound, never from a clock the page kept.
export type InterviewRecording = { path: string; seconds: number; at: number; name?: string };
// One line of what was said. `at` is seconds from the start of the whole interview: a second recording's lines carry
// on from where the first one ended, so one list reads as one conversation.
export type TranscriptLine = { at: number; text: string };
// Who was asked to write the insights, and into which doc. The words themselves are the doc's.
export type InterviewInsights = { docId: string; title: string; roomId: string; by: string; at: number };
export type Interview = {
  // The founder ticked "<who> agreed to be recorded". Nothing is recorded or added without it.
  consent: boolean; consentAt?: number;
  recordings: InterviewRecording[];
  transcript: TranscriptLine[];
  insights?: InterviewInsights;
  // What the transcriber is doing. `line` is what the card says while it works; `problem` why it stopped.
  state: 'idle' | 'transcribing' | 'failed';
  line?: string; problem?: string;
  // Which engine wrote the last transcript down and how long it took, in milliseconds. The card says both.
  engine?: string; tookMs?: number;
};
// What the card hears on the one live feed: the whole sidecar after every change, `rev` only ever growing.
export type InterviewEvent = { data: Interview; rev: number };
export const interviewChannel = (cardId: string) => `interview:${cardId}`;
export const emptyInterview = (): Interview => ({ consent: false, recordings: [], transcript: [], state: 'idle' });

// The card's own fields, as the stage keeps them.
export type InterviewCard = { who?: string; company?: string; on?: string };

// What a recording can be. Anything with sound in it that ffmpeg reads; a video's picture is ignored.
export const AUDIO_TYPES = ['wav', 'mp3', 'm4a', 'ogg', 'opus', 'webm', 'flac', 'aac', 'mp4', 'mov'] as const;
export const isAudioName = (name: string) => (AUDIO_TYPES as readonly string[]).includes(name.split('.').pop()?.toLowerCase() ?? '');

// "Ana, Acme, 2026-09-25": how the card, the doc it makes and a person's prompt all name one interview.
export function interviewName(card: InterviewCard): string {
  return [card.who?.trim() || 'Someone', card.company?.trim(), card.on?.trim()].filter(Boolean).join(', ');
}
export const insightsTitle = (card: InterviewCard) => `Insights: ${[card.who?.trim() || 'Someone', card.company?.trim()].filter(Boolean).join(', ')}`;

// A time in the call: 0:07, 12:40, 1:02:03.
export function stamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

// How long the call was, the way a person says it: "40 s", "24 min", "1 h 5 min".
export function length(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}
export const totalSeconds = (recordings: InterviewRecording[]) => recordings.reduce((sum, one) => sum + one.seconds, 0);

// Where a moment of the interview is: which recording, and how far into it. The last recording takes anything past
// the end, so a line stamped a hair after the sound stopped still plays.
export function whereIs(recordings: InterviewRecording[], at: number): { index: number; offset: number } | null {
  let from = 0;
  for (const [index, one] of recordings.entries()) {
    if (at < from + one.seconds || index === recordings.length - 1) return { index, offset: Math.max(0, at - from) };
    from += one.seconds;
  }
  return null;
}

// What the founder's "Write insights" puts into a person's room. The person reads the transcript with read_interview
// and writes into the doc the card made, or into the one already wired to the card (the customer-discovery team's
// Interviews doc), adding to it rather than writing over it.
export function insightsAsk(card: InterviewCard, doc: { title: string; fresh: boolean }): string {
  const who = card.who?.trim() || 'this person';
  const at = card.company?.trim() ? ` at ${card.company.trim()}` : '';
  const where = doc.fresh
    ? `into the doc "${doc.title}"`
    : `into the doc "${doc.title}", adding a section headed "${interviewName(card)}" with append_doc and leaving what is there`;
  return `Read the interview with ${who}${at} with read_interview. Then, with the story-interview skill, write the insights ${where}: `
    + 'the pains they described, what they do today instead and what it costs them, three quotes in their own words each with its time (m:ss), '
    + 'and any sign they would pay, or "no signal". Quote only what the transcript says.';
}
