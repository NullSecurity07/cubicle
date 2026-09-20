// Reaching the founder when they are not at this machine, as the screen sees it. A bot token and a hook's secret
// never appear here: the screen is told only whether one is set, and a secret is shown once, when it is made.
export type ReachChat = { chatId: number; name: string; at: number };
export type ReachHook = { id: string; name: string; boardId: string; assignee?: string; at: number };
export type ReachPairing = { code: string; until: number; tries: number };
export type ReachState = {
  // `on` is the founder's switch for the phone; `voice` is the one for speaking and listening in a conversation.
  // Nothing leaves this machine, and nothing appears in a conversation, until they turn each of them on.
  on: boolean; hasToken: boolean; fromEnv: boolean; voice: boolean; cloudSpeech: boolean;
  paired: ReachChat[]; hooks: ReachHook[]; pairing?: ReachPairing;
  // What the screen tells the founder when Telegram will not answer, and how the local speech model is coming along.
  trouble?: string; speech?: string; listening: 'here' | 'cloud';
};
// What the microphone sends and the voice model here expects: one channel of plain samples at 16 kHz.
export const LISTEN_RATE = 16_000;
