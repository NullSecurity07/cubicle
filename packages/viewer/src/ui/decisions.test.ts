import { describe, it, expect } from 'vitest';
import { applySnapshot, emptyState, decideSent, decideAcked, decideFailed, type Snapshot, type InboxRow } from '../state.js';
import { viewFor } from './surfaces.js';
import { APPLYING_TEXT, BOARD_SITTING, BOARD_SITTING_CHIP, COMMENT_REQUIRED, actionBar, commentRequired, decidableOf, decideStateFor, decisionKey, decisionsView, mailWithoutRows, overrulesBoard, planFirst, proposedContent, readerBody, rowStateChip, verbsFor, withoutFileInstructions } from './decisions.js';
import { THEMES, contrastRatio } from './tokens.js';
import type { Ctx } from './content.js';

const ctx: Ctx = { frames: {}, tokenQuery: '', vaultName: 'Cubicle' };
const base: Snapshot = { op: 'snapshot', at: 'now', roles: [{ role: 'ceo', display: 'CEO', sprite: 'ceo', desk: 'ceo', active: true }], jobs: [], surfaces: [], quota: [], latestRun: null, plan: '', pendingProposals: 0 };

const approveRow: InboxRow = { id: 'p1', kind: 'spend', title: 'Pay for the domain', path: '00 Inbox/2026-09-13-spend.md', created: '2026-09-13T09:00:00.000Z', from: 'cfo', body: '# Pay for the domain\n\nUSD 12 a year.\n', band: 'small', band_reason: 'under the cap', decidable: 'approve' };
const chooseRow: InboxRow = { id: 'p2', kind: 'brand_change', title: 'Name the company', path: '00 Inbox/2026-09-13-brand.md', created: '2026-09-13T09:05:00.000Z', from: 'ceo', body: '# Three names\n', options: [{ n: 1, label: 'WeekPlate' }, { n: 2, label: 'PlateReady' }, { n: 3, label: 'Sunday Prep' }], decidable: 'choose' };
const adoptRow: InboxRow = { id: 'p3', kind: 'founder_brief', title: 'The founder brief', path: '00 Inbox/2026-09-13-brief.md', created: '2026-09-13T09:10:00.000Z', from: 'ceo', body: '# Brief\n\nWhat we are building.\n', pressure: '## Pressure test\n- Who wants this?\n', board_verdict: 'promising', decidable: 'adopt' };
const snap = (o: Partial<Snapshot>): Snapshot => ({ ...base, ...o });

describe('the Decisions sheet (SP8 §1)', () => {
  const s = applySnapshot(emptyState(), snap({ inbox: [approveRow, chooseRow], decided: [{ id: 'p0', kind: 'idea_verdict', title: 'Meal plans for busy parents', path: '00 Inbox/2026-09-12-idea.md', created: '2026-09-12T10:00:00.000Z', resolved_at: '2026-09-12T11:00:00.000Z', approved: true, outcome: 'the board decided: build it' }] }));

  it('is what the post office opens: Needs you and Decided, and every row opens a reader', () => {
    const v = viewFor('postoffice', s, ctx);
    expect(v.title).toBe('Decisions');
    expect(v.sub).toBe('2 need you');
    expect(v.html).toContain('data-seg="needs"');
    expect(v.html).toContain('data-seg="decided"');
    expect(v.html).toContain('data-open="decision:p1"');
    expect(v.html).toContain('data-open="decision:p0"');
    expect(v.html).toContain('the board decided: build it');
  });

  it('says what is missing rather than nothing at all', () => {
    const v = decisionsView(emptyState());
    expect(v.html).toContain('Nothing needs you');
    expect(v.html).toContain('Nothing decided yet');
    expect(v.sub).toBe('nothing needs you');
  });

  it('keeps the mail log, and takes no room when there is none', () => {
    expect(decisionsView(emptyState()).html).not.toContain('Mail');
    const withMail = { ...emptyState(), mail: [{ ts: '2026-09-13T09:00:00.000Z', text: '→ hello@example.com: Hello' }] };
    expect(decisionsView(withMail).html).toContain('hello@example.com');
  });
});

describe('the decision reader and its action bar', () => {
  const s = applySnapshot(emptyState(), snap({ inbox: [approveRow, chooseRow, adoptRow] }));

  it('renders the note body, the pressure test and the board verdict', () => {
    const v = viewFor('decision:p3', s, ctx);
    expect(v.mode).toBe('doc');
    expect(v.title).toBe('The founder brief');
    expect(v.html).toContain('What we are building.');
    expect(v.html).toContain('Pressure test');
    expect((v.html.match(/Pressure test/g) ?? []).length).toBe(1);   // the section titles it; the block’s own heading is dropped
    expect(v.html).toContain('Who wants this?');
    expect(v.html).toContain('The board: promising');
    expect(v.link).toContain('obsidian://open?vault=Cubicle');
  });

  it('spends amber on the one action, not on the facts about the note', () => {
    // `chip kind` is the accent-text chip; on this screen the kind and the band are neutral, and the only amber
    // left is the primary button (and the top bar's pill, which is not this view's).
    const reader = viewFor('decision:p1', s, ctx).html;
    expect(reader).not.toContain('chip kind');
    expect(reader).toContain('chip note');
    expect(reader).toContain('chip band');
    expect(reader).toContain('class="btn primary"');
    expect(decisionsView(s).html).not.toContain('chip kind');
  });

  it('reads a founder brief as the document it is, and a file change as the file it is', () => {
    const FENCE = '`'.repeat(4);
    // The `## Proposed content` fence is how a note carries the document; for the brief it *is* the document, and
    // the owner is adopting it. A file change proposes a file, so its fence stays a fence.
    const doc = '# Founder brief\n\n## What the company is\nMeal plans.\n\n## Pressure test\nWho pays?\n';
    const note: InboxRow = { id: 'pb', kind: 'founder_brief', title: 'The founder brief', path: '00 Inbox/b.md', created: 'now', decidable: 'adopt', pressure: '## Pressure test\nWho pays?\n', body: `The board has finished with it.\n\n## Proposed content\n\n${FENCE}\n${doc}${FENCE}\n` };
    expect(proposedContent(note.body!)).toBe(doc.replace(/\n$/, ''));
    const shown = readerBody(note);
    expect(shown).toContain('The board has finished with it.');
    expect(shown).toContain('## What the company is');
    expect(shown).not.toContain(FENCE);
    const s2 = applySnapshot(emptyState(), snap({ inbox: [note] }));
    const html = viewFor('decision:pb', s2, ctx).html;
    expect(html).toContain('<h3>What the company is</h3>');   // rendered as the document, not as a code listing
    expect(html).not.toContain('<pre>');
    expect((html.match(/Pressure test/g) ?? []).length).toBe(1);   // the brief carries it, so no second section
    const file: InboxRow = { ...note, id: 'pf', kind: 'file_change', body: `Write the note.\n\n## Proposed content\n\n${FENCE}\n# Overlay demo\n${FENCE}\n`, pressure: undefined };
    expect(readerBody(file)).toContain(FENCE);
  });

  it('has one shape per decidable: approve, numbered options, adopt or send back', () => {
    expect(decidableOf(approveRow)).toBe('approve');
    expect(decidableOf({ ...chooseRow, decidable: undefined })).toBe('choose');   // options alone imply the choice
    expect(verbsFor('adopt')).toEqual({ yes: 'Adopt brief', no: 'Send back' });
    const approve = viewFor('decision:p1', s, ctx).html;
    expect(approve).toContain('data-act="decide:yes"');
    expect(approve).toContain('data-act="decide:no"');
    expect(approve).toContain('data-key="comment"');
    expect(approve).toContain('>Approve<');
    const choose = viewFor('decision:p2', s, ctx).html;
    expect(choose).toContain('data-act="choose:1"');
    expect(choose).toContain('data-act="choose:3"');
    expect(choose).not.toContain('data-key="comment"');   // a choice is not a comment
    const adopt = viewFor('decision:p3', s, ctx).html;
    expect(adopt).toContain('Adopt brief');
    expect(adopt).toContain('Send back');
  });

  it('follows the daemon on what is being asked, never the presence of options (T1 contract)', () => {
    // An `idea_verdict` carries the fixed keep / park / scrap table; a `brand_change` with one proposed name is a
    // plain yes or no even though the note may still list something numbered.
    const verdict: InboxRow = { id: 'p4', kind: 'idea_verdict', title: 'Meal plans for busy parents', path: '00 Inbox/x.md', created: 'now', decidable: 'choose', options: [{ n: 1, label: 'keep' }, { n: 2, label: 'park' }, { n: 3, label: 'scrap' }] };
    const bar = actionBar(verdict, { chosen: 2 });
    for (const label of ['keep', 'park', 'scrap']) expect(bar).toContain(label);
    expect(bar).toContain('data-act="choose:2" aria-pressed="true"');
    const single: InboxRow = { id: 'p5', kind: 'brand_change', title: 'Name the company: WeekPlate', path: '00 Inbox/y.md', created: 'now', decidable: 'approve', options: [{ n: 1, label: 'WeekPlate' }] };
    expect(decidableOf(single)).toBe('approve');
    expect(actionBar(single, {})).not.toContain('data-act="choose:1"');
    expect(actionBar(single, {})).toContain('data-key="comment"');
  });

  it('will not approve a choice until one is picked, and paints the picked chip with the accent', () => {
    const none = actionBar(chooseRow, {});
    expect(none).toMatch(/data-act="decide:yes"[^>]*disabled/);
    const picked = actionBar(chooseRow, { chosen: 2 });
    expect(picked).toContain('data-act="choose:2" aria-pressed="true"');
    expect(picked).not.toMatch(/data-act="decide:yes"[^>]*disabled/);
  });

  it('a send back needs a reason; an approval does not', () => {
    expect(commentRequired('adopt', false)).toBe(true);
    expect(commentRequired('adopt', true)).toBe(false);
    expect(commentRequired('approve', false)).toBe(false);
    expect(COMMENT_REQUIRED.length).toBeGreaterThan(10);
  });

  it('says "Decided · applying…" until the dispatcher answers, then the outcome', () => {
    let st = decideSent(applySnapshot(emptyState(), snap({ inbox: [approveRow] })), 'p1', { approved: true });
    expect(viewFor('decision:p1', st, ctx).html).toContain(APPLYING_TEXT);
    expect(viewFor('decision:p1', st, ctx).html).toMatch(/data-act="decide:yes"[^>]*disabled/);
    st = decideAcked(st, 'p1');
    expect(st.decisions.p1.status).toBe('applying');
    expect(viewFor('decision:p1', st, ctx).html).toContain(APPLYING_TEXT);
    const bar = actionBar(approveRow, { st: { status: 'done', approved: true, outcome: 'paid and recorded' } });
    expect(bar).toContain('paid and recorded');
    expect(bar).not.toContain('data-act="decide:yes"');   // nothing left to press
  });

  it('shows a refusal in the bar rather than swallowing it', () => {
    const st = decideFailed(applySnapshot(emptyState(), snap({ inbox: [approveRow] })), 'p1', 'already resolved');
    const html = viewFor('decision:p1', st, ctx).html;
    expect(html).toContain('already resolved');
    expect(html).toContain('class="state bad"');
    expect(html).toContain('data-act="decide:yes"');      // and lets the owner try again
  });

  it('the state line is a live region, so the owner hears it without moving focus', () => {
    expect(actionBar(approveRow, {})).toContain('role="status" aria-live="polite"');
  });

  it('a resolved note reads as what was decided, with no bar to press', () => {
    const st = applySnapshot(emptyState(), snap({ decided: [{ id: 'p9', kind: 'spend', title: 'Pay for the domain', path: '00 Inbox/x.md', created: 'now', resolved_at: '2026-09-13T10:00:00.000Z', approved: false, outcome: 'rejected: too early' }] }));
    const v = viewFor('decision:p9', st, ctx);
    expect(v.html).toContain('rejected: too early');
    expect(v.html).not.toContain('data-act=');
    expect(viewFor('decision:nope', st, ctx).html).toContain('not in the current snapshot');
  });

  it('A approves, R rejects, 1-9 pick an option, and the comment field owns its own keys', () => {
    const three = { decidable: 'choose' as const, options: 3 };
    expect(decisionKey({ key: 'a' }, three, false)).toEqual({ act: 'yes' });
    expect(decisionKey({ key: 'A' }, three, false)).toEqual({ act: 'yes' });
    expect(decisionKey({ key: 'r' }, three, false)).toEqual({ act: 'no' });
    expect(decisionKey({ key: '2' }, three, false)).toEqual({ act: 'choose', n: 2 });
    expect(decisionKey({ key: '4' }, three, false)).toBeNull();          // there is no fourth option
    expect(decisionKey({ key: '1' }, { decidable: 'approve', options: 0 }, false)).toBeNull();
    expect(decisionKey({ key: 'a' }, three, true)).toBeNull();           // typing a comment
    expect(decisionKey({ key: 'a', ctrlKey: true }, three, false)).toBeNull();
  });
});

/**
 * SP8 ruling P8-8: a note the owner has decided and the dispatcher has not resolved stays in `inbox` carrying
 * `pending`, and one it would not apply comes back `refused`. Both states have to survive a reload, so they are
 * read off the row and not only out of this session's own reducer state.
 */
describe('a decision the dispatcher has not finished with', () => {
  const pending: InboxRow = { ...approveRow, id: 'p6', pending: true, approved: true, refused: null };
  const refused: InboxRow = { ...approveRow, id: 'p7', pending: false, approved: true, refused: 'no "## Proposed content" block found' };

  it('reads "Decided · applying…" off the row, with nothing to press, on a viewer that never sent it', () => {
    const s = applySnapshot(emptyState(), snap({ inbox: [pending] }));
    expect(decideStateFor(pending)).toMatchObject({ status: 'applying', approved: true });
    const html = viewFor('decision:p6', s, ctx).html;
    expect(html).toContain(APPLYING_TEXT);
    expect(html).not.toContain('class="state bad"');
    expect(html).toMatch(/data-act="decide:yes"[^>]*disabled/);   // busy: the bar stays put and nothing can be pressed twice
    expect(html).toMatch(/data-act="decide:no"[^>]*disabled/);
  });

  it('shows a refusal with the bar back, so the owner can fix what it names and decide again', () => {
    const s = applySnapshot(emptyState(), snap({ inbox: [refused] }));
    expect(decideStateFor(refused)).toMatchObject({ status: 'error', message: 'no "## Proposed content" block found' });
    const html = viewFor('decision:p7', s, ctx).html;
    expect(html).toContain('no &quot;## Proposed content&quot; block found');
    expect(html).toContain('class="state bad"');
    expect(html).toContain('data-act="decide:yes"');
    expect(html).not.toMatch(/data-act="decide:yes"[^>]*disabled/);
  });

  it('a click in flight outranks the row; the row outranks a stale ack', () => {
    // Nothing is on the note yet while the frame is still going out.
    expect(decideStateFor({ ...approveRow, pending: true }, { status: 'sending', approved: false })).toMatchObject({ status: 'sending' });
    // The daemon has since refused it: that is newer than this session's "applying".
    expect(decideStateFor(refused, { status: 'applying', approved: true })).toMatchObject({ status: 'error' });
    // Nothing on either side: a plain, pressable bar.
    expect(decideStateFor(approveRow)).toBeUndefined();
  });

  it('a brief the board is still arguing has nothing to decide yet (ruling P8-6)', () => {
    const sitting: InboxRow = { ...adoptRow, id: 'p9', board_pending: true };
    const s = applySnapshot(emptyState(), snap({ inbox: [sitting] }));
    expect(decideStateFor(sitting)).toMatchObject({ status: 'applying', message: BOARD_SITTING });
    expect(rowStateChip(sitting)).toContain(BOARD_SITTING_CHIP);
    expect(decisionsView(s).html).toContain(BOARD_SITTING);          // the row says why, on its second line
    const html = viewFor('decision:p9', s, ctx).html;
    expect(html).toContain(BOARD_SITTING);
    expect(html).not.toContain(APPLYING_TEXT);                       // nothing is being applied: the board is sitting
    expect(html).toMatch(/data-act="decide:yes"[^>]*disabled/);      // and the bar — and so A and R — is shut
    expect(html).toMatch(/data-act="decide:no"[^>]*disabled/);
    // The keyboard goes through the same effective state as the bar, so `A` cannot adopt a half-written brief.
    expect(decideStateFor(sitting, { status: 'sending', approved: true })?.status).toBe('applying');
  });

  it('a brief the board would not stand behind reads "Adopt anyway", and says what it is (ruling W3-3)', () => {
    const pivot: InboxRow = { ...adoptRow, id: 'pw', verdict: 'PIVOT REQUIRED', needs_confirm: true };
    const s = applySnapshot(emptyState(), snap({ inbox: [pivot] }));
    expect(verbsFor('adopt', true)).toEqual({ yes: 'Adopt anyway', no: 'Send back' });
    const html = viewFor('decision:pw', s, ctx).html;
    expect(html).toContain('>Adopt anyway<');
    expect(html).not.toContain('>Adopt brief<');
    // The verdict is in the bar, above the buttons, so it is read before the click and not after it.
    expect(html).toContain('The board ruled PIVOT REQUIRED on this brief.');
    expect(html.indexOf('data-key="verdict"')).toBeLessThan(html.indexOf('data-act="decide:yes"'));
    // …and nothing is disabled: the owner rules, the board advises.
    expect(html).not.toMatch(/data-act="decide:yes"[^>]*disabled/);
    expect(html).toContain('>Send back<');
  });

  it('promises no verdict while the board is still arguing about it', () => {
    // The draft section can carry a word the board has not ruled yet; the bar must not read it out as theirs.
    const sitting: InboxRow = { ...adoptRow, id: 'pq', verdict: 'WEAK', needs_confirm: true, board_pending: true };
    const html = viewFor('decision:pq', applySnapshot(emptyState(), snap({ inbox: [sitting] })), ctx).html;
    expect(html).toContain(BOARD_SITTING);
    expect(html).not.toContain('data-key="verdict"');
    expect(html).not.toContain('>Adopt anyway<');
  });

  it('a brief the board passed is still one click, and says nothing about a verdict', () => {
    const strong: InboxRow = { ...adoptRow, id: 'ps', verdict: 'STRONG', needs_confirm: false };
    const html = viewFor('decision:ps', applySnapshot(emptyState(), snap({ inbox: [strong] })), ctx).html;
    expect(html).toContain('>Adopt brief<');
    expect(html).not.toContain('data-key="verdict"');
    expect(verbsFor('adopt')).toEqual({ yes: 'Adopt brief', no: 'Send back' });
    // Overruling the board is one fact and it now reads the same on every screen (dry-run 2026-09-14): a plan the
    // board sent back used to offer a plain Approve with nothing said about the ruling, while a brief the board
    // ruled PIVOT REQUIRED on said so in a sentence. The verb changes; the bar does not become a dialog.
    expect(verbsFor('approve', true)).toEqual({ yes: 'Approve anyway', no: 'Reject' });
    expect(verbsFor('approve', false)).toEqual({ yes: 'Approve', no: 'Reject' });
  });

  it('the chosen option comes back from the note when this session did not pick it', () => {
    const chosenRow: InboxRow = { ...chooseRow, id: 'p8', pending: true, approved: true, chosen: 3 };
    const s = applySnapshot(emptyState(), snap({ inbox: [chosenRow] }));
    expect(viewFor('decision:p8', s, ctx).html).toContain(APPLYING_TEXT);
    expect(decideStateFor(chosenRow)).toMatchObject({ chosen: 3 });
  });

  it('the Needs-you list marks both without a second accent: applying is quiet, refused is bad', () => {
    const html = decisionsView(applySnapshot(emptyState(), snap({ inbox: [pending, refused] }))).html;
    expect(rowStateChip(pending)).toContain('applying');
    expect(rowStateChip(refused)).toContain('failed');       // the `bad` chip class
    expect(rowStateChip(approveRow)).toBe('');
    expect(html).toContain('Decided, being applied');
    expect(html).toContain('Refused: no &quot;## Proposed content&quot; block found');
  });
});

describe('the action bar reads in both themes', () => {
  for (const mode of ['dark', 'light'] as const) {
    const c = THEMES[mode].colors;
    it(`${mode}: the affirmative's ink reads on the accent and the refusal line on the surface it sits on`, () => {
      expect(contrastRatio(c.accentInk, c.accent), 'Approve').toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.bad, c.surface1), 'the error line').toBeGreaterThanOrEqual(3);
      expect(contrastRatio(c.text2, c.surface1), 'the state line').toBeGreaterThanOrEqual(4.5);
    });
  }
});


describe('the reader after the dry-run (2026-09-14)', () => {
  it('leads a plan verdict with the plan being approved, not with what was said about it', () => {
    const body = '## Board findings\n\n- The wedge is unproven.\n\n## The plan\n\n- Ship the scanner.\n';
    expect(planFirst(body).startsWith('## The plan')).toBe(true);
    expect(planFirst(body)).toContain('## Board findings');
    expect(planFirst('no plan section here')).toBe('no plan section here');
  });

  it('shows the cards and not the file’s own instructions for them', () => {
    const body = 'Pick one:\n\n1. A speed audit\n2. A Shopify plugin\n3. A newsletter\n\nSet `chosen: 1|2|3` and `approved: true` in the frontmatter.\n';
    const out = withoutFileInstructions(body, true);
    expect(out).not.toContain('chosen:');
    expect(out).not.toContain('A speed audit');
    expect(out).toContain('Pick one:');
    // with no cards on the screen the note’s own list is all the owner has, so it stays
    expect(withoutFileInstructions(body, false)).toContain('A speed audit');
  });

  it('names a returned plan’s verdict on the bar, as a brief’s is named', () => {
    const returned: InboxRow = { ...approveRow, id: 'pv', kind: 'plan_verdict', board_verdict: 'return', body: '## The plan\n\n- Ship it.\n' };
    expect(overrulesBoard(returned)).toBe(true);
    const html = viewFor('decision:pv', applySnapshot(emptyState(), snap({ inbox: [returned] })), ctx).html;
    expect(html).toContain('>Approve anyway<');
    expect(html).toContain('data-key="verdict"');
    expect(html).toContain('The board ruled return on this plan');
    // a board that passed it changes nothing about the bar
    expect(overrulesBoard({ ...returned, board_verdict: 'STRONG' })).toBe(false);
    // and a board still sitting has no ruling to overrule yet
    expect(overrulesBoard({ ...returned, board_pending: true })).toBe(false);
  });

  it('keeps the note under the outcome once it is decided', () => {
    const s2 = applySnapshot(emptyState(), snap({ inbox: [], decided: [{ id: 'd1', kind: 'founder_brief', title: 'founder_brief', path: '00 Inbox/x.md', created: 'c', resolved_at: 'r', approved: true, outcome: 'adopted at Memory/founder-brief.md', body: '# The brief\n\nThe wedge is speed.\n' }] }));
    const v = viewFor('decision:d1', s2, ctx);
    expect(v.title).toBe('Founder brief');
    expect(v.html).toContain('adopted at Memory/founder-brief.md');
    expect(v.html).toContain('The wedge is speed.');
  });

  it('never lists the same decision as a row and as mail', () => {
    const kept = mailWithoutRows([{ text: 'approval needed: Name the company' }, { text: 'sent the weekly note' }], ['Name the company']);
    expect(kept.map((m) => m.text)).toEqual(['sent the weekly note']);
  });
});
