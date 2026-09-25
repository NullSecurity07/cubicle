import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Usage } from '../shared/model.ts';
import { localDay } from './clock.ts';
import type { Handler, Source } from './seams.ts';

// What one turn cost and what it did. Written after the founder already has their reply, so nothing here is in their way.
export type TraceLine = { at: number; roomId: string; source: Source; provider: string; model: string; usage: Usage; tools: { name: string; ok: boolean }[]; stopped: boolean };
export type Totals = { turns: number; input: number; output: number; tools: number; failed: number };

const KEEP_DAYS = 30;
const MAX_DAYS = 90;
const DAY = 86_400_000;
const dayOf = localDay;
const add = (totals: Record<string, Totals>, key: string, line: TraceLine) => {
  const one = (totals[key] ??= { turns: 0, input: 0, output: 0, tools: 0, failed: 0 });
  one.turns += 1;
  one.input += line.usage?.input ?? 0;
  one.output += line.usage?.output ?? 0;
  one.tools += line.tools.length;
  one.failed += line.tools.filter((tool) => !tool.ok).length;
};

// One line a turn, one file a day, under the workspace's own index folder. Writes go through one queue so two rooms
// finishing at once cannot land half a line each, and a day older than a month is swept away the first time a new day
// is written: a founder's machine should not fill up with last quarter's arithmetic.
export function createTrace(dir: string, now: () => number = Date.now) {
  const folder = join(dir, '.index', 'trace');
  let queue: Promise<unknown> = Promise.resolve();
  let swept = '';

  async function sweep(today: string) {
    const oldest = dayOf(now() - KEEP_DAYS * DAY);
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      if (name.endsWith('.jsonl') && name.slice(0, -6) < oldest) await rm(join(folder, name), { force: true });
    }
    swept = today;
  }

  async function record(line: TraceLine) {
    const today = dayOf(line.at);
    const job = queue.then(async () => {
      await mkdir(folder, { recursive: true });
      await appendFile(join(folder, `${today}.jsonl`), `${JSON.stringify(line)}\n`);
      if (swept !== today) await sweep(today);
    });
    queue = job.catch(() => {});
    return job;
  }

  return {
    record,
    // What the days since then came to, per person and per model. A day whose file is gone or half written is skipped.
    async summary(days = 7) {
      const wanted = new Set(Array.from({ length: Math.min(Math.max(Math.round(days) || 1, 1), MAX_DAYS) }, (_, back) => dayOf(now() - back * DAY)));
      await queue;
      const people: Record<string, Totals> = {};
      const providers: Record<string, Totals> = {};
      let turns = 0;
      for (const name of (await readdir(folder).catch(() => [] as string[])).sort()) {
        if (!name.endsWith('.jsonl') || !wanted.has(name.slice(0, -6))) continue;
        for (const text of (await readFile(join(folder, name), 'utf8').catch(() => '')).split('\n')) {
          let line: TraceLine;
          try { line = JSON.parse(text) as TraceLine; } catch { continue; }
          turns += 1;
          add(people, line.roomId, line);
          add(providers, line.provider || 'none', line);
        }
      }
      return { days: wanted.size, turns, people, providers };
    },
    // The `turn:after` handler. A failure to write is the seam's to swallow; the turn is long over.
    handler: (async (payload, next) => {
      await record({
        at: now(), roomId: payload.roomId, source: payload.source, provider: payload.reply.provider, model: payload.reply.model,
        usage: payload.reply.usage, tools: payload.reply.tools.map((tool) => ({ name: tool.name, ok: tool.ok === true })), stopped: payload.reply.stopped,
      });
      return next(payload);
    }) satisfies Handler<'turn:after'>,
  };
}
