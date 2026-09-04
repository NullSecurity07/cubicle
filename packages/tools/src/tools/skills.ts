import { z } from 'zod';
import { defineTool } from '../registry.js';
import { nowIso, stringifyNote, parseNote } from '@cubicle/core';

export function skillSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'skill';
}

export const skillsSave = defineTool({
  name: 'skills.save',
  description: 'Save a reusable procedure to Skills/ so any role can find it later.',
  schema: { name: z.string(), when_to_use: z.string(), steps: z.array(z.string()).min(1), evidence: z.string().default('').describe('link to the job/result proving it worked') },
  async handler({ name, when_to_use, steps, evidence }, ctx) {
    const slug = skillSlug(name);
    const rel = `Skills/${slug}.md`;
    const existing = ctx.vault.readNoteOrNull<{ uses?: number; failures?: number }>(rel);
    const data = { name, slug, author: ctx.roleId, created: existing?.data ? (existing.data as { created?: string }).created ?? nowIso() : nowIso(), updated: nowIso(), uses: existing?.data.uses ?? 0, failures: existing?.data.failures ?? 0, when_to_use };
    const body = `# ${name}\n\n## When to use\n\n${when_to_use.trim()}\n\n## Steps\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n## Evidence\n\n${evidence || '_none yet_'}\n`;
    ctx.vault.writeText(rel, stringifyNote(data, body), ctx.roleId, { job: ctx.jobId });
    await ctx.memory?.indexFile?.(rel);
    return { ok: true, text: `saved skill ${slug} at ${rel}`, data: { path: rel } };
  },
});

export const skillsLoad = defineTool({
  name: 'skills.load',
  description: 'Load a skill by name/slug.',
  schema: { name: z.string() },
  async handler({ name }, ctx) {
    const rel = `Skills/${skillSlug(name)}.md`;
    const text = ctx.vault.readTextOrNull(rel);
    if (text === null) return { ok: false, text: `no skill "${name}"` };
    const note = parseNote<{ uses?: number }>(text);
    ctx.vault.writeText(rel, stringifyNote({ ...note.data, uses: (note.data.uses ?? 0) + 1 }, note.body), ctx.roleId, { generated: true });
    return { ok: true, text };
  },
});

export const skillsSearch = defineTool({
  name: 'skills.search',
  description: 'Find relevant skills by meaning (embedding search over Skills/), falling back to text search.',
  schema: { query: z.string(), k: z.number().int().min(1).max(10).default(3) },
  async handler({ query, k }, ctx) {
    if (ctx.memory) {
      const hits = await ctx.memory.search(query, k, ['Skills']);
      if (hits.length) return { ok: true, text: hits.map((h) => `${h.path} (${h.score.toFixed(2)})\n${h.text.slice(0, 400)}`).join('\n\n'), data: hits };
    }
    const q = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = ctx.vault.list('Skills', { ext: '.md' }).map((rel) => {
      const t = ctx.vault.readText(rel).toLowerCase();
      return { path: rel, score: q.filter((w) => t.includes(w)).length, text: ctx.vault.readText(rel) };
    }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
    return { ok: true, text: scored.length ? scored.map((s) => `${s.path}\n${s.text.slice(0, 400)}`).join('\n\n') : 'no matching skills', data: scored };
  },
});

export const skillsTools = [skillsSave, skillsLoad, skillsSearch];
