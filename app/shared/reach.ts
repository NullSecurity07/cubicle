// Reaching the founder when they are not at this machine, as the screen sees it. A bot token and a hook's secret
// never appear here: the screen is told only whether one is set, and a secret is shown once, when it is made.
// `userId` is the person behind a paired chat, which is what a group has to go on: in a group anybody may write, and
// only the founder is listened to. A chat paired before groups existed has none, and its chat id is its user id.
export type ReachChat = { chatId: number; name: string; at: number; userId?: number; speak?: boolean };
export type ReachHook = { id: string; name: string; boardId: string; assignee?: string; at: number };
export type ReachPairing = { code: string; until: number; tries: number };
// What the founder is told without asking. `at` is the time of day the daily note arrives, in their own clock.
export type ReachUpdates = { on: boolean; finished: boolean; stuck: boolean; digest: boolean; at: string };
export const UPDATES: ReachUpdates = { on: true, finished: true, stuck: true, digest: true, at: '09:00' };
// The group the founder made, once they paired it: one topic per person and one for the company. The name a topic
// was given is kept beside it, because that is the only way to notice the founder has renamed somebody on the stage.
export type ReachTopic = { threadId: number; name: string };
export type ReachGroup = { chatId: number; title: string; at: number; topics: Record<string, ReachTopic>; company?: number; trouble?: string; speak?: boolean };
export type ReachState = {
  // `on` is the founder's switch for the phone; `voice` is the one for speaking and listening in a conversation.
  // Nothing leaves this machine, and nothing appears in a conversation, until they turn each of them on.
  on: boolean; hasToken: boolean; fromEnv: boolean; voice: boolean; cloudSpeech: boolean;
  paired: ReachChat[]; hooks: ReachHook[]; pairing?: ReachPairing; updates: ReachUpdates;
  // The group, with the people who have a topic in it by name, and what it is still waiting to be allowed to do.
  group?: { chatId: number; title: string; at: number; people: string[]; trouble?: string };
  // What the screen tells the founder when Telegram will not answer, and how the local speech model is coming along.
  trouble?: string; speech?: string; listening: 'here' | 'cloud';
};
// What the microphone sends and the voice model here expects: one channel of plain samples at 16 kHz.
export const LISTEN_RATE = 16_000;
