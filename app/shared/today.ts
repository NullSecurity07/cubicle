// Today's five: the few things most worth the founder's morning, ranked by a fixed table from what the app already
// keeps. Each carries a one-line reason, the sentence on why it ranks where it does, and the ids that open its place.
export type TodayItem = {
  id: string; kind: string; title: string; reason: string; why: string; score: number;
  roomId?: string; cardId?: string; docId?: string; decisionId?: string; taskId?: string;
};
export type Today = { at: number; items: TodayItem[] };
export const TODAY_SIZE = 5;
