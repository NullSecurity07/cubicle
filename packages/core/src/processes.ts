import { z } from 'zod';
import type { Vault } from './vault.js';
import { createJob } from './jobs.js';

export const MAX_PROCESS_STEPS = 6;
const Step = z.object({ role: z.string(), type: z.string().default('custom'), title: z.string(), for: z.string().optional(), gate: z.string().optional() });
const Process = z.object({ name: z.string(), steps: z.array(Step).min(1).max(MAX_PROCESS_STEPS) });
export type ProcessStep = z.infer<typeof Step>;

export function readProcess(vault: Vault, name: string): { name: string; steps: ProcessStep[]; body: string } | null {
  const n = vault.readNoteOrNull(`Processes/${name}.md`);
  if (!n) return null;
  const p = Process.safeParse(n.data);
  return p.success ? { ...p.data, body: n.body } : null;
}

/** Create one job per step, each depending on the previous; `{objective}` in titles is filled in. */
export function expandProcess(vault: Vault, name: string, objective: string, ctx: { parent: string; by: string; team?: string; owner_role: string }): string[] {
  const p = readProcess(vault, name);
  if (!p) throw new Error(`unknown process: ${name}`);
  const ids: string[] = [];
  p.steps.forEach((s, i) => {
    const id = createJob(vault, {
      type: s.type, title: s.title.replace('{objective}', objective), assigned: s.role, priority: 2 + Math.min(i, 3),
      goal: `Step ${i + 1} of process "${name}" for the objective: ${objective}.\n\n${p.body.trim()}\n\nRead the previous step's job (${ids[i - 1] ?? 'none'}) result first.`,
      depends_on: ids[i - 1] ? [ids[i - 1]] : [], parent: ctx.parent, team: ctx.team, owner_role: ctx.owner_role, for: s.for, links: [`[[${ctx.parent}]]`],
    }, ctx.by);
    ids.push(id);
  });
  return ids;
}
