/**
 * Messages: every conversation the company has, as a messaging app (SP8 §2).
 *
 * The daemon indexes the vault into `Snapshot['conversations']` — the owner↔CEO thread, meetings, board sessions,
 * pantry chats and the colleague messages between two roles — and `conversation.get` fetches one thread's turns in
 * full. Live `meeting.turn` / `agent.spoke` events append to whatever is open. Two panes when the sheet has the
 * room for them (list left, conversation right), stacked when it does not; the composer belongs to the one thread
 * the owner is actually in.
 *
 * Pure: State + the sheet's own small UI state → HTML, so the whole screen is unit-tested without a DOM.
 */
import type { Ctx, View } from './content.js';
import { emptyHtml, esc, fmtTime, who } from './content.js';
import { inline } from './markdown.js';
import { contrastRatio } from './tokens.js';
import { rolePalette, shade } from '../world/palette.js';
import type { Family } from '../world/palette.js';
import { conversationTurns, type State, type Thread, type ThreadTurn } from '../state.js';

/** The owner's own side of a conversation: their bubbles sit on the right. */
export const OWNER = 'owner';
/** The one thread the owner can write in (the cabin's `chat` op is the same channel). */
export const DM_ID = 'dm:owner-ceo';
/** The panel kind: Messages has no map anchor of its own, like `org` and `keys`. */
export const MESSAGES = 'messages';

/**
 * A person's own colour, dark enough for white to read on it.
 *
 * The family palette hands out shirt/ring hues at a fixed lightness, and at that lightness a yellow or a green chip
 * carries white text at 2.8:1. Darkening in the role's own hue keeps the person recognisable — the chip is the same
 * colour as their sprite's ring, one step deeper — and lands every one of them past 4.5:1 in both themes (the
 * chip's ink is `--on-tint`, which is white in dark and light alike).
 */
export function chipTint(role: string, family: Family = 'member'): string {
  let c = rolePalette(role, family).ring;
  for (let i = 0; i < 16 && contrastRatio('#ffffff', c) < 4.5; i++) c = shade(c, -0.06);
  return c;
}

const familyOfRole = (s: State, role: string): Family => s.agents[role]?.family ?? 'member';
/** The display name for a thread participant: a role the office knows, the owner, or the raw string. */
export const nameOf = (s: State, role: string): string => (role === OWNER ? 'You' : who(s, role));

/** "now", "12m", "3h", "yesterday", "4d", then a date. */
export function sinceText(ts: string, now: number = Date.now()): string {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d`;
  return new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** A participant chip: the person's colour behind their name. */
export function participantChip(s: State, role: string): string {
  if (role === OWNER) return `<span class="chip who owner">You</span>`;
  return `<span class="chip who" style="background:${esc(chipTint(role, familyOfRole(s, role)))}">${esc(nameOf(s, role))}</span>`;
}

/** Title and participants, matched case-insensitively; an empty query keeps every thread. */
export function filterThreads(s: State, query: string): Thread[] {
  const q = query.trim().toLowerCase();
  if (!q) return s.conversations;
  return s.conversations.filter((t) => t.title.toLowerCase().includes(q) || t.participants.some((p) => nameOf(s, p).toLowerCase().includes(q) || p.toLowerCase().includes(q)));
}

/** The latest thread for a room in the office, or null: what clicking the board room or the pantry opens. */
export function roomThread(s: State, roomKind: string): Thread | null {
  const room = roomKind === 'boardroom' ? 'board' : roomKind === 'meetingroom' ? 'meeting' : roomKind === 'pantry' ? 'pantry' : null;
  if (!room) return null;
  const match = s.conversations.filter((t) => (t.room ?? t.kind) === room || t.kind === room);
  return match.sort((a, b) => (a.open === b.open ? b.updated.localeCompare(a.updated) : Number(b.open) - Number(a.open)))[0] ?? null;
}

function threadRow(s: State, t: Thread, current: string | null, now: number): string {
  const chips = t.participants.slice(0, 4).map((p) => participantChip(s, p)).join('');
  const more = t.participants.length > 4 ? `<span class="chip who more">+${t.participants.length - 4}</span>` : '';
  const last = t.last ? `${nameOf(s, t.last.who)}: ${t.last.text}` : 'Nothing said yet';
  return `<button class="trow" data-act="thread:${esc(t.id)}" data-key="t-${esc(t.id)}" aria-current="${current === t.id}">`
    + `<span class="top"><span class="tt">${esc(t.title)}</span>${t.open ? '<i class="dot live" aria-label="Live"></i>' : ''}<span class="when">${esc(sinceText(t.updated, now))}</span></span>`
    + `<span class="chips">${chips}${more}</span>`
    + `<span class="last">${esc(last)}</span>`
    + `</button>`;
}

function bubble(s: State, turn: ThreadTurn): string {
  const me = turn.who === OWNER;
  const tint = me ? '' : ` style="background:${esc(chipTint(turn.who, familyOfRole(s, turn.who)))}"`;
  const when = turn.at ? esc(fmtTime(turn.at)) : '';
  return `<div class="msg ${me ? 'me' : 'them'}"><div class="who">${me ? '' : `<i class="dot"${tint}></i>`}<b>${esc(nameOf(s, turn.who))}</b><span>${when}</span></div><div class="bubble">${inline(turn.text)}</div></div>`;
}

/** The right-hand pane: the thread's turns as bubbles, the owner's on the right, plus the composer where there is one. */
export function conversationPane(s: State, id: string | null, now: number): string {
  const t = s.conversations.find((x) => x.id === id) ?? null;
  if (!id || !t) return `<div class="tconv" data-key="tconv">${emptyHtml('chat', 'Pick a conversation', 'Every meeting, message and coffee the company has is kept here.')}</div>`;
  const turns = conversationTurns(s, id);
  const head = `<div class="chead" data-key="chead"><b>${esc(t.title)}</b>${t.open ? '<span class="badge live">LIVE</span>' : ''}<span class="muted">${esc(sinceText(t.updated, now))}</span></div>`
    + `<div class="chips">${t.participants.map((p) => participantChip(s, p)).join('')}</div>`;
  const body = turns.length
    ? `<div class="thread" data-key="thread">${turns.map((x) => bubble(s, x)).join('')}</div>`
    : emptyHtml('chat', t.open ? 'Nobody has spoken yet' : 'Nothing was said', t.open ? 'Turns appear here as they happen.' : undefined);
  const composer = t.id === DM_ID
    ? `<div class="composer" data-key="composer-row"><input data-key="composer" type="text" autocomplete="off" aria-label="Message your CEO" placeholder="Message your CEO" /><button class="btn primary" data-act="send">Send</button></div>`
    : '';
  return `<div class="tconv" data-key="tconv">${head}${body}${composer}</div>`;
}

export interface MessagesUi { thread?: string | null; search?: string }

/** The sheet: the thread list, and the conversation beside it (or under it, when the sheet is narrow). */
export function messagesView(s: State, _ctx: Ctx, ui: MessagesUi = {}): View {
  const now = s.now || Date.now();
  const search = ui.search ?? '';
  const list = filterThreads(s, search);
  const open = list.some((t) => t.id === ui.thread) ? ui.thread! : s.conversations.some((t) => t.id === ui.thread) ? ui.thread! : null;
  const live = s.conversations.filter((t) => t.open).length;
  const rowsHtml = list.length
    ? list.map((t) => threadRow(s, t, open, now)).join('')
    : emptyHtml('chat', s.conversations.length ? 'No conversation matches' : 'No conversations yet', s.conversations.length ? 'Try a name or a subject.' : 'Meetings, messages and pantry chats appear here as they happen.');
  const html = `<div class="panes" data-key="panes">`
    + `<div class="tlist" data-key="tlist"><input class="search" data-key="search" type="search" autocomplete="off" aria-label="Search conversations" placeholder="Search conversations" /><div class="trows">${rowsHtml}</div></div>`
    + conversationPane(s, open, now)
    + `</div>`;
  return {
    mode: 'drawer', wide: true, icon: 'chat', title: 'Messages',
    sub: s.conversations.length ? `${s.conversations.length} conversation${s.conversations.length === 1 ? '' : 's'}${live ? ` · ${live} live` : ''}` : 'nothing yet',
    html, live: true,
  };
}
