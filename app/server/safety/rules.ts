import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NEVER_ALWAYS, reachOf, type AllowRule } from '../../shared/safety.ts';

// The standing yeses. One rule is one person, one tool and the one argument that says how far the call goes, so
// "always allow emails to alex@example.com" never becomes "always allow emails". They live in the workspace, in plain
// json the founder can read, and every one of them can be taken back from the app.
export function createRules(path: string, now: () => number = Date.now) {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<AllowRule[]> => {
    const saved = JSON.parse((await readFile(path, 'utf8').catch(() => '{}')) || '{}') as { rules?: AllowRule[] };
    return (saved.rules ?? []).filter((one) => one && one.id && one.tool && one.reach && !NEVER_ALWAYS.includes(one.tool));
  };
  function write(rules: AllowRule[]) {
    const job = queue.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, JSON.stringify({ rules }, null, 2));
      await rename(`${path}.tmp`, path);
    });
    queue = job.catch(() => {});
    return job;
  }

  return {
    list: read,
    settled: () => queue,
    // The founder ticked the box on a call that is waiting. The rule is made from the call itself, never from what a
    // page says it was, and asking twice changes nothing.
    async remember(call: { roomId: string; who: string; tool: string; args: Record<string, unknown> }): Promise<AllowRule | null> {
      const found = reachOf(call.tool, call.args);
      if (!found) return null;
      const rules = await read();
      const had = rules.find((one) => one.roomId === call.roomId && one.tool === call.tool && one.reach === found.reach);
      if (had) return had;
      const rule: AllowRule = { id: `rule-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, roomId: call.roomId, who: call.who, tool: call.tool, reach: found.reach, label: found.label, at: now() };
      await write([...rules, rule]);
      return rule;
    },
    async forget(id: string): Promise<void> {
      const rules = await read();
      if (!rules.some((one) => one.id === id)) throw new Error('that rule is not there any more');
      await write(rules.filter((one) => one.id !== id));
    },
    // Whether this exact call is already covered. A call the founder never gave a standing yes to is asked about as
    // it always was.
    async allows(roomId: string, tool: string, args: Record<string, unknown>): Promise<boolean> {
      const found = reachOf(tool, args);
      if (!found) return false;
      return (await read()).some((one) => one.roomId === roomId && one.tool === tool && one.reach === found.reach);
    },
  };
}
