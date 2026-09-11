/**
 * The board room as the office sees it, from the two meeting events `runBoardSession` emits. Event-only and
 * never in the WebSocket snapshot (spec §6.2): a viewer that connects after the session ended sees the plan,
 * which is right — the board room is a live moment, and the durable record is the `Decisions/` note and the
 * idea card. A snapshot field would have the office claiming a meeting is in progress after a restart.
 */
import type { Headline } from './headlines.js';
import { cut } from './headlines.js';

export interface BoardState { id: string; subject: 'plan' | 'idea'; title: string; verdict: 'pass' | 'return' | null; findings: string[]; at: string }

/** How long a closed verdict holds the whiteboard before it goes back to showing the plan. */
export const BOARD_HEADLINE_MS = 30 * 60_000;

/** `meeting.opened` in the board room starts a session; any other room leaves the board alone. */
export function boardOpened(p: Record<string, unknown>, ts: string): BoardState | null {
  if (String(p.room ?? '') !== 'board') return null;
  return { id: String(p.id ?? ''), subject: p.subject === 'idea' ? 'idea' : 'plan', title: String(p.title ?? p.agenda ?? ''), verdict: null, findings: [], at: ts };
}

/** `meeting.closed` for the session the board is holding; a stale id (a meeting that outlived a reconnect) is ignored. */
export function boardClosed(cur: BoardState | null, p: Record<string, unknown>, ts: string): BoardState | null {
  if (!cur || cur.id !== String(p.id ?? '')) return cur;
  return { ...cur, verdict: p.verdict === 'return' ? 'return' : 'pass', findings: Array.isArray(p.findings) ? p.findings.map(String).slice(0, 3) : [], at: ts };
}

/**
 * What the whiteboard says when the board is sitting, or has just ruled. Null means "nothing board-related to
 * show" and the whiteboard falls back to the plan, which is what it showed before SP3.
 */
export function boardHeadline(b: BoardState | null, now: number): Headline | null {
  if (!b) return null;
  if (!b.verdict) return { head: 'The board is sitting', lines: [cut(b.title, 40)], short: 'Board' };
  if (now - Date.parse(b.at) > BOARD_HEADLINE_MS) return null;
  const verb = b.verdict === 'pass' ? 'passed' : 'returned';
  const head = b.subject === 'plan' ? `The board ${verb} the plan` : `The board ${verb}: ${b.title}`;
  return { head: cut(head, 44), lines: b.findings.slice(0, 3).map((f) => '• ' + cut(f, 40)), short: b.verdict };
}
