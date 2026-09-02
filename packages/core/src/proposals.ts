import { InboxFrontmatter, type ProposalKind, type StoredCall } from './schemas.js';
import { makeId, nowIso, stampForFilename } from './fs.js';
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
  const id = p.id ?? makeId(p.kind === 'message' ? 'msg' : 'prop');
  const rel = `${INBOX}/${stampForFilename()}-${p.kind}-${id.split('_').pop()}.md`;
  const data = InboxFrontmatter.parse({ id, kind: p.kind, created: nowIso(), from: p.from, to: p.to ?? 'owner', call: p.call, target: p.target, job: p.job });
  const body = `# ${p.title.trim()}\n\n${p.body.trim()}\n`;
  vault.writeText(rel, stringifyNote(data as Record<string, unknown>, body), by, { job: p.job ?? null });
  vault.events.emit({ type: 'proposal.created', agent: by, job: p.job ?? null, payload: { id, kind: p.kind, path: rel, title: p.title, to: data.to } });
  return { id, path: rel };
}

export function listInbox(vault: Vault): { path: string; data: InboxFrontmatter; body: string }[] {
  const out = [];
  for (const rel of vault.list(INBOX, { ext: '.md' })) {
    if (rel.endsWith('README.md')) continue;
    const note = vault.readNoteOrNull(rel);
    if (!note) continue;
    const parsed = InboxFrontmatter.safeParse(note.data);
    if (!parsed.success) continue;
    out.push({ path: rel, data: parsed.data, body: note.body });
  }
  return out.sort((a, b) => a.data.created.localeCompare(b.data.created));
}

export function findInboxById(vault: Vault, id: string): { path: string; data: InboxFrontmatter; body: string } | null {
  return listInbox(vault).find((n) => n.data.id === id) ?? null;
}
