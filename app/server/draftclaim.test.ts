import { describe, expect, it } from 'vitest';
import { holdDraftClaims, notDone, NO_DRAFT } from './draftclaim.ts';

const refused = { name: 'draft_email', ok: false, result: notDone('draft_email', 'Already declined: the founder said no to "Intro" on 7 Oct and again when it was put to them once more, so it was not raised. Do not propose it again.') };

describe('a draft the turn did not make', () => {
  it('heads a refused draft or send with NOT, and leaves other refusals as they are', () => {
    expect(notDone('draft_email', 'No.')).toBe('NOT drafted: No.');
    expect(notDone('send_email', 'No.')).toBe('NOT sent: No.');
    expect(notDone('create_doc', 'No.')).toBe('No.');
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
