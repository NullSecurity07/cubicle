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
import { chip, emptyHtml, esc, fmtWhen, humanTitle, kindLabel, obsidianUrl, row, rows, section, segmented, who } from './content.js';
import { md } from './markdown.js';
import type { DecidedRow, Decidable, DecideState, InboxRow, State } from '../state.js';

/** What the reader says between the click and the dispatcher applying the decision. */
export const APPLYING_TEXT = 'Decided · applying…';

/** A founder brief whose pressure test the board is still arguing: there is nothing to decide yet (ruling P8-6). */
export const BOARD_SITTING = 'The board is arguing the pressure test — decide once it is in';
export const BOARD_SITTING_CHIP = 'board sitting';

/** Why a send back will not go: the company is told no and not why, which it cannot act on. */
export const COMMENT_REQUIRED = 'Say why you are sending it back — the company acts on your comment.';

/** The panel kind a Decisions row opens. */
export const decisionKind = (id: string): string => `decision:${id}`;

/** What the owner is being asked for. A note the daemon has not labelled is a plain yes or no. */
export const decidableOf = (n: Pick<InboxRow, 'decidable' | 'options'>): Decidable => n.decidable ?? (n.options?.length ? 'choose' : 'approve');

/**
 * The verbs of one action bar: the yes and the no. `adopt` is the founder brief's pair.
 *
 * `needsConfirm` changes one word and means one thing (SP9 ruling W3-3): the board ruled `WEAK` or `PIVOT REQUIRED`
 * on this brief, so adopting it is overruling the board and the button says so. "Adopt anyway" is the whole of the
 * second step — it is not a dialog and not a disabled button, because the owner rules and the board advises; it is
 * the difference between a click and a decision.
 */
export function verbsFor(d: Decidable, needsConfirm = false): { yes: string; no: string } {
  if (d !== 'adopt') return { yes: needsConfirm ? 'Approve anyway' : 'Approve', no: 'Reject' };
  return { yes: needsConfirm ? 'Adopt anyway' : 'Adopt brief', no: 'Send back' };
}

/**
 * The board verdicts an owner would be going *against*.
 *
 * A plan the board sent back arrived with a plain Approve/Reject bar and nothing said about the ruling, while a
 * brief the board ruled PIVOT REQUIRED on said so in a sentence. Same fact, two screens: this is the one list.
 */
const BLOCKING = /\b(return(ed)?|pivot|weak|reject(ed)?|block(ed)?|no-?go|fail(ed)?)\b/i;
export const overrulesBoard = (n: Pick<InboxRow, 'needs_confirm' | 'board_verdict' | 'board_pending'>): boolean =>
  !n.board_pending && (!!n.needs_confirm || (!!n.board_verdict && BLOCKING.test(n.board_verdict)));

/** What the bar says about a verdict the owner is about to overrule. Names the verdict; never argues with them. */
export function verdictLine(verdict: string, what = 'brief'): string {
  return `The board ruled ${verdict} on this ${what}. ${what === 'brief' ? 'Adopting' : 'Approving'} it is your call over theirs.`;
}

/** What the note is, in the sentence above the bar: a brief is adopted, everything else is approved. */
const noun = (kind: string): string => (kind === 'founder_brief' ? 'brief' : kind === 'plan_verdict' ? 'plan' : kindLabel(kind).toLowerCase());

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

/** The document inside a proposal's `## Proposed content` fence, or null — the dispatcher's own reader, in the page. */
export function proposedContent(body: string): string | null {
  const m = body.match(/## Proposed content\s*\n+(`{3,})[a-z]*\n([\s\S]*?)\n\1[ \t]*(?:\n|$)/);
  return m ? m[2] : null;
}

/**
 * The dispatcher's own closing line, taken off the note the reader shows (W5-3).
 *
 * `dispatcher.ts` appends `\n\n---\n_Resolved <when>: <outcome>_` — or `_Not applied: <why>_` — so that a note
 * read in Obsidian says what became of it. In the office that sentence is already on the screen: the Approved
 * ribbon carries the same `outcome`, and the action bar carries the same refusal. Dry-run 3 printed both, with
 * the `---` and the underscores showing, so the owner read one decision as two.
 *
 * Anchored to the end of the note and to the dispatcher's two words, so a rule the note drew itself and
 * anything it wrote in italics stay exactly where they are.
 */
const RESOLUTION_FOOTER = /\n+(?:[ \t]*-{3,}[ \t]*\n+)?_(?:Resolved|Not applied)\b[^\n]*_[ \t]*\n*$/;

export function withoutResolutionFooter(body: string): string {
  return body.replace(RESOLUTION_FOOTER, '');
}

/**
 * What the reader shows of a note.
 *
 * A founder brief's proposed content is the document the owner is adopting — the fence is how the note carries it,
 * not what it is — so the covering note is followed by the document itself, as prose. Every other kind keeps its
 * fence: a `file_change` proposes a *file*, and a file is shown as a file, monospace and unwrapped.
 */
export function readerBody(n: Pick<InboxRow, 'kind' | 'body' | 'options'>): string {
  const body = withoutFileInstructions(withoutResolutionFooter(n.body ?? ''), !!n.options?.length);
  if (n.kind === 'plan_verdict') return planFirst(body);
  if (n.kind !== 'founder_brief') return body;
  const doc = proposedContent(body);
  if (!doc) return body;
  const covering = body.split(/^## Proposed content\s*$/m)[0].trim();
  return covering ? `${covering}\n\n${doc}` : doc;
}

/**
 * Lines that tell the owner to go and edit the note's frontmatter, taken out.
 *
 * "Set `chosen: 1|2|3` and `approved: true`" was printed beside three clickable cards and an Approve button: the
 * reader was showing the instructions for a screen it had replaced. The same reader then listed the three options
 * as prose above the cards, so the owner read every idea twice.
 */
export function withoutFileInstructions(body: string, hasOptions: boolean): string {
  const lines = body.split('\n').filter((l) => !/^\s*[-*>]?\s*(set|edit|change|write)\b[^\n]*\b(chosen|approved|decision|status)\s*:/i.test(l));
  if (!hasOptions) return lines.join('\n');
  // With cards on the screen, the note's own numbered list of the same options is the second telling of it.
  const out: string[] = [];
  let run = 0;
  for (const l of lines) {
    const isOption = /^\s*(\d+[.)]|[-*]\s*\d+[.)])\s+\S/.test(l);
    if (isOption) { run += 1; continue; }
    if (run >= 2 && !l.trim()) continue;      // the blank line the list left behind
    run = 0;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The plan the owner is approving, first.
 *
 * A plan verdict opens on the board's four findings and clips "## The plan" — the objectives being decided — at
 * the bottom edge of the reader. What is being approved goes above what was said about it.
 */
export function planFirst(body: string): string {
  const m = /^##+\s*The plan\s*$/im.exec(body);
  if (!m) return body;
  const head = body.slice(0, m.index).trim();
  const plan = body.slice(m.index).trim();
  return head ? `${plan}\n\n${head}` : plan;
}

const bandChip = (n: InboxRow): string => (n.band ? chip('band', n.band) : '');

/**
 * What the bar should say about a row, from the note itself and from whatever this session has just sent.
 *
 * The note is the truth the owner can reload into: a decided-but-unresolved row comes back `pending`, and one the
 * dispatcher would not apply comes back `refused` (SP8 ruling P8-8). This session's own state only outranks it
 * while a click is still in flight — before the daemon has written anything, there is nothing on the note to read.
 */
export function decideStateFor(n: InboxRow, local?: DecideState): DecideState | undefined {
  // First of all: while the board is still sitting there is nothing to decide, so the bar stays shut whatever
  // else the note or this session says about it.
  if (n.board_pending) return { status: 'applying', approved: false, message: BOARD_SITTING };
  if (local?.status === 'sending') return local;
  if (n.refused) return { status: 'error', approved: n.approved ?? false, chosen: n.chosen, message: n.refused };
  if (n.pending) return { status: 'applying', approved: n.approved ?? true, chosen: n.chosen };
  return local;
}

/** The trailing chip on a *Needs you* row: nothing, unless the row is mid-flight or was refused. */
export const rowStateChip = (n: InboxRow): string => (n.board_pending ? chip('sitting', BOARD_SITTING_CHIP) : n.refused ? chip('failed', 'refused') : n.pending ? chip('applying', 'applying') : '');

/** One row in *Needs you*. */
export function needsRow(n: InboxRow, s: State): string {
  const small = [n.from ? who(s, n.from) : '', n.band_reason || n.board_verdict || n.target || ''].filter(Boolean).join(' · ');
  // A refused row says why on its own second line: it is the one thing the owner has to read before deciding again.
  const line = n.board_pending ? BOARD_SITTING : n.refused ? `Refused: ${n.refused}` : n.pending ? 'Decided, being applied' : small || n.path.replace(/^00 Inbox\//, '');
  return row({ left: chip('note', kindLabel(n.kind)), title: humanTitle(n.title), small: line, right: esc(fmtWhen(n.created)), open: decisionKind(n.id), actions: rowStateChip(n) || undefined });
}

/** One row in *Decided*: what you said, and what the company did with it. */
export function decidedRow(d: DecidedRow): string {
  return row({ left: d.approved ? chip('done', 'Approved') : chip('failed', 'Rejected'), title: humanTitle(d.title), small: d.outcome || kindLabel(d.kind), right: esc(fmtWhen(d.resolved_at || d.created)), open: decisionKind(d.id) });
}

/**
 * The mail log, minus what is already a row on this screen.
 *
 * "approval needed: Keep, park or scrap …" is the same decision as the row above it, and the office listed both:
 * one screen saying the same thing twice reads as two things waiting. A line about something that is *not* on
 * this screen — a note sent, a message delivered — is the log's own job and stays.
 */
export function mailWithoutRows<T extends { text: string }>(mail: T[], titles: string[]): T[] {
  const seen = titles.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 8);
  if (!seen.length) return mail;
  return mail.filter((m) => { const t = m.text.toLowerCase(); return !seen.some((x) => t.includes(x)); });
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
  const mailRows = mailWithoutRows(s.mail, [...s.inbox.map((n) => n.title), ...s.decided.map((d) => d.title)]);
  const mail = mailRows.length ? section('Mail', rows(mailRows.slice(-20).reverse().map((m) => row({ title: m.text, right: esc(fmtWhen(m.ts)) })))) : '';
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
  // A brief the board is still arguing has no verdict to overrule yet, whatever its draft section happens to say
  // (ruling P8-6): the bar is shut, it says the board is sitting, and it must not also promise a ruling nobody
  // has made. So `needs_confirm` only speaks once the argument is in.
  const confirming = overrulesBoard(n);
  const v = verbsFor(d, confirming);
  const st = o.st;
  const busy = st?.status === 'sending' || st?.status === 'applying';
  const done = st?.status === 'done';
  const line = done ? esc(st.outcome || (st.approved ? 'Approved.' : 'Rejected.')) : busy ? esc(st.message ?? '') || APPLYING_TEXT : st?.status === 'error' ? esc(st.message ?? 'The daemon could not record that.') : '';
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
  // Above the buttons, so it is read before the click and not after it: the verdict the owner is about to overrule.
  const said = n.verdict || n.board_verdict || '';
  const verdict = confirming && said ? `<p class="hintline" data-key="verdict">${esc(verdictLine(said, noun(n.kind)))}</p>` : '';
  return `<div class="actionbar" data-key="actionbar">${opts}${verdict}${state}<div class="acts">${comment}${no}${yes}</div></div>`;
}

/** One decision, open: the note as written, the board's pressure test when there is one, and the action bar. */
export function decisionView(id: string, s: State, ctx: Ctx, ui: { choice?: Record<string, number> } = {}): View {
  const n = s.inbox.find((x) => x.id === id);
  const done = s.decided.find((x) => x.id === id);
  if (!n && !done) return { mode: 'doc', title: 'Decision', html: emptyHtml('envelope', 'This decision is not in the current snapshot.', 'It may have been decided already.') };
  const path = n?.path ?? done!.path;
  const link = obsidianUrl(ctx.vaultName, path);
  if (!n) {
    // A ribbon over the note, not instead of it: the owner has just adopted a brief and the first thing they do
    // is read what they adopted. Approving used to replace the whole document with a two-line card.
    const d = done!;
    const ribbon = `<p class="ribbon ${d.approved ? 'ok' : 'no'}">${d.approved ? chip('done', 'Approved') : chip('failed', 'Rejected')}`
      + `<span class="muted">${esc(kindLabel(d.kind))} · ${esc(fmtWhen(d.resolved_at || d.created))}</span>`
      + `<b>${esc(d.outcome || 'Recorded.')}</b></p>`;
    const shownBody = readerBody(d);
    const kept = shownBody ? `<div class="prose">${md(shownBody)}</div>` : `<p class="muted">The note carries no body. Open it in Obsidian to read it in full.</p>`;
    return { mode: 'doc', icon: 'envelope', title: humanTitle(d.title), sub: path, html: ribbon + kept, link, copy: d.body ?? '' };
  }
  const st = decideStateFor(n, s.decisions[id]);
  const head = `<p>${chip('note', kindLabel(n.kind))} ${bandChip(n)} <span class="muted">${esc([n.from ? who(s, n.from) : '', fmtWhen(n.created)].filter(Boolean).join(' · '))}</span></p>`;
  const why = n.band_reason ? `<p class="hintline">${esc(n.band_reason)}</p>` : '';
  const shown = readerBody(n);
  const body = shown ? `<div class="prose">${md(shown)}</div>` : `<p class="muted">The note carries no body. Open it in Obsidian to read it in full.</p>`;
  // The section titles the block, so the block's own `## Pressure test` heading would be the same words twice —
  // and a brief that carries the test inside the document it proposes does not need it printed a second time.
  const pressureBody = (n.pressure ?? '').replace(/^\s*#{1,3}\s*pressure test\s*\n+/i, '');
  const inBody = /^\s*#{1,3}\s*pressure test\s*$/im.test(shown);
  const pressure = !inBody && pressureBody.trim() ? section('Pressure test', `<div class="prose">${md(pressureBody)}</div>`) : '';
  const verdict = n.board_verdict ? `<p class="hintline">The board: ${esc(n.board_verdict)}</p>` : '';
  return {
    mode: 'doc', icon: 'envelope', title: humanTitle(n.title), sub: path, link,
    html: head + why + body + pressure + verdict + actionBar(n, { chosen: ui.choice?.[id] ?? n.chosen, st }),
    copy: n.body ?? '',
  };
}
