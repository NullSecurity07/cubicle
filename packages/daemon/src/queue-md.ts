import { listJobs, type Vault } from '@cubicle/core';

/** Regenerate Jobs/queue.md — a human-readable overview; never edited by hand. */
export function writeQueueMd(vault: Vault, by = 'daemon'): void {
  const jobs = listJobs(vault);
  const groups: Record<string, typeof jobs> = {};
  for (const j of jobs) (groups[j.status] ??= []).push(j);
  const order = ['running', 'blocked', 'queued', 'done', 'failed', 'cancelled'];
  const lines = ['# Job queue', '', `_Generated ${new Date().toISOString()} by the daemon. Edit individual job notes, not this file. Cancel a job with \`status: cancelled\`; reprioritise with \`priority\`._`, ''];
  for (const s of order) {
    const g = groups[s];
    if (!g?.length) continue;
    lines.push(`## ${s} (${g.length})`, '', '| priority | id | role | type | title | step | updated |', '|---|---|---|---|---|---|---|');
    for (const j of g.slice(0, s === 'done' ? 20 : 100)) lines.push(`| ${j.priority} | [[${j.id}]] | ${j.assigned} | ${j.type} | ${j.title.replace(/\|/g, '/')} | ${j.checkpoint_step} | ${j.updated.slice(0, 16).replace('T', ' ')} |`);
    if (s === 'done' && g.length > 20) lines.push(`| | … ${g.length - 20} more | | | | | |`);
    lines.push('');
  }
  if (jobs.length === 0) lines.push('_No jobs yet._', '');
  vault.writeText('Jobs/queue.md', lines.join('\n'), by, { silent: true });
}
