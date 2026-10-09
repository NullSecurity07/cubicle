import { describe, expect, it } from 'vitest';
import { holdDocClaims, holdDraftClaims, holdFileLinks, notDone, NO_DRAFT, NO_FILE } from './draftclaim.ts';

const refused = { name: 'draft_email', ok: false, result: notDone('draft_email', 'Already declined: the founder said no to "Intro" on 7 Oct and again when it was put to them once more, so it was not raised. Do not propose it again.') };

describe('a draft the turn did not make', () => {
  it('heads a refused draft or send with NOT', () => {
    expect(notDone('draft_email', 'No.')).toBe('NOT drafted: No.');
    expect(notDone('send_email', 'No.')).toBe('NOT sent: No.');
  });

  it('says the refusal in place of "Drafted the reply" after a refused draft', () => {
    const out = holdDraftClaims('Drafted the reply to Mira explaining pickup options. She can try one job first.', [refused]);
    expect(out).toBe('The email was not drafted: you said no to "Intro" on 7 Oct and again when it was put to you once more, so it was not raised. She can try one job first.');
  });

  it('takes out every claim but says the refusal once, and keeps a sentence that already says it was not drafted', () => {
    const out = holdDraftClaims("I've drafted the email. The draft is ready. It was not drafted before.", [refused]);
    expect(out.match(/The email was not drafted/g)).toHaveLength(1);
    expect(out).toContain('It was not drafted before.');
    expect(out).not.toContain('draft is ready');
  });

  it('replaces "send in Gmail" with no draft beside it, and keeps it beside a real draft', () => {
    expect(holdDraftClaims('Here is a revised draft. Send the draft directly in Gmail.', [refused])).toBe(`Here is a revised draft. ${NO_DRAFT}.`);
    expect(holdDraftClaims('Open it in Gmail when ready.', [])).toBe(`${NO_DRAFT} when ready.`);
    const made = [{ name: 'draft_email', ok: true, result: 'Drafted.' }];
    expect(holdDraftClaims('Drafted it. Open it in Gmail when ready.', made)).toBe('Drafted it. Open it in Gmail when ready.');
  });

  it('leaves a reply alone when nothing was refused and Gmail is not named', () => {
    expect(holdDraftClaims('Mira sent a reply about pickup.', [])).toBe('Mira sent a reply about pickup.');
  });
});

// Journey 16: after a refused propose_decision the partner said "I have proposed the decision ... and it now waits in
// your list"; the result said "The founder said no to this".
describe('any tool that makes or sends something, refused or failed', () => {
  const said = 'The founder said no to this. Do not try it again; ask what they want changed.';
  const decision = { name: 'propose_decision', ok: false, result: notDone('propose_decision', said) };

  it('heads its result with NOT and the word for it done', () => {
    expect(notDone('propose_decision', 'No.')).toBe('NOT proposed: No.');
    expect(notDone('create_doc', 'No.')).toBe('NOT created: No.');
    expect(notDone('send_message', 'No.')).toBe('NOT sent: No.');
    expect(notDone('append_doc', 'No.')).toBe('No.');
  });

  it('says the refusal in place of "proposed ... waits in your list", and drops a lone "it waits" after it', () => {
    const out = holdDraftClaims('I have proposed the decision to pause subscriptions, and it now waits in your list. Tell me what to change.', [decision]);
    expect(out).toBe('The decision was not proposed: you said no to this. Tell me what to change.');
    expect(holdDraftClaims('I proposed the decision. It now waits in your list.', [decision])).toBe('The decision was not proposed: you said no to this.');
  });

  it('leaves alone a claim about another tool that worked, and a sentence that says it was not done', () => {
    const wrote = { name: 'append_doc', ok: true, result: 'Added 1 line.' };
    expect(holdDraftClaims('I added the line to Numbers.', [decision, wrote])).toBe('I added the line to Numbers.');
    expect(holdDraftClaims('The decision was not proposed, since you said no.', [decision])).toBe('The decision was not proposed, since you said no.');
    expect(holdDraftClaims('I have proposed the decision.', [decision, { name: 'propose_decision', ok: true, result: 'Proposed.' }])).toBe('I have proposed the decision.');
  });

  it('holds a failed create the same way', () => {
    const failed = { name: 'create_doc', ok: false, result: 'not written: "12 users" is not in any founder message.' };
    expect(holdDraftClaims('I created the doc "Runway".', [failed])).toBe('The doc was not created: not written: "12 users" is not in any founder message.');
  });
});

// Journey 16: "I updated the Company document with the corrected paying subscriber count of 11" with no write.
describe('a claim to have written a document', () => {
  const said = 'Break-even is 8.\n\nI updated the Company document with the corrected count of 11. Updated the Numbers section too.';
  it('is put right when nothing was written this turn, once', () => {
    expect(holdDocClaims(said, [{ name: 'calc', ok: true }], { title: 'Company brief' })).toBe('Break-even is 8.\n\nNothing was written to the Company brief this turn.');
  });
  it('stands beside a write that worked, or one the app made for the turn', () => {
    expect(holdDocClaims(said, [{ name: 'replace_section', ok: true }], { title: 'Company brief' })).toBe(said);
    expect(holdDocClaims(said, [], { title: 'Company brief', wrote: true })).toBe(said);
    // A failed write backs nothing; a colleague's write said in the third person is not this turn's claim.
    expect(holdDocClaims(said, [{ name: 'write_doc', ok: false }], { title: 'Company brief' })).toContain('Nothing was written');
    expect(holdDocClaims('Otto updated the Runway doc yesterday.', [], { title: 'Company brief' })).toBe('Otto updated the Runway doc yesterday.');
  });
});

// Journey 17: "![chart](/api/files/chart.png)" with no chart made; the picture 404'd.
describe('a link to a file nothing made', () => {
  const none = async () => false;
  it('drops a picture no tool made and says no file was made', async () => {
    expect(await holdFileLinks('![chart](/api/files/chart.png)\nPaying went from 9.5 to 12.5.', [], none)).toBe(`${NO_FILE}\nPaying went from 9.5 to 12.5.`);
    expect(await holdFileLinks('See [the runway sheet](/api/files/runway.xlsx) for the months.', [], none)).toBe(`See the runway sheet ${NO_FILE} for the months.`);
  });
  it('keeps a file a tool made this turn, or one that is there', async () => {
    const made = [{ name: 'generate_image', ok: true, result: 'Saved the picture as media/chart-1.png: ![chart](/api/files/media/chart-1.png)' }];
    expect(await holdFileLinks('![chart](/api/files/media/chart-1.png)', made, none)).toBe('![chart](/api/files/media/chart-1.png)');
    expect(await holdFileLinks('![deck](/api/files/decks/a%20b.pptx)', [], async (path) => path === 'decks/a b.pptx')).toBe('![deck](/api/files/decks/a%20b.pptx)');
    // A failed tool that named it made nothing.
    expect(await holdFileLinks('![chart](/api/files/chart.png)', [{ name: 'generate_image', ok: false, result: 'could not make chart.png' }], none)).toBe(NO_FILE);
  });
});

// Journey 18: "I have submitted the proposal. The decision was not proposed: you said no to this."
describe('a reply that both claims and denies the same act', () => {
  const declined = { name: 'propose_decision', ok: false, result: notDone('propose_decision', 'Already declined: the founder said no to this on 10 Oct.') };
  it('keeps the refusal it already says and takes the claim out, never two refusal lines', () => {
    const out = holdDraftClaims('I have submitted the proposal. The decision was not proposed: you said no to this.', [declined]);
    expect(out.trim()).toBe('The decision was not proposed: you said no to this.');
  });
  it('turns a claim into the refusal when the reply has none', () => {
    expect(holdDraftClaims('I have submitted the proposal for a free month.', [declined]).trim()).toBe('The decision was not proposed: you said no to this on 10 Oct.');
  });
  it('says what the receipt says when a tool worked and the reply denies it', () => {
    const made = [{ name: 'propose_decision', ok: true, result: 'Proposed: "Referral month".' }];
    expect(holdDraftClaims('The decision was not proposed. It waits for you.', made)).toBe('The decision was proposed. It waits for you.');
  });
});

