/**
 * The pantry as the office sees it, from the three meeting events `runPantryChat` emits. Event-only and never in
 * the WebSocket snapshot, for the reason the board room is (tower design §6.2): a viewer that reconnects after
 * the chat ended must not be told a conversation is in progress.
 */

export interface PantryTurnView { role: string; text: string }
export interface PantryState {
  id: string; participants: string[]; turns: PantryTurnView[];
  /** The idea a card was filed from, or null. */ idea: string | null;
  /** Why an idea the chat did have was *not* filed (ruling Q12), or null. Never set beside `idea`. */ notFiled: string | null;
  note: string | null; open: boolean; at: string;
}

/**
 * How long an *open* chat may sit in the pantry before the office stops believing in it. `runPantryChat` emits
 * `meeting.opened`, awaits at most six cheap calls, then emits `meeting.closed` — a kill in that window leaves
 * the close unemitted, and with no timeout two people would stand at the counter all day.
 */
export const PANTRY_SESSION_MAX_MS = 10 * 60_000;
/** How long a finished chat stays readable from the room. An owner who opens the pantry a minute later should see it. */
export const PANTRY_SHOWN_MS = 30 * 60_000;
/** The in-world budget for one line of transcript in the panel. */
export const PANTRY_TURN_CHARS = 120;
/** The chat's own ceiling (`PANTRY_MAX_TURNS` in core): the panel never shows more turns than one can have. */
export const PANTRY_MAX_SHOWN_TURNS = 6;

/** `meeting.opened` in the pantry starts a chat; any other room leaves the pantry alone. */
export function pantryOpened(p: Record<string, unknown>, ts: string): PantryState | null {
  if (String(p.room ?? '') !== 'pantry') return null;
  const participants = Array.isArray(p.participants) ? p.participants.map(String).slice(0, 2) : [];
  return { id: String(p.id ?? ''), participants, turns: [], idea: null, notFiled: null, note: null, open: true, at: ts };
}

/** A turn in the chat the pantry is showing. A turn from any other meeting leaves it alone. */
export function pantryTurn(cur: PantryState | null, agent: string | null | undefined, p: Record<string, unknown>, ts: string): PantryState | null {
  if (!cur || !cur.open || cur.id !== String(p.id ?? '')) return cur;
  const text = String(p.text ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
  if (!text) return cur;
  return { ...cur, turns: [...cur.turns, { role: String(agent ?? ''), text }].slice(-PANTRY_MAX_SHOWN_TURNS), at: ts };
}

/**
 * `meeting.closed` for the chat the pantry is showing. A close for a *different* pantry chat clears the panel
 * rather than being ignored, on the board room's reasoning: the only way one arrives is that the chat being shown
 * never closed, so showing it beside a pantry that has demonstrably moved on is the one reading that cannot be true.
 *
 * The idea is read off the close's `decision`, which `runPantryChat` writes as `IDEA: <the idea>` when a card was
 * filed, `IDEA not filed: <why>` when the rule refused it, and `no idea` when the chat produced none (ruling Q12).
 * The refusal keeps its reason, so the panel can say why nothing was filed instead of implying nothing was said.
 */
export function pantryClosed(cur: PantryState | null, p: Record<string, unknown>, ts: string): PantryState | null {
  if (!cur) return cur;
  if (cur.id !== String(p.id ?? '')) return String(p.room ?? '') === 'pantry' ? null : cur;
  const decision = String(p.decision ?? '');
  const refused = /^\s*IDEA not filed:\s*(.+)$/i.exec(decision);
  const m = refused ? null : /IDEA:\s*(.+)$/i.exec(decision);
  return { ...cur, open: false, idea: m ? m[1].trim() : null, notFiled: refused ? refused[1].trim() : null, note: String(p.path ?? '') || null, at: ts };
}

/** Past its window: an open chat nobody closed, or a finished one the room has shown for long enough. */
export function pantryStale(cur: PantryState | null, now: number): boolean {
  if (!cur) return true;
  return now - Date.parse(cur.at) > (cur.open ? PANTRY_SESSION_MAX_MS : PANTRY_SHOWN_MS);
}
