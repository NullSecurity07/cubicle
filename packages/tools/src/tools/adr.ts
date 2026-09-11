import { z } from 'zod';
import { defineTool } from '../registry.js';
import { stringifyNote, parseNote, nowIso, type Vault } from '@cubicle/core';

export const ADR_DIR = 'Docs/adr';

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'decision';
}

export function adrPath(n: number, title: string): string {
  return `${ADR_DIR}/ADR-${String(n).padStart(4, '0')}-${slug(title)}.md`;
}

/** `_template.md` is the shape, not a decision. */
function isAdr(rel: string): boolean { return /\/ADR-\d{4}-/.test(rel); }

export function listAdrs(vault: Vault): { id: string; title: string; path: string; date: string }[] {
  return vault.list(ADR_DIR, { ext: '.md' }).filter(isAdr).sort().map((rel) => {
    const n = parseNote(vault.readTextOrNull(rel) ?? '');
    const d = n.data as { id?: string; title?: string; date?: string };
    return { id: String(d.id ?? rel.match(/ADR-\d{4}/)?.[0] ?? '?'), title: String(d.title ?? ''), path: rel, date: String(d.date ?? '') };
  });
}

export function nextAdrNumber(vault: Vault): number {
  const nums = listAdrs(vault).map((a) => Number(a.id.replace('ADR-', ''))).filter((n) => Number.isFinite(n));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

export const adrCreate = defineTool({
  name: 'adr.create',
  description: 'Record an architecture decision in Docs/adr/ (toolchain document §8: context, decision, alternatives, consequences, date, owner). The dev manager writes one for every architecture decision; QA returns a ship that changed the architecture without one. Organisations forget why decisions were made — this is the cure, so the alternatives you rejected are required.',
  schema: {
    title: z.string().min(6).describe('the decision, as a sentence: "Use PostgreSQL for the checkout store"'),
    context: z.string().min(20).describe('the forces: what made this a decision rather than a default'),
    decision: z.string().min(10).describe('what we are doing, in the present tense'),
    alternatives: z.array(z.string().min(4)).min(1).describe('what you rejected and why — one line each'),
    consequences: z.string().min(10).describe('what this makes easier and what it makes harder, including the cost of reversing it'),
    status: z.enum(['proposed', 'accepted', 'superseded']).default('accepted'),
    supersedes: z.string().default('').describe('the ADR id this replaces, e.g. ADR-0003'),
  },
  async handler({ title, context, decision, alternatives, consequences, status, supersedes }, ctx) {
    if (!alternatives.length) return { ok: false, text: 'an ADR must name at least one alternative you rejected and why — that is the part organisations forget (toolchain §8)' };
    const n = nextAdrNumber(ctx.vault);
    const id = `ADR-${String(n).padStart(4, '0')}`;
    const rel = adrPath(n, title);
    const data = { id, title, status, date: nowIso().slice(0, 10), owner: ctx.roleId, job: ctx.jobId ?? null, supersedes: supersedes || null };
    const body = [
      `# ${id}: ${title}`, '',
      '## Context', '', context.trim(), '',
      '## Decision', '', decision.trim(), '',
      '## Alternatives', '', ...alternatives.map((a) => `- ${a.trim()}`), '',
      '## Consequences', '', consequences.trim(), '',
    ].join('\n');
    ctx.vault.writeText(rel, stringifyNote(data, body), ctx.roleId, { job: ctx.jobId });
    await ctx.memory?.indexFile?.(rel);
    return { ok: true, text: `wrote ${id} to ${rel}. Cite it from the job's Result artifacts so QA can see it.`, data: { id, path: rel } };
  },
});
