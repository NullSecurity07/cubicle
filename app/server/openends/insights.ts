import type { Insights, Share, Today } from '../../shared/openends.ts';
import type { Skills } from '../skills.ts';
import { createTrace, type Totals } from '../trace.ts';

// What the work came to. Everything here is already written down — one line a turn, in the workspace's own index —
// so this only adds it up and puts a name to each row. Nothing is sent anywhere to work it out.
const DAY = 86_400_000;

// The trace counts by room id, which is not what anybody calls a person. Biggest first, so the founder reads the
// three rows that matter and stops.
export function shares(totals: Record<string, Totals>, nameOf: (id: string) => string): Share[] {
  return Object.entries(totals)
    .map(([id, one]) => ({ name: nameOf(id) || id, turns: one.turns, tokens: one.input + one.output, failed: one.failed }))
    .sort((one, other) => other.tokens - one.tokens || other.turns - one.turns);
}

// `today` is the usage book's own count, which is the only number here that is about right now rather than about
// what is written down: how much of each free allowance is still there today.
export function createInsights(deps: { workspace: string; skills: Skills; nameOf: (id: string) => Promise<string>; today?: () => Today[]; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const trace = createTrace(deps.workspace, now);

  return {
    async read(days = 7): Promise<Insights> {
      const summary = await trace.summary(days);
      const names: Record<string, string> = {};
      for (const id of Object.keys(summary.people)) names[id] = await deps.nameOf(id).catch(() => id);
      const totals = Object.values(summary.people).reduce(
        (sum, one) => ({ input: sum.input + one.input, output: sum.output + one.output, tools: sum.tools + one.tools, failed: sum.failed + one.failed }),
        { input: 0, output: 0, tools: 0, failed: 0 },
      );
      const since = now() - summary.days * DAY;
      const skills = await deps.skills.list();
      return {
        days: summary.days, turns: summary.turns, ...totals,
        people: shares(summary.people, (id) => names[id] ?? id),
        providers: shares(summary.providers, (id) => id),
        today: (deps.today?.() ?? []).map((one) => ({ name: one.name, left: one.left, requests: one.requests, tokens: one.tokens })),
        skills: {
          learned: skills.filter((one) => one.createdAt >= since).length,
          active: skills.filter((one) => one.state === 'active').length,
          used: skills.filter((one) => (one.usedAt ?? 0) >= since).length,
        },
      };
    },
  };
}
