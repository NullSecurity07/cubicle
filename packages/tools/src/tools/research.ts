import { z } from 'zod';
import { createHash } from 'node:crypto';
import { defineTool } from '../registry.js';
import { readJob, updateJob, researchSlug, type ResearchRequest } from '@cubicle/core';

/**
 * A directory-safe slug: lowercase, hyphenated, no leading or trailing hyphen.
 * Not exported: `../adapters/common.js` already exports a `slugify` with the same shape, and re-exporting
 * a second one from `index.ts` would be an ambiguous export (TS2308). Kept local to this file.
 */
function slugifyPath(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export interface ResearchProjectInput {
  slug: string;
  jobId: string;
  title: string;
  request: ResearchRequest | null;
  /** YYYY-MM-DD. */
  today: string;
}

/**
 * The predictable research project directory (tool stack §63), with the §64 protocol template and the §34
 * universal output as the report's headings. Every file is a *starting point*: `research.start` writes only
 * the ones that do not exist yet, so re-running it never overwrites a researcher's work.
 */
export function researchProjectFiles(inp: ResearchProjectInput): { path: string; content: string }[] {
  const dir = `Research/${inp.slug}`;
  const r = inp.request;
  const confidence = r?.required_confidence ?? 'the confidence the decision owner needs';

  const readme = [
    `# ${inp.title}`,
    '',
    `Research project for job [[${inp.jobId}]], opened ${inp.today}.`,
    '',
    r ? `**Decision:** ${r.decision}  \n**Decision owner:** ${r.decision_owner}  \n**Deadline:** ${r.deadline}  \n**Portfolio:** ${r.portfolio}` : '_No research request on the job; this project was opened ad hoc._',
    '',
    '| file | what belongs in it |',
    '|---|---|',
    '| `question.md` | the question and the framing, unchanged once agreed |',
    '| `protocol.md` | method, sources, analysis plan and the stopping criterion — written *before* collection |',
    '| `sources.bib` | every source, one BibTeX entry, appended by `sources.cite` |',
    '| `evidence/` | what was collected, one file per source or dataset |',
    '| `analysis/` | scripts and their output; run them from the sandbox scratch dir, then write the results here |',
    '| `results/` | tables and figures the report cites |',
    '| `report.md` | the universal output; this is what the decision owner reads |',
    '',
    'Existing evidence first: search vault memory and `Research/index.md` before fetching anything new (§9).',
    '',
  ].join('\n');

  const question = [
    '# Question',
    '',
    r ? r.question : `_This project has no research request. It was opened from the job "${inp.title}"; write the question the job is actually trying to answer here before going further._`,
    '',
    '## Framing',
    '',
    r ? (r.hypothesis.trim() ? `**Hypothesis:** ${r.hypothesis.trim()}` : `**Exploration:** ${r.exploration.trim()}`) : '**Hypothesis or exploration:** ',
    '',
    '## Known evidence',
    '',
    r ? r.known_evidence : '',
    '',
    '## Unknowns',
    '',
    r ? r.unknowns : '',
    '',
    '## What would change the conclusion',
    '',
    '',
  ].join('\n');

  const protocol = [
    '# Protocol',
    '',
    '_Write this before collecting anything. A protocol written afterwards is a rationalisation._',
    '',
    '## Objective',
    '',
    r ? `Reduce uncertainty about "${r.question}" enough to decide: ${r.decision}.` : '',
    '',
    '## Scope',
    '',
    r ? `In scope: what bears on the decision. Out of scope: everything else. Constraints: ${r.constraints.trim() || 'none stated'}.` : '',
    '',
    '## Research questions',
    '',
    '## Hypotheses',
    '',
    '## Methods',
    '',
    'Secondary evidence first (§9), then targeted primary research for the gap it cannot close (§10), then an experiment when the riskiest assumption is testable (§11). Name the method you chose and why the cheaper one was not enough.',
    '',
    '## Sources',
    '',
    'Every source gets a `sources.cite` entry and, where it is a web page, an archived snapshot via `http.fetch { archive: true }`.',
    '',
    '## Data',
    '',
    '## Analysis',
    '',
    '## Risks',
    '',
    '## Limitations',
    '',
    '## Stopping criteria',
    '',
    `This research stops when the evidence supports the decision at ${confidence} confidence, or when the honest answer to "would additional research materially change the decision?" is no (§39). Stopping early is a risk; running on is waste. Record the date you stopped and which of the two reasons applied.`,
    '',
    '## Stopping decision',
    '',
    '',
  ].join('\n');

  const report = [
    '---',
    'confidence: unstated',
    'method: unstated',
    `job: ${inp.jobId}`,
    '---',
    `# ${inp.title}`,
    '',
    '## Executive summary',
    '',
    '## Decision required',
    '',
    r ? `${r.decision} — owned by ${r.decision_owner}, needed by ${r.deadline}.` : '',
    '',
    '## Research question',
    '',
    r ? r.question : '',
    '',
    '## Context',
    '',
    '## Hypotheses and assumptions',
    '',
    '## Methodology',
    '',
    '## Evidence',
    '',
    '## Analysis',
    '',
    '## Findings',
    '',
    'One line per finding, each with its evidence and its own confidence (§20).',
    '',
    '## Contradictory evidence',
    '',
    'What pointed the other way. If nothing did, say that you looked and say where.',
    '',
    '## Limitations',
    '',
    '## Confidence',
    '',
    `Overall: high / medium / low. Required by the decision owner: ${confidence}. If the two do not match, say so in the summary rather than at the bottom.`,
    '',
    '## Risks',
    '',
    '## Alternatives',
    '',
    '## Recommendation',
    '',
    'One recommendation, not three options with no opinion.',
    '',
    '## Decision',
    '',
    '_Filled in by the decision owner._',
    '',
    '## Follow-up measurements',
    '',
    'What should be true in N weeks if this recommendation was right, and how it will be checked.',
    '',
    '## Supporting evidence',
    '',
    `See \`${dir}/evidence/\`, \`${dir}/results/\` and \`${dir}/sources.bib\`.`,
    '',
  ].join('\n');

  const bib = `% Sources for ${inp.title} (job ${inp.jobId}), opened ${inp.today}.\n% Appended by the sources.cite tool; one @misc entry per source.\n`;

  return [
    { path: `${dir}/README.md`, content: readme },
    { path: `${dir}/question.md`, content: question },
    { path: `${dir}/protocol.md`, content: protocol },
    { path: `${dir}/sources.bib`, content: bib },
    { path: `${dir}/evidence/.gitkeep`, content: '' },
    { path: `${dir}/analysis/.gitkeep`, content: '' },
    { path: `${dir}/results/.gitkeep`, content: '' },
    { path: `${dir}/report.md`, content: report },
  ];
}

export const researchStart = defineTool({
  name: 'research.start',
  description: 'Open the research project directory for this job: Research/<slug>/ with README.md, question.md, protocol.md (including the stopping criterion), sources.bib, evidence/, analysis/, results/ and report.md pre-filled from the job\'s research request. Idempotent: files you have already written are never overwritten. Call it once, first, before collecting anything.',
  schema: { slug: z.string().optional().describe('directory name; defaults to a slug of the research question plus the job id') },
  async handler({ slug }, ctx) {
    if (!ctx.jobId) return { ok: false, text: 'research.start needs a job: it opens the project directory for the research job you are working on' };
    const note = readJob(ctx.vault, ctx.jobId);
    if (!note) return { ok: false, text: `job ${ctx.jobId} not found` };
    const request = (note.data.research as ResearchRequest | undefined) ?? null;
    const chosen = slug ? slugifyPath(slug) : (note.data.research_slug ?? researchSlug(request?.question ?? note.data.title, ctx.jobId));
    if (!chosen) return { ok: false, text: `"${slug}" is not a usable directory name; use letters and digits` };
    const files = researchProjectFiles({ slug: chosen, jobId: ctx.jobId, title: note.data.title, request, today: ctx.now().toISOString().slice(0, 10) });
    const created: string[] = [];
    for (const f of files) {
      if (ctx.vault.exists(f.path)) continue;
      ctx.vault.writeText(f.path, f.content, ctx.roleId, { job: ctx.jobId });
      created.push(f.path);
    }
    if (note.data.research_slug !== chosen) updateJob(ctx.vault, ctx.jobId, { research_slug: chosen }, ctx.roleId, `- research project opened at Research/${chosen}/`);
    const dir = `Research/${chosen}`;
    const text = created.length
      ? `opened ${dir}/ (${created.length} files). Write ${dir}/protocol.md before you collect anything — method, sources and the stopping criterion — then ${dir}/report.md as you go. Cite every source with sources.cite(slug: "${chosen}").`
      : `${dir}/ already exists; nothing was overwritten. Continue in ${dir}/protocol.md and ${dir}/report.md.`;
    return { ok: true, text, data: { slug: chosen, dir, created } };
  },
});

/** BibTeX values may not carry unbalanced braces; the safest thing to do with an agent-supplied string is round them. */
function bibValue(s: string): string {
  return s.replace(/[{}]/g, (c) => (c === '{' ? '(' : ')')).replace(/\s+/g, ' ').trim();
}

/** A citation key that is readable (host + year) and unique (4 hex of the url). Legal BibTeX: letters and digits only. */
export function citeKey(url: string, date: string): string {
  let host = 'source';
  try { host = new URL(url).host.replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/gi, '').slice(0, 20).toLowerCase() || 'source'; } catch { /* not a url */ }
  const year = /^(\d{4})/.exec(date.trim())?.[1] ?? String(new Date().getUTCFullYear());
  return `${host}${year}${createHash('sha1').update(url).digest('hex').slice(0, 4)}`;
}

/** One `@misc` entry. `note` carries the archive path when the page was snapshotted, so evidence stays traceable (§41). */
export function bibtexEntry(s: { url: string; title: string; date: string; author?: string; note?: string; archive?: string }): { key: string; text: string } {
  const key = citeKey(s.url, s.date);
  const note = [s.note?.trim(), s.archive?.trim() ? `archived at ${s.archive.trim()}` : ''].filter(Boolean).join('; ');
  const lines = [
    `@misc{${key},`,
    `  title        = {${bibValue(s.title)}},`,
    ...(s.author?.trim() ? [`  author       = {${bibValue(s.author)}},`] : []),
    `  howpublished = {\\url{${s.url}}},`,
    `  urldate      = {${bibValue(s.date)}},`,
    ...(note ? [`  note         = {${bibValue(note)}},`] : []),
    '}',
  ];
  return { key, text: lines.join('\n') + '\n' };
}

/** The key an entry for `url` already has in this .bib, or null. Entries are split on a line-initial `@`. */
export function findCiteKey(bib: string, url: string): string | null {
  for (const chunk of bib.split(/\n(?=@)/)) {
    if (chunk.includes(`\\url{${url}}`)) return /^@\w+\{([^,]+),/.exec(chunk.trimStart())?.[1] ?? null;
  }
  return null;
}

export const sourcesCite = defineTool({
  name: 'sources.cite',
  description: 'Record a source in a research project\'s sources.bib and get its citation key back. Deduplicates by URL, so calling it twice on the same page is free. Cite the key in report.md so every claim is traceable to where it came from.',
  schema: {
    slug: z.string().describe('the research project directory name returned by research.start'),
    url: z.string().describe('where the source lives'),
    title: z.string().describe('the source\'s own title, not your summary of it'),
    date: z.string().optional().describe('the date you read it, YYYY-MM-DD; defaults to today'),
    author: z.string().optional().describe('author or publishing organisation'),
    note: z.string().optional().describe('one line on why this source matters'),
    archive: z.string().optional().describe('the Research/archive/ path from http.fetch { archive: true }, when you have one'),
  },
  async handler({ slug, url, title, date, author, note, archive }, ctx) {
    const clean = slugifyPath(slug);
    const rel = `Research/${clean}/sources.bib`;
    const existing = ctx.vault.readTextOrNull(rel);
    if (existing === null) return { ok: false, text: `no research project at Research/${clean}/ — call research.start first, then cite into the slug it returns` };
    const already = findCiteKey(existing, url);
    if (already) return { ok: true, text: `${url} is already source \\cite{${already}} in ${rel}; nothing appended`, data: { key: already, path: rel, added: false } };
    const when = (date ?? '').trim() || ctx.now().toISOString().slice(0, 10);
    const { key, text } = bibtexEntry({ url, title, date: when, author, note, archive });
    ctx.vault.appendText(rel, (existing.endsWith('\n') ? '' : '\n') + '\n' + text, ctx.roleId, { job: ctx.jobId });
    return { ok: true, text: `added ${url} to ${rel}; cite it as \\cite{${key}}`, data: { key, path: rel, added: true } };
  },
});
