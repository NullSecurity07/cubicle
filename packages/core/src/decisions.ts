import { DecisionFrontmatter } from './schemas.js';
import { stringifyNote } from './frontmatter.js';
import type { Vault } from './vault.js';

export const DECISIONS = 'Decisions';

export interface DecisionNote {
  path: string;
  data: DecisionFrontmatter;
  body: string;
}

/** The six body sections every decision owes (spec §1.7, §4.1), in the order they are written. */
export interface DecisionSections {
  context: string;
  options: string;
  chosen: string;
  why: string;
  expected_effect: string;
  review_date: string;
}

/** Frontmatter a caller supplies; `id` comes from the filename the caller asked for. */
export type NewDecision = Omit<Partial<DecisionFrontmatter>, 'id'> & { decided_by: string; cycle: string };

const warnedDecisions = new Set<string>();

/**
 * Every decision note that validates, oldest path first. A malformed note is skipped with one
 * `daemon.warning` per (path, revision) so a per-tick caller does not spam the log.
 */
export function listDecisions(vault: Vault): DecisionNote[] {
  const out: DecisionNote[] = [];
  for (const rel of vault.list(DECISIONS, { ext: '.md', recursive: true })) {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (base === 'README.md' || base.startsWith('_')) continue;
    const note = vault.readNoteOrNull(rel);
    if (!note) continue;
    const parsed = DecisionFrontmatter.safeParse(note.data);
    if (!parsed.success) {
      const key = `${rel}@${vault.currentSha(rel) ?? ''}`;
      if (!warnedDecisions.has(key)) {
        warnedDecisions.add(key);
        const reason = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        vault.events.emit({ type: 'daemon.warning', payload: { path: rel, reason: `decision note ignored — ${reason}` } });
      }
      continue;
    }
    out.push({ path: rel, data: parsed.data, body: note.body });
  }
  return out;
}

export function decisionPath(id: string): string {
  return `${DECISIONS}/${id}.md`;
}

/**
 * Write `Decisions/<id>.md` as `by`, with the six spec sections in order. `review_date` is mirrored into
 * the frontmatter so the review machinery can find it without parsing the body. Returns the vault path.
 */
export function writeDecision(vault: Vault, id: string, fm: NewDecision, sections: DecisionSections, by: string): string {
  const data = DecisionFrontmatter.parse({
    owner_rating: null,
    ...fm,
    id,
    review_date: fm.review_date ?? sections.review_date,
  });
  const body = [
    ['Context', sections.context],
    ['Options considered', sections.options],
    ['Chosen', sections.chosen],
    ['Why', sections.why],
    ['Expected effect', sections.expected_effect],
    ['Review date', sections.review_date],
  ].map(([h, text]) => `## ${h}\n\n${String(text).trim()}\n`).join('\n');
  const rel = decisionPath(id);
  vault.writeText(rel, stringifyNote(data as Record<string, unknown>, body), by);
  return rel;
}
