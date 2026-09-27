import type { AttentionKind } from './model.ts';
import type { LeadStage } from './leads.ts';

// The founder's dashboard, as both sides see it: one read of everything the app already keeps, put on one page.
// Nothing here is stored anywhere. Every row carries the id the window needs to open the place it came from: a room,
// a card, a task, a decision, a framework or a file.

export type DashNeed = {
  id: string; kind: AttentionKind; title: string; who?: string; at: number;
  roomId?: string; cardId?: string; taskId?: string; decisionId?: string;
};
// A task on a board: `at` is when it falls due (a repeat) or when its run started. `day` is the date a plan's step
// is due on, for a step that has a day and no time.
export type DashTask = { id: string; title: string; cardId: string; at: number; who?: string; roomId?: string; missed?: true; state?: string; day?: string };
export type DashWatch = { id: string; title: string; url: string; roomId: string; who?: string; at: number; diff?: string };
export type DashDecision = { id: string; title: string; who?: string; at: number };
// A conversation whose newest line is a person's reply the founder has not answered yet.
export type DashReply = { roomId: string; name: string; at: number };

export type DashDay = {
  needsYou: DashNeed[]; tasksDue: DashTask[]; tasksRunning: DashTask[]; watchesChanged: DashWatch[];
  leadsByStage: Record<LeadStage, number>; leadsChangedToday: number; leadsCardId?: string;
  decisionsPending: DashDecision[]; unreadMessages: number; replies: DashReply[];
};

// `limits` is the free allowance for a day, summed over the provider's keys; absent when the provider sets none.
// `window` says when the day starts again, in words.
export type DashProvider = {
  name: string; model: string; usedToday: { requests: number; tokens: number };
  limits: { rpd?: number; tpd?: number }; leftPct: number; window: string;
};
export type DashTokens = {
  byProvider: DashProvider[];
  byPerson: { name: string; roomId?: string; tokens7d: number; turns7d: number }[];
  byTool: { name: string; calls7d: number; tokens7d: number }[];
  // Oldest first, fourteen days ending today.
  byDay: { day: string; tokens: number }[];
};

export type DashCheck = { name: string; ok: boolean; detail: string; warn?: boolean };

// `placedRoomId` is the first of the team's people on the stage, for "Open".
export type DashTeam = {
  id: string; name: string; builtIn: boolean; placed: boolean; placedRoomId?: string;
  lastEval: { mean: number; at: number; judged: number; of: number } | null;
};

export type DashSkills = {
  count: number; usedThisWeek: { id: string; name: string; uses: number }[];
  keptOnItsOwn: number; keptBy: { roomId: string; name: string; count: number }[];
};

// One thing a studio made this week. `file` and `poster` are paths in the shared files; `cardId` is the studio.
export type DashMedia = {
  kind: 'picture' | 'voice' | 'film'; title: string; file: string; at: number; cardId: string;
  poster?: string; credits?: string; creditsFile?: string; nonCommercial?: boolean;
};

export type Dashboard = {
  at: number; day: DashDay; tokens: DashTokens; health: DashCheck[]; teams: DashTeam[]; skills: DashSkills; media: DashMedia[];
  // The newest backup (null: none yet), the folder they go to, and whether a backup could be written there now.
  backup?: DashBackup;
};
export type DashBackup = { at: number | null; dir: string; writable: boolean };
// One is made by itself each day, so a newest older than a day, none at all, or a folder that cannot take the next
// one all mean something is wrong.
export const backupLate = (backup: DashBackup, now: number) => !backup.writable || !backup.at || now - backup.at > 86_400_000;

// What the live feed says when anything under the dashboard moved. The open panel reads itself again.
export const DASHBOARD_CHANNEL = 'dashboard';
