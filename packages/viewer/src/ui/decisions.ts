/**
 * Decisions: the post office's sheet, and the reader the owner approves things in (SP8 §1).
 *
 * Before SP8 the sheet listed what was waiting and told the owner to go and edit frontmatter in Obsidian — and the
 * "Open" link blanked the office window. Now a row opens a reader with the note's own body, the board's pressure
 * test where there is one, and one fixed action bar per `decidable`: approve/reject with a comment, numbered
 * options, or adopt/send back. The click sends the `decide` op; the reader says "Decided · applying…" until the
 * dispatcher's `proposal.resolved` comes back, then shows the outcome and the row moves to Decided.
 *
 * Pure: every builder here is State → HTML, so the whole screen is unit-tested without a DOM.
 */
import type { Ctx, View } from './content.js';
import { chip, emptyHtml, esc, fmtWhen, kindLabel, obsidianUrl, row, rows, section, segmented, who } from './content.js';
import { md } from './markdown.js';
import type { DecidedRow, Decidable, DecideState, InboxRow, State } from '../state.js';

/** What the reader says between the click and the dispatcher applying the decision. */
export const APPLYING_TEXT = 'Decided · applying…';

/** Why a send back will not go: the company is told no and not why, which it cannot act on. */
export const COMMENT_REQUIRED = 'Say why you are sending it back — the company acts on your comment.';

/** The panel kind a Decisions row opens. */
export const decisionKind = (id: string): string => `decision:${id}`;

/** What the owner is being asked for. A note the daemon has not labelled is a plain yes or no. */
export const decidableOf = (n: Pick<InboxRow, 'decidable' | 'options'>): Decidable => n.decidable ?? (n.options?.length ? 'choose' : 'approve');

/** The verbs of one action bar: the yes and the no. `adopt` is the founder brief's pair. */
export function verbsFor(d: Decidable): { yes: string; no: string } {
  return d === 'adopt' ? { yes: 'Adopt brief', no: 'Send back' } : { yes: 'Approve', no: 'Reject' };
}

/** A send back with no comment is a dead end for the company: it is told no and not why. */
export const commentRequired = (d: Decidable, approved: boolean): boolean => d === 'adopt' && !approved;

/**
 * The keyboard, while a decision reader is open: `A` the yes, `R` the no, `1`–`9` an option.
 * Pure so the table is tested rather than driven; `typing` is the owner in the comment field.
 */
export function decisionKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }, o: { decidable: Decidable; options: number }, typing: boolean): { act: 'yes' } | { act: 'no' } | { act: 'choose'; n: number } | null {
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (k === 'a') return { act: 'yes' };
  if (k === 'r') return { act: 'no' };
  if (o.decidable === 'choose' && /^[1-9]$/.test(k)) { const n = Number(k); return n <= o.options ? { act: 'choose', n } : null; }
  return null;
}

const bandChip = (n: InboxRow): string => (n.band ? chip('kind', n.band) : '');

/** One row in *Needs you*. */
export function needsRow(n: InboxRow, s: State): string {
  const small = [n.from ? who(s, n.from) : '', n.band_reason || n.board_verdict || n.target || ''].filter(Boolean).join(' · ');
  return row({ left: chip('kind', kindLabel(n.kind)), title: n.title, small: small || n.path.replace(/^00 Inbox\//, ''), right: esc(fmtWhen(n.created)), open: decisionKind(n.id) });
}

/** One row in *Decided*: what you said, and what the company did with it. */
export function decidedRow(d: DecidedRow): string {
  return row({ left: d.approved ? chip('done', 'Approved') : chip('failed', 'Rejected'), title: d.title, small: d.outcome || kindLabel(d.kind), right: esc(fmtWhen(d.resolved_at || d.created)), open: decisionKind(d.id) });
}

/** The sheet: what needs the owner, then what they have already decided. */
export function decisionsView(s: State): View {
  const needs = s.inbox.length
    ? rows(s.inbox.map((n) => needsRow(n, s)))
    : emptyHtml('envelope', 'Nothing needs you', 'Whatever the company wants your yes or no on lands here.');
  const decided = s.decided.length
    ? rows(s.decided.map(decidedRow))
    : emptyHtml('clipboard', 'Nothing decided yet', 'Your approvals and rejections are kept here with what came of them.');
  // The mail log keeps its place under the segments rather than losing its only screen: it is a record of what the
  // company sent, not something anyone has to decide. Absent — which is the usual case — it takes no room at all.
  const mail = s.mail.length ? section('Mail', rows(s.mail.slice(-20).reverse().map((m) => row({ title: m.text, right: esc(fmtWhen(m.ts)) })))) : '';
  return {
    mode: 'drawer', icon: 'envelope', title: 'Decisions',
    sub: s.inbox.length ? `${s.inbox.length} need${s.inbox.length === 1 ? 's' : ''} you` : 'nothing needs you',
    html: segmented([
      { id: 'needs', label: 'Needs you', count: s.inbox.length, html: needs },
      { id: 'decided', label: 'Decided', count: s.decided.length, html: decided },
    ]) + mail,
  };
}

const optionChip = (o: { n: number; label: string }, chosen: number | undefined): string =>
  `<button class="opt" data-act="choose:${o.n}" aria-pressed="${chosen === o.n}"><span class="n">${o.n}</span><span class="l">${esc(o.label)}</span></button>`;

/**
 * The fixed bar at the foot of the reader. One shape per `decidable`, one amber affirmative in each, and the state
 * line above it is the live region: the owner hears "Decided · applying…" and then the outcome without moving focus.
 */
export function actionBar(n: InboxRow, o: { chosen?: number; st?: DecideState }): string {
  const d = decidableOf(n);
  const v = verbsFor(d);
  const st = o.st;
  const busy = st?.status === 'sending' || st?.status === 'applying';
  const done = st?.status === 'done';
  const line = done ? esc(st.outcome || (st.approved ? 'Approved.' : 'Rejected.')) : busy ? APPLYING_TEXT : st?.status === 'error' ? esc(st.message ?? 'The daemon could not record that.') : '';
  const state = `<p class="state${st?.status === 'error' ? ' bad' : ''}" data-key="state" role="status" aria-live="polite">${line}</p>`;
  if (done) return `<div class="actionbar" data-key="actionbar">${state}</div>`;
  const dis = busy ? ' disabled' : '';
  const opts = d === 'choose' && n.options?.length
    ? `<div class="opts" data-key="opts" role="group" aria-label="Options">${n.options.map((x) => optionChip(x, o.chosen)).join('')}</div>`
    : '';
  const comment = d === 'choose' ? '' : `<input class="comment" data-key="comment" type="text" autocomplete="off" aria-label="${d === 'adopt' ? 'Why you are sending it back' : 'A comment for the company'}" placeholder="${d === 'adopt' ? 'Why are you sending it back?' : 'Add a comment (optional)'}"${dis} />`;
  const yesOff = dis || (d === 'choose' && !o.chosen ? ' disabled' : '');
  const yes = `<button class="btn primary" data-act="decide:yes"${yesOff}>${esc(v.yes)}<kbd>A</kbd></button>`;
  const no = `<button class="btn" data-act="decide:no"${dis}>${esc(v.no)}<kbd>R</kbd></button>`;
  return `<div class="actionbar" data-key="actionbar">${opts}${state}<div class="acts">${comment}${no}${yes}</div></div>`;
}

/** One decision, open: the note as written, the board's pressure test when there is one, and the action bar. */
export function decisionView(id: string, s: State, ctx: Ctx, ui: { choice?: Record<string, number> } = {}): View {
  const n = s.inbox.find((x) => x.id === id);
  const done = s.decided.find((x) => x.id === id);
  if (!n && !done) return { mode: 'doc', title: 'Decision', html: emptyHtml('envelope', 'This decision is not in the current snapshot.', 'It may have been decided already.') };
  const path = n?.path ?? done!.path;
  const link = obsidianUrl(ctx.vaultName, path);
  if (!n) {
    const body = `<p>${done!.approved ? chip('done', 'Approved') : chip('failed', 'Rejected')} <span class="muted">${esc(kindLabel(done!.kind))} · ${esc(fmtWhen(done!.resolved_at || done!.created))}</span></p>`
      + `<p class="hintline">${esc(done!.outcome || 'Recorded.')}</p>`;
    return { mode: 'doc', icon: 'envelope', title: done!.title, sub: path, html: body, link };
  }
  const st = s.decisions[id];
  const head = `<p>${chip('kind', kindLabel(n.kind))} ${bandChip(n)} <span class="muted">${esc([n.from ? who(s, n.from) : '', fmtWhen(n.created)].filter(Boolean).join(' · '))}</span></p>`;
  const why = n.band_reason ? `<p class="hintline">${esc(n.band_reason)}</p>` : '';
  const body = n.body ? `<div class="prose">${md(n.body)}</div>` : `<p class="muted">The note carries no body. Open it in Obsidian to read it in full.</p>`;
  const pressure = n.pressure ? section('Pressure test', `<div class="prose">${md(n.pressure)}</div>`) : '';
  const verdict = n.board_verdict ? `<p class="hintline">The board: ${esc(n.board_verdict)}</p>` : '';
  return {
    mode: 'doc', icon: 'envelope', title: n.title, sub: path, link,
    html: head + why + body + pressure + verdict + actionBar(n, { chosen: ui.choice?.[id], st }),
    copy: n.body ?? '',
  };
}
