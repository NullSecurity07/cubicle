import { describe, expect, it } from 'vitest';
import { isName, markNames, namesIn, unheardSayings, unrecordedNames } from './named.ts';

import { J21_BRIEF, J21_NOTES } from './named.fixture.ts';

const CAFES = ['Café Neukölln', 'Kreuzberg Repair Hub', 'Schöneberg Flick-Stube', 'Wedding Repair Café', 'Prenzlauer Berg Fix-It', 'Tempelhof Repair Club'];
// Ines on the Leads card, as `leadRecord` gives her, with her reply.
const INES = 'Ines Vogel, Organiser, Repair Café Kreuzberg\nOur Thursday evenings are chaos. Do you have an iOS app?';

describe('a customer by name (journey 21)', () => {
  it('finds every café and organiser Lea named, and no label or plain sentence', () => {
    const named = namesIn(J21_NOTES, 'Customer notes');
    expect(named.filter((one) => one.kind === 'place').map((one) => one.name)).toEqual(CAFES);
    expect(named.filter((one) => one.kind === 'person').map((one) => one.name)).toEqual(['Sarah', 'Jan', 'Marcus', 'Elena', 'Lena', 'Thomas']);
    for (const label of ['Key Insights', 'Next Steps', 'Pain Points', 'Feedback', 'Paying Cafés', 'Repair Café']) expect(isName(label)).toBe(false);
    expect(namesIn('# Pricing\n\n- **Key Insights**: cafés pay €39.\n- Next Steps: call 5 cafés.', 'Pricing')).toEqual([]);
  });

  it('holds each one to the record, and passes a lead on the Leads card', () => {
    expect(unrecordedNames({ after: J21_NOTES, read: [J21_BRIEF], title: 'Customer notes' }).map((one) => one.name)).toEqual([
      'Café Neukölln', 'Sarah', 'Kreuzberg Repair Hub', 'Jan', 'Schöneberg Flick-Stube', 'Marcus', 'Wedding Repair Café', 'Elena', 'Prenzlauer Berg Fix-It', 'Lena', 'Tempelhof Repair Club', 'Thomas',
    ]);
    const real = '# Customer notes\n\n## Leads\n\n- **Repair Café Kreuzberg**: Organiser: Ines Vogel. Said their Thursday evenings are chaos.';
    expect(unrecordedNames({ after: real, read: [J21_BRIEF, INES], title: 'Customer notes' })).toEqual([]);
    // A line that was already there was held when it was written.
    expect(unrecordedNames({ after: J21_NOTES, before: J21_NOTES, read: [J21_BRIEF], title: 'Customer notes' })).toEqual([]);
  });

  it('marks each name "(not on record)" in a plain doc, once', () => {
    const { text, marked } = markNames({ after: J21_NOTES, read: [J21_BRIEF], title: 'Customer notes' });
    expect(marked).toHaveLength(12);
    expect(text).toContain('- **Café Neukölln** (not on record): Organiser: Sarah (not on record). Uses FixSlot');
    expect(text).toContain('- **Tempelhof Repair Club** (not on record): Organiser: Thomas (not on record).');
    expect(markNames({ after: text, read: [J21_BRIEF, text], title: 'Customer notes' }).text).toBe(text);
  });

  it('needs a named customer\'s own words for what they said or did', () => {
    const doc = '# Customer notes\n\n## Leads\n\n- **Repair Café Kreuzberg**: Organiser: Ines Vogel. Feedback: Volunteers love the printed list. Said their Thursday evenings are chaos.';
    expect(unheardSayings({ after: doc, read: [J21_BRIEF, INES], title: 'Customer notes' })).toEqual([
      { name: 'Repair Café Kreuzberg', sentence: 'Feedback: Volunteers love the printed list.' },
    ]);
    expect(unheardSayings({ after: doc.replace('Feedback: Volunteers love the printed list. ', 'Feedback: no feedback on record. '), read: [J21_BRIEF, INES], title: 'Customer notes' })).toEqual([]);
  });
});
