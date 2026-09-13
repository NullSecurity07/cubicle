import { statSync } from 'node:fs';
import { listInbox } from './proposals.js';
import { loadOrg, type Org } from './org.js';
import { nowIso } from './fs.js';
import type { Vault } from './vault.js';

/**
 * Every conversation the company has had, read back off the vault.
 *
 * Ruling P8-2: **one index, one parser per note shape, all read from the vault.** A transcript that lived in
 * the daemon's memory would be gone on the first reconnect, and the office would show an empty Messages view
 * for a company that had been talking all morning. Four shapes write conversations today — the cabin thread,
 * meeting notes (the board writes the same shape), pantry notes and `Messages/<role>.md` — and each gets
 * exactly one reader here.
 */

export type ThreadKind = 'dm' | 'meeting' | 'board' | 'pantry' | 'agents';

/** One thing somebody said. `at` is null for the shapes that stamp nothing; those turns are ordered as written. */
export interface Turn { who: string; at: string | null; text: string }

export interface Thread {
  id: string;
  kind: ThreadKind;
  title: string;
  room?: string;
  participants: string[];
  updated: string;
  /** A meeting still in progress. The office shows a LIVE dot; everything finished is false. */
  open: boolean;
  last: { who: string; text: string; at: string | null } | null;
  turns: number;
}

/** The thread list is a list, not an archive: the newest sixty. Older conversations are read in the vault. */
export const CONVERSATIONS_MAX = 60;
/** How much of the closing turn a thread row carries. The full text comes from `readConversation`. */
export const THREAD_PREVIEW_CHARS = 280;
/**
 * How many turns of one thread are kept — the **newest**. `Messages/<role>.md` is append-only and nothing ever
 * trims it, so a pair that has worked together for a month is the one conversation that could put megabytes on
 * the wire. The thread's `turns` count stays honest (it counts what was said, not what is carried); it is the
 * reading of it that stops at the last five hundred.
 */
export const THREAD_TURNS_MAX = 500;
/** The owner ↔ CEO thread. There is exactly one, so its id is a constant. */
export const DM_THREAD_ID = 'dm:owner-ceo';

interface Conversation { thread: Thread; turns: Turn[] }

const displayOf = (org: Org, role: string): string => org.roles[role]?.display || role;

/**
 * The scaffold's own furniture, which is not a conversation: `README.md` and the `_`-prefixed explainers the
 * template leaves in `Pantry/` and friends for whoever opens the vault in Obsidian. `listDecisions` skips the
 * same two shapes for the same reason.
 */
function isFurniture(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return base === 'README.md' || base.startsWith('_');
}

function mtimeOf(vault: Vault, rel: string): string {
  try { return statSync(vault.abs(rel)).mtime.toISOString(); } catch { return nowIso(); }
}

/** The thread half of a parsed conversation: the same three facts every shape owes, computed once. */
function threadOf(base: Omit<Thread, 'last' | 'turns'>, turns: Turn[]): Conversation {
  const last = turns.length ? turns[turns.length - 1] : null;
  return {
    thread: {
      ...base,
      last: last ? { who: last.who, text: last.text.replace(/\s+/g, ' ').slice(0, THREAD_PREVIEW_CHARS), at: last.at } : null,
      turns: turns.length,
    },
    turns: turns.slice(-THREAD_TURNS_MAX),
  };
}

// ---------- dm: the cabin ----------

/**
 * The owner ↔ CEO thread. One note per exchange in `00 Inbox/`: the owner's message is the body, and the CEO's
 * reply is written back into the same note under `## CEO`, which is why one note can be two turns.
 */
function dmConversation(vault: Vault): Conversation | null {
  const notes = listInbox(vault).filter((n) => n.data.kind === 'message'
    && ((n.data.from === 'owner' && n.data.to === 'ceo') || (n.data.from === 'ceo' && n.data.to === 'owner')));
  if (!notes.length) return null;
  const turns: Turn[] = [];
  for (const n of notes) {
    const [ask, reply] = n.body.split(/^## CEO\s*$/m);
    const text = ask.replace(/^#\s.*$/m, '').trim();
    if (text) turns.push({ who: n.data.from === 'owner' ? 'owner' : 'ceo', at: n.data.created, text });
    if (reply?.trim()) turns.push({ who: 'ceo', at: n.data.created, text: reply.trim() });
  }
  const updated = turns.length ? turns[turns.length - 1].at! : notes[notes.length - 1].data.created;
  return threadOf({ id: DM_THREAD_ID, kind: 'dm', title: 'You and the CEO', participants: ['owner', 'ceo'], updated, open: false }, turns);
}

// ---------- meeting / board: Meetings/*.md ----------

export const MEETINGS_DIR = 'Meetings';

/** `**Round 2 — cto:** …` — the `meeting.open` transcript line, and the shape the board session writes. */
const ROUND_TURN = /\*\*Round (\d+) — ([^:*\n]+):\*\*[ \t]*([\s\S]*?)(?=\n\*\*Round \d+ — |$)/g;

/** The `## Transcript` section only: a meeting note's `## Agenda` and `## Decisions` are not turns. */
function section(body: string, heading: string): string {
  const start = new RegExp(`^${heading}[ \\t]*$`, 'm').exec(body);
  if (!start) return '';
  const rest = body.slice(start.index + start[0].length);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

export function meetingTurns(body: string): Turn[] {
  const out: Turn[] = [];
  for (const m of section(body, '## Transcript').matchAll(ROUND_TURN)) {
    const text = m[3].trim();
    if (text) out.push({ who: m[2].trim(), at: null, text });
  }
  return out;
}

function meetingConversations(vault: Vault): Conversation[] {
  const out: Conversation[] = [];
  for (const rel of vault.list(MEETINGS_DIR, { ext: '.md' })) {
    if (isFurniture(rel)) continue;
    const note = vault.readNoteOrNull(rel);
    if (!note) continue;
    const d = note.data as { id?: unknown; room?: unknown; participants?: unknown; facilitator?: unknown; status?: unknown; decision?: unknown };
    const room = String(d.room ?? 'meeting');
    const id = String(d.id ?? rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, ''));
    const kind: ThreadKind = room === 'board' ? 'board' : 'meeting';
    const participants = Array.isArray(d.participants) ? d.participants.map(String) : [];
    const facilitator = d.facilitator ? String(d.facilitator) : '';
    // A meeting is open until it has a decision on it. The in-progress writes carry `status: in_progress` and
    // the closing write carries `decision:`; either way the absence of a decision is what "still talking" means,
    // and a session killed halfway through is honestly still open.
    const status = String(d.status ?? '');
    const open = !d.decision && status !== 'closed' && status !== 'done';
    out.push(threadOf({
      id: `${kind}:${id}`,
      kind,
      title: (note.body.match(/^#\s+(.+)$/m)?.[1] ?? `${room === 'board' ? 'Board' : 'Meeting'} ${id}`).trim(),
      room,
      participants: participants.length || !facilitator ? participants : [facilitator],
      updated: mtimeOf(vault, rel),
      open,
    }, meetingTurns(note.body)));
  }
  return out;
}

// ---------- pantry: Pantry/*.md ----------

export const PANTRY_CHAT_HEADING = '## Chat';

/** `**Mira Voss:** …` — one speaker per paragraph, by display name, in the shape `pantryNote` writes. */
const PANTRY_TURN = /^\*\*([^:*\n]+):\*\*[ \t]*([\s\S]*?)(?=\n\*\*[^:*\n]+:\*\*|$)/gm;

export function pantryTurns(body: string): Turn[] {
  const out: Turn[] = [];
  for (const m of section(body, PANTRY_CHAT_HEADING).matchAll(PANTRY_TURN)) {
    const text = m[2].trim();
    if (text) out.push({ who: m[1].trim(), at: null, text });
  }
  return out;
}

function pantryConversations(vault: Vault): Conversation[] {
  const out: Conversation[] = [];
  for (const rel of vault.list('Pantry', { ext: '.md' })) {
    if (isFurniture(rel)) continue;
    const note = vault.readNoteOrNull(rel);
    if (!note) continue;
    const file = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, '');
    const d = note.data as { participants?: unknown };
    const participants = Array.isArray(d.participants) ? d.participants.map(String) : [];
    out.push(threadOf({
      id: `pantry:${file}`,
      kind: 'pantry',
      title: (note.body.match(/^#\s+(.+)$/m)?.[1] ?? `Pantry: ${file}`).trim(),
      room: 'pantry',
      participants,
      updated: mtimeOf(vault, rel),
      open: false,
    }, pantryTurns(note.body)));
  }
  return out;
}

// ---------- agents: Messages/<role>.md ----------

/** The section header `colleague.message` writes: `## <ts> from <role> (<kind>) <!-- id:<id> job:<job> -->`. */
const MESSAGE_HEADER = /^## (\S+) from (\S+) \((\w+)\) <!-- id:(\S+?)(?: job:(\S+?))? -->\n([\s\S]*)$/;

/** `agents:<a>+<b>`, the pair sorted, so "cto wrote to dev_manager" and the reverse are the same thread. */
export function agentThreadId(a: string, b: string): string {
  return `agents:${[a, b].sort().join('+')}`;
}

function agentConversations(vault: Vault, org: Org): Conversation[] {
  const byPair = new Map<string, { pair: string[]; turns: Turn[]; updated: string }>();
  for (const rel of vault.list('Messages', { ext: '.md' })) {
    if (isFurniture(rel)) continue;
    const to = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, '');
    const text = vault.readTextOrNull(rel);
    if (!text) continue;
    for (const part of text.split(/\n(?=## )/)) {
      const m = MESSAGE_HEADER.exec(part.replace(/^\n+/, ''));
      if (!m) continue;
      const [, at, from, , , , raw] = m;
      const body = raw.replace(/<!-- read:[^>]*-->/g, '').trim();
      if (!body) continue;
      const key = agentThreadId(from, to);
      const entry = byPair.get(key) ?? { pair: [from, to].sort(), turns: [], updated: at };
      entry.turns.push({ who: from, at, text: body });
      byPair.set(key, entry);
    }
  }
  const out: Conversation[] = [];
  for (const [id, e] of byPair) {
    // One pair, two files: `cto → dev_manager` lands in one note and the reply in the other, so the turns are
    // read out of order and have to be put back by their stamps before anything asks what was said last.
    e.turns.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const updated = e.turns.length ? String(e.turns[e.turns.length - 1].at) : e.updated;
    out.push(threadOf({
      id,
      kind: 'agents',
      title: e.pair.map((r) => displayOf(org, r)).join(' · '),
      participants: e.pair,
      updated,
      open: false,
    }, e.turns));
  }
  return out;
}

// ---------- the index ----------

function allConversations(vault: Vault): Conversation[] {
  const org = loadOrg(vault);
  const dm = dmConversation(vault);
  return [
    ...(dm ? [dm] : []),
    ...meetingConversations(vault),
    ...pantryConversations(vault),
    ...agentConversations(vault, org),
  ].sort((a, b) => b.thread.updated.localeCompare(a.thread.updated));
}

/** Every conversation in the vault, newest first, capped at `CONVERSATIONS_MAX`. */
export function listConversations(vault: Vault): Thread[] {
  return allConversations(vault).slice(0, CONVERSATIONS_MAX).map((c) => c.thread);
}

/**
 * Every turn of one thread, in full. Unlike the index this is not capped: a thread the owner opened is a
 * thread they want to read, and a meeting's whole transcript is a few kilobytes.
 */
export function readConversation(vault: Vault, id: string): Turn[] {
  return allConversations(vault).find((c) => c.thread.id === id)?.turns ?? [];
}
