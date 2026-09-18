import { listJobs, type Vault } from '@cubicle/core';

/** The statuses a job is still *in* the company for. Every one of these is listed, however many there are. */
const OPEN = ['running', 'blocked', 'queued'];

/**
 * How many finished jobs the note carries per status. `Jobs/` is the archive; this file is the board, and the
 * last twenty of each is enough to see what just happened without turning a queue into a history.
 */
export const QUEUE_MD_FINISHED_ROWS = 20;

/**
 * Regenerate `Jobs/queue.md` — a human-readable overview; never edited by hand.
 *
 * **Every open job** (ruling W6-10). The 2026-09-18 dry run found this note fifteen minutes stale, listing 9 of
 * the 23 job notes in the vault and still showing the discovery job as "queued, step 0" long after the brief had
 * been written, the board had sat and the owner had adopted. The office's own Queue screen was live and correct
 * throughout — it is the Obsidian-facing note that rotted, and Obsidian is half the product. A cap on the open
 * lanes would be the same defect with a smaller number, so only the finished ones are capped.
 */
export function writeQueueMd(vault: Vault, by = 'daemon'): void {
  const jobs = listJobs(vault);
  const groups: Record<string, typeof jobs> = {};
  for (const j of jobs) (groups[j.status] ??= []).push(j);
  const order = ['running', 'blocked', 'queued', 'in_review', 'done', 'failed', 'cancelled'];
  const open = jobs.filter((j) => OPEN.includes(j.status) || j.status === 'in_review').length;
  const lines = [
    '# Job queue', '',
    `_Generated ${new Date().toISOString()} by the daemon, and rewritten within a couple of seconds of any job changing. Edit individual job notes, not this file. Cancel a job with \`status: cancelled\`; reprioritise with \`priority\`._`,
    '',
    `**${open} open**, ${jobs.length} in \`Jobs/\` altogether. Every open job is listed below; finished ones are the last ${QUEUE_MD_FINISHED_ROWS} of each kind.`,
    '',
  ];
  for (const s of order) {
    const g = groups[s];
    if (!g?.length) continue;
    const capped = OPEN.includes(s) || s === 'in_review' ? g : g.slice(0, QUEUE_MD_FINISHED_ROWS);
    lines.push(`## ${s} (${g.length})`, '', '| priority | id | role | type | title | step | updated |', '|---|---|---|---|---|---|---|');
    for (const j of capped) lines.push(`| ${j.priority} | [[${j.id}]] | ${j.assigned} | ${j.type} | ${j.title.replace(/\|/g, '/')} | ${j.checkpoint_step} | ${j.updated.slice(0, 16).replace('T', ' ')} |`);
    if (capped.length < g.length) lines.push(`| | … ${g.length - capped.length} more | | | | | |`);
    lines.push('');
  }
  if (jobs.length === 0) lines.push('_No jobs yet._', '');
  vault.writeText('Jobs/queue.md', lines.join('\n'), by, { generated: true });
}
