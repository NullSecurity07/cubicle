// What the open ends say, shared by the server and the screen. Nothing here is a key, a value or a path outside the
// workspace: the founder reads whether a thing is there, never what it is.

// One thing that either works or does not, in the founder's own words. `fix` is what they would do about it.
// `warn`: working, but worth a look (amber, not red): the backups are fresh but on the workspace's own disk.
export type Check = { name: string; ok: boolean; detail: string; fix: string; warn?: boolean };

// One archive of the workspace, as it sits on disk.
export type Backup = { file: string; at: number; bytes: number };
export type Backups = { dir: string; kept: number; backups: Backup[] };

// A tool an outside program offers. `name` is what the people call it; `tool` is what it is called over there.
export type OutsideTool = { name: string; tool: string; description: string; safe: boolean };
export type OutsideServer = { name: string; how: 'stdio' | 'web'; ok: boolean; detail: string; tools: OutsideTool[] };
export type Outside = { file: string; servers: OutsideServer[] };

// What the work came to. `tokens` is input plus output, which is the number a free quota is spent in.
export type Share = { name: string; turns: number; tokens: number; failed: number };
// Where one provider stands right now: `left` is the share of today's free allowance still there, 0 to 1.
export type Today = { name: string; left: number; requests: number; tokens: number };
// Today's calls by what they were for (a turn, a side call, an eval, retain, reflect, compaction), biggest first.
export type KindShare = { kind: string; requests: number; tokens: number };
// Today's tool results on their way into prompts: how many, and the characters before and after they were shrunk.
export type ToolShare = { tool: string; results: number; before: number; after: number };
// What the savers kept off the free quotas today: characters folded out of tool results, calls and web reads answered
// from the cache, and the tokens those cached calls cost the first time.
export type Saved = { foldedChars: number; cacheHits: number; cacheMisses: number; cacheTokensSaved: number; webHits: number; webMisses: number };
export type Insights = {
  days: number; turns: number; input: number; output: number; tools: number; failed: number;
  people: Share[]; providers: Share[]; today: Today[]; skills: { learned: number; active: number; used: number };
  // Added later, and only there when the usage book is: older screens read on without them.
  byKind?: KindShare[]; byTool?: ToolShare[]; saved?: Saved;
};
