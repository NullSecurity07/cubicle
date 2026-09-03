import { InboxFrontmatter, type ProposalKind, type StoredCall } from './schemas.js';
import { makeId, nowIso, stampForFilename, idFromKey } from './fs.js';
import { statSync } from 'node:fs';
import type { Vault } from './vault.js';
import { stringifyNote } from './frontmatter.js';

export interface NewProposal {
  kind: ProposalKind;
  from: string;
  to?: string;
  title: string;
  body: string;
  call?: StoredCall;
  target?: string;
  job?: string;
  id?: string;
}

export const INBOX = '00 Inbox';

/** Write a proposal/message note into `00 Inbox/` and emit proposal.created. Returns the relative path. */
export function createProposal(vault: Vault, p: NewProposal, by: string): { id: string; path: string } {
  let id = p.id ?? makeId(p.kind === 'message' ? 'msg' : 'prop');
  if (p.id) {
    const existing = findInboxById(vault, id);
    if (existing) return { id, path: existing.path }; // idempotent replay
  } else {
    while (findInboxById(vault, id)) id = makeId(p.kind === 'message' ? 'msg' : 'prop');
  }
  const rel = `${INBOX}/${stampForFilename()}-${p.kind}-${id.split('_').slice(-1)[0].slice(-8)}.md`;
  const data = InboxFrontmatter.parse({ id, kind: p.kind, created: nowIso(), from: p.from, to: p.to ?? 'owner', call: p.call, target: p.target, job: p.job });
  const body = `# ${p.title.trim()}\n\n${p.body.trim()}\n`;
  vault.writeText(rel, stringifyNote(data as Record<string, unknown>, body), by, { job: p.job ?? null });
  vault.events.emit({ type: 'proposal.created', agent: by, job: p.job ?? null, payload: { id, kind: p.kind, path: rel, title: p.title, to: data.to } });
  return { id, path: rel };
}

/**
 * Fill in what an owner typing a note in Obsidian will not: `id` (stable, derived from the path), `created`
 * (file mtime), `from: owner`, and `to: ceo` for owner-authored notes. Agent notes written by createProposal
 * already carry every field and pass through unchanged.
 */
export function withInboxDefaults(rel: string, data: Record<string, unknown>, mtimeIso: () => string): Record<string, unknown> {
  const d = { ...data };
  if (d.from === undefined || d.from === null || d.from === '') d.from = 'owner';
  if ((d.to === undefined || d.to === null || d.to === '') && d.from === 'owner') d.to = 'ceo';
  if (d.id === undefined || d.id === null || d.id === '') d.id = idFromKey(d.kind === 'message' ? 'msg' : 'prop', rel);
  if (d.created === undefined || d.created === null || d.created === '') d.created = mtimeIso();
  else if (d.created instanceof Date) d.created = d.created.toISOString();
  return d;
}

const warnedInbox = new Set<string>();

export function listInbox(vault: Vault): { path: string; data: InboxFrontmatter; body: string }[] {
  const out = [];
  for (const rel of vault.list(INBOX, { ext: '.md' })) {
    if (rel.endsWith('README.md')) continue;
    const note = vault.readNoteOrNull(rel);
    if (!note) continue;
    const data = withInboxDefaults(rel, note.data, () => { try { return statSync(vault.abs(rel)).mtime.toISOString(); } catch { return nowIso(); } });
    const parsed = InboxFrontmatter.safeParse(data);
    if (!parsed.success) {
      // Never drop an owner's note silently: one warning per (path, content) so a tick loop does not spam the log.
      const key = `${rel}@${vault.currentSha(rel) ?? ''}`;
      if (!warnedInbox.has(key)) {
        warnedInbox.add(key);
        const reason = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        vault.events.emit({ type: 'daemon.warning', payload: { path: rel, reason: `inbox note ignored — ${reason}` } });
      }
      continue;
    }
    out.push({ path: rel, data: parsed.data, body: note.body });
  }
  return out.sort((a, b) => a.data.created.localeCompare(b.data.created));
}

export function findInboxById(vault: Vault, id: string): { path: string; data: InboxFrontmatter; body: string } | null {
  return listInbox(vault).find((n) => n.data.id === id) ?? null;
}
