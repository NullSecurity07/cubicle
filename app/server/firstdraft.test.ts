import { describe, expect, it } from 'vitest';
import { draftAsk } from '../shared/leads.ts';
import { whatSaidNo } from './partner/saidno.ts';
import { filledIn } from './partner/unasked.ts';
import { emailIn, owedFirstDraft, withoutPlaceholders } from './firstdraft.ts';

// Journey 21: Lea's first message to Ines, as she wrote it in chat.
const LEA = 'Here is a first message for Ines:\n\n**Subject:** Smoother repair evenings at Repair Café Kreuzberg\n\nHi Ines,\n\nWe built FixSlot to help neighbourhood repair cafés run smoother pop-up evenings: visitors book a repair slot online, and each volunteer gets their list.\n\nWould a short call next week suit you?\n\nBest,\n[Founder]\n\nWant me to put it into an email draft?';
const INES = { id: 'l1', person: { name: 'Ines Vogel', email: 'ines@repaircafe.example' }, company: { name: 'Repair Café Kreuzberg' }, stage: 'new', notes: [], source: 'founder', addedAt: 0, updatedAt: 0 } as const;

describe('a first message is an email draft at once (journey 21)', () => {
  it('asks for it with the lead\'s address', () => {
    expect(draftAsk(INES as never)).toContain('Their address: ines@repaircafe.example. Write it with draft_email to that address');
    expect(draftAsk({ ...INES, person: { name: 'Jonas Brandt' } } as never)).not.toContain('Their address');
  });

  it('takes the email Lea wrote in chat, from its greeting to its sign-off, with its subject', () => {
    expect(emailIn(LEA)).toEqual({ subject: 'Smoother repair evenings at Repair Café Kreuzberg', body: 'Hi Ines,\n\nWe built FixSlot to help neighbourhood repair cafés run smoother pop-up evenings: visitors book a repair slot online, and each volunteer gets their list.\n\nWould a short call next week suit you?\n\nBest,\n[Founder]' });
    expect(emailIn('I will draft it once you tell me the angle.')).toBeNull();
  });

  it('is owed only on the first-message ask, with an address, when no draft was made', () => {
    const ask = draftAsk(INES as never);
    expect(owedFirstDraft(ask, LEA, [])).toMatchObject({ to: 'ines@repaircafe.example', subject: 'Smoother repair evenings at Repair Café Kreuzberg' });
    expect(owedFirstDraft(ask, LEA, [{ name: 'draft_email', ok: true }])).toBeNull();
    expect(owedFirstDraft('Write Ines an email.', LEA, [])).toBeNull();
    expect(owedFirstDraft(draftAsk({ ...INES, person: { name: 'Ines Vogel' } } as never), LEA, [])).toBeNull();
  });
});

describe('a placeholder never reaches the founder', () => {
  it('takes "[Founder]" out of a chat reply, and out of a draft, signing it from the brief', () => {
    expect(withoutPlaceholders('Best,\n[Founder]\n\nWant me to draft it?')).toBe('Best,\n\nWant me to draft it?');
    expect(withoutPlaceholders('Thanks, [Your Name] here.')).toBe('Thanks, here.');
    expect(withoutPlaceholders('No placeholder [here].')).toBe('No placeholder [here].');
    expect(filledIn('Hi Ines,\n\nThanks.\n\nBest,\n[Founder]', 'FixSlot is a pop-up repair café booking tool.')).not.toContain('[Founder]');
  });

  it('never shows an empty claims list on a no', () => {
    const said = whatSaidNo({ tool: 'draft_email', subject: 'Re: FixSlot for Repair Café Kreuzberg', to: 'ines@repaircafe.example', claims: [] });
    expect(said).toBe('email to ines@repaircafe.example about "Re: FixSlot for Repair Café Kreuzberg"');
    expect(said).not.toMatch(/claim|\[\]/);
    expect(whatSaidNo({ tool: 'draft_email', subject: 'Re: FixSlot', to: 'ines@repaircafe.example', claims: ['iOS'] })).toBe('email to ines@repaircafe.example about "Re: FixSlot" (it claimed: iOS)');
  });
});
