import { InboxFrontmatter, type ProposalKind, type StoredCall } from './schemas.js';
import { makeId, nowIso, stampForFilename, idFromKey, sha256 } from './fs.js';
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
  /**
   * Where on the office floor this one goes, when it is a hire the owner placed from the dock (SP9b). The
   * applied hire writes it into `Office/campus.md` as the new desk's position; a hire filed any other way
   * leaves the desk where the campus put it.
   */
  at?: { x: number; y: number };
}

export const INBOX = '00 Inbox';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// What the owner is told to do about a proposal (ruling W6-7)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where the owner actually decides. Named once so no body can point them anywhere else. */
export const OWNER_INSTRUCTION_SURFACE = 'Decisions';

/**
 * The one sentence a proposal body ends on, per kind — in the words of the screen the owner is looking at.
 *
 * The third dry-run's `idea_verdict` ended "To overrule the recommendation, set `chosen: 1` for keep, `2` for
 * park or `3` for scrap and `approved: true`" — Obsidian frontmatter surgery, printed underneath three buttons
 * that already do exactly that. The office reader filtered the line out of what it displayed, which is a patch
 * over the note rather than a fix to it: the note is the document, it is what a rejection quotes back, and every
 * new proposal kind had to remember to be filtered.
 *
 * So the instruction is written once, here, in the only vocabulary the owner shares with the product: the name
 * of the buttons and the name of the screen. Nothing in this table may name a frontmatter field — `ownerSetsNoField`
 * is the test of that, and it is run over every kind.
 */
export function ownerInstruction(kind: string): string {
  switch (kind) {
    case 'idea_verdict': return `Choose Keep, Park or Scrap in ${OWNER_INSTRUCTION_SURFACE}.`;
    case 'founder_brief': return `Adopt it or send it back in ${OWNER_INSTRUCTION_SURFACE}; sending it back asks the company to write it again.`;
    case 'plan_verdict': return `Approve it or send it back in ${OWNER_INSTRUCTION_SURFACE}. Work already approved keeps running while you decide.`;
    case 'brand_change': return `Pick one in ${OWNER_INSTRUCTION_SURFACE}. The name you choose becomes the company's.`;
    // One kind, two screens: three lines to choose between, and a single name to adopt. `brand_change_name` is
    // not a proposal kind — a caller may pass a finer key than the kind when the kind alone would say the wrong
    // thing, and every key still has to answer `namesAFieldToEdit` with false.
    case 'brand_change_name': return `Approve or reject the name in ${OWNER_INSTRUCTION_SURFACE}.`;
    case 'hire': return `Approve or reject the hire in ${OWNER_INSTRUCTION_SURFACE}.`;
    case 'message': return `Answer in ${OWNER_INSTRUCTION_SURFACE}, or say it to whoever asked.`;
    default: return `Approve or reject it in ${OWNER_INSTRUCTION_SURFACE}.`;
  }
}

/**
 * Whether a body tells the owner to go and edit a field — "set `approved: true`", "change `chosen:` to 2".
 *
 * The sweep ruling W6-7 asks for, as a predicate rather than a review: every body the company writes is held to
 * it in test, so the next proposal kind cannot quietly reintroduce the instruction the office replaced.
 */
export function namesAFieldToEdit(body: string): boolean {
  return /\b(set|edit|change|write|put|add)\b[^\n]{0,80}`?\b(chosen|approved|decision|status|resolved_at)`?\s*:/i.test(body ?? '');
}

/**
 * The readable tail of a proposal's filename, from its id.
 *
 * It used to be the last eight characters of the id's last underscore-segment, which on a deterministic id
 * cuts a word in half: `prop_idea_verdict_meal_kits_for_nurseries` filed as `…-idea_verdict-urseries.md`. That
 * is unreadable in a file list, and worse, two ideas whose slugs end the same way produce the same filename
 * within the same minute — and the second write would land on the first note. The id's own words are kept
 * instead, minus what the name already says (the kind, and the date the stamp carries), and a long one is cut
 * at an underscore boundary with a short hash of the whole id so it stays unique.
 */
export function filenameTail(id: string, kind: string, max = 40): string {
  let body = id.replace(/^(prop|msg)_/, '').replace(/^\d{8}_/, '');
  const k = kind.replace(/[^A-Za-z0-9]+/g, '_');
  if (body === k) body = '';
  else if (body.startsWith(`${k}_`)) body = body.slice(k.length + 1);
  if (!body) return sha256(id).slice(0, 8);
  if (body.length <= max) return body;
  return `${body.slice(-max).replace(/^[^_]*_/, '')}-${sha256(id).slice(0, 6)}`;
}

/** Write a proposal/message note into `00 Inbox/` and emit proposal.created. Returns the relative path. */
export function createProposal(vault: Vault, p: NewProposal, by: string): { id: string; path: string } {
  let id = p.id ?? makeId(p.kind === 'message' ? 'msg' : 'prop');
  if (p.id) {
    const existing = findInboxById(vault, id);
    if (existing) return { id, path: existing.path }; // idempotent replay
  } else {
    while (findInboxById(vault, id)) id = makeId(p.kind === 'message' ? 'msg' : 'prop');
  }
  const rel = `${INBOX}/${stampForFilename()}-${p.kind}-${filenameTail(id, p.kind)}.md`;
  const data = InboxFrontmatter.parse({ id, kind: p.kind, created: nowIso(), from: p.from, to: p.to ?? 'owner', call: p.call, target: p.target, job: p.job, ...(p.at ? { x: p.at.x, y: p.at.y } : {}) });
  const body = `# ${p.title.trim()}\n\n${p.body.trim()}\n`;
  vault.writeText(rel, stringifyNote(data as Record<string, unknown>, body), by, { job: p.job ?? null });
  vault.events.emit({ type: 'proposal.created', agent: by, job: p.job ?? null, payload: { id, kind: p.kind, path: rel, title: p.title, to: data.to } });
  return { id, path: rel };
}

/**
 * What a note is called on every screen the owner sees it on — the row, the reader, the wall, the outline.
 *
 * `createProposal` writes `# <title>` as the note's first line, so the heading *is* the title. The catch is that
 * a proposal also carries a whole document inside a `## Proposed content` fence, and that document has headings
 * of its own: when the board's rewrite took the covering note's heading away, a plain `/^#\s+(.+)$/m` fell
 * through the body and into the fence, and the company's founding document reached the owner called **Proposed
 * content** — in the reader's header, in its accessible name, and then as line 1 of `Memory/founder-brief.md`
 * (ruling W6-15). Anything inside a fence belongs to the document, not to the note, so it is never read here.
 *
 * With no heading of its own the note is named for what it *is*: "Founder brief" tells the owner something,
 * and a placeholder lifted off a page inside it tells them something false.
 */
export function noteTitle(body: string, kind = ''): string {
  let fence = '';
  for (const line of (body ?? '').split('\n')) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      // A fence closes on the same character, at least as long as the one that opened it; anything else inside
      // it is content (a ```` fence holds a ``` one, which is how a brief carries fenced markdown of its own).
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = '';
      continue;
    }
    if (fence) continue;
    const h = /^#\s+(.+)$/.exec(line);
    if (h && h[1].trim()) return h[1].trim();
  }
  const words = kind.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : kind;
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

/**
 * What the owner is told when they try to decide a founder brief the board is still arguing (ruling R-T3-3).
 *
 * One sentence, in core, because three surfaces have to say it and none of them may disagree: the `decide` op,
 * the dispatcher's own skip when the owner sets `approved:` in Obsidian, and the office's disabled action bar.
 */
export const BOARD_STILL_SITTING = 'the board is still pressure-testing this brief; it will be ready to adopt in a moment, with the board\'s findings in it';

/**
 * True while a proposal is a founder brief whose pressure test the board has not written yet (SP8, ruling
 * P8-6). Nothing may adopt it in that state: what would be adopted is the author's draft, and the session
 * finishing a moment later would rewrite a note the owner had already resolved.
 */
export function boardStillSitting(data: { kind?: unknown; board_pending?: unknown }): boolean {
  return data.kind === 'founder_brief' && data.board_pending === true;
}
