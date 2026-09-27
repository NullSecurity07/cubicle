import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Framework } from '../../shared/frameworks.ts';
import { place } from '../frameworks/place.ts';
import { runTurn } from '../loop.ts';
import type { ModelClient, ModelTurn } from '../providers.ts';
import { createStore } from '../store.ts';
import { createUsage } from '../usage.ts';
import { docTools } from './docs.ts';
import { HELD_BACK } from '../truth.ts';
import { runTool } from './registry.ts';
import { teamTools, type Consult } from './team.ts';
import { conversations, filled, guardWrite, sectionBody, verdictOf } from './verdict.ts';
import { createPromptFor } from '../turn-prompt.ts';

const OUTCOMES = ['WEAK', 'PIVOT REQUIRED', 'STRONG'];
const FILLED = {
  '1. Core assumption (falsifiable)': 'Indie buyers will pay $19 a month for a weekly list of SaaS under $5k.\n\nCheapest way to test it: a landing page with a paid pre-order.',
  '2. Three specific ways it dies': '1. Too few good deals a week — survivable? Yes — cheapest test: count last month\'s listings.',
  '3. Is the pain real?': 'Vitamin — painkiller — hair on fire: painkiller\n\nReal customer conversations done (of ten to twenty): 12',
  '4. Founder-market fit': 'Lived it / unusual access / technical edge / contrarian insight / earned secret / none: lived it\n\nIn one sentence: sold one extension of their own.',
};

// The startup evaluation team as it lands on a fresh stage, its Evaluation doc as shipped, and a way to call a doc
// tool as any one of its people. Ids are the framework's own keys, since nothing on a fresh stage is called those.
async function setup() {
  const framework = JSON.parse(await readFile(resolve(import.meta.dirname, '../../frameworks/startup-evaluation/framework.json'), 'utf8')) as Framework;
  const store = createStore(await mkdtemp(join(tmpdir(), 'verdict-')));
  const seed = await store.loadStage();
  const { placed, texts } = place(framework, seed, { x: 2000, y: 0 });
  const stage = { ...seed, rooms: [...seed.rooms, ...placed.rooms], docs: [...seed.docs, ...placed.docs], wires: [...seed.wires, ...placed.wires], cards: [...(seed.cards ?? []), ...placed.cards] };
  for (const [id, text] of Object.entries(texts)) await store.replaceDoc(id, text);
  const as = (roomId: string) => (name: string, args: Record<string, unknown>) =>
    runTool(docTools, name, JSON.stringify({ doc: 'Evaluation', ...args }), { stage, roomId, store, granted: new Map() });
  const doc = () => store.readDoc('evaluation');
  const fill = async (skip: string[] = []) => {
    for (const [heading, text] of Object.entries(FILLED)) {
      if (skip.includes(heading)) continue;
      const by = framework.docs[0].rules!.sections.find((one) => one.heading === heading)!.by;
      expect((await as(by)('replace_section', { heading, text })).ok, heading).toBe(true);
    }
  };
  return { stage, store, as, doc, fill, framework };
}

describe('reading a team doc', () => {
  it('counts only what a person wrote, not the template\'s labels', () => {
    expect(filled('Lived it / unusual access / none:\n\nIn one sentence:\n')).toEqual([]);
    expect(filled('1. — survivable? — cheapest test:\n2. — survivable? — cheapest test:')).toEqual([]);
    expect(filled('Not assessed: 4. Founder-market fit\nStale: 3. Is the pain real? changed after this verdict on 26 Sept 2026.')).toEqual([]);
    expect(filled('In one sentence: sold one extension.')).toEqual(['In one sentence: sold one extension.']);
  });

  it('finds the verdict word and the score, reading past the template\'s own list of words', () => {
    expect(verdictOf('One word (STRONG / WEAK / PIVOT REQUIRED): WEAK\n\nScore out of 10 — assumption, flaws, pain, fit, why now: 4/10', OUTCOMES)).toEqual({ word: 'WEAK', score: 4 });
    expect(verdictOf('**STRONG** because the pain is real.\nScore: 10', OUTCOMES)).toEqual({ word: 'STRONG', score: 10 });
    expect(verdictOf('PIVOT REQUIRED, 6 out of 10', OUTCOMES)).toEqual({ word: 'PIVOT REQUIRED', score: 6 });
    // A figure in the reasons is not the score: the Score line is.
    expect(verdictOf('WEAK\n\nBecause: 7 of 10 we called said it hurts (3).\n\nScore: 4/10', OUTCOMES).score).toBe(4);
    expect(verdictOf('STRONG\n\nBecause: 3 of 10 replied (3).\n\nScore out of 10 — assumption, flaws, pain, fit, why now: 9/10', OUTCOMES).score).toBe(9);
    expect(verdictOf('STRONG\n\nScore: 2, 2, 2, 1, 1 = 8', OUTCOMES).score).toBe(8);
    expect(verdictOf('STRONG\n\nScore: 2/10 + 2/10 + 2/10 + 1/10 + 1/10 = 8/10', OUTCOMES).score).toBe(8);
  });

  it('ships the rules with the Evaluation doc, naming a section that is in it for each person', async () => {
    const { framework } = await setup();
    const [doc] = framework.docs;
    expect(doc.rules?.verdict).toEqual({ heading: '5. Verdict', by: 'verdict' });
    for (const { heading, by } of [...doc.rules!.sections, doc.rules!.verdict]) {
      expect(sectionBody(doc.text, heading), heading).not.toBeNull();
      expect(framework.rooms.some((room) => room.key === by)).toBe(true);
    }
    // The template alone is empty everywhere: nothing in it can pass for work.
    for (const { heading } of doc.rules!.sections) expect(filled(sectionBody(doc.text, heading)), heading).toEqual([]);
  });
});

describe('the verdict judge on a team doc', () => {
  it('may not write a colleague\'s section, while the colleague may', async () => {
    const { as, doc } = await setup();
    const before = await doc();
    const out = await as('verdict')('replace_section', { heading: '4. Founder-market fit', text: 'The founder has lived the pain of buying micro-SaaS.' });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/"4\. Founder-market fit" is Rohan's section \(Founder-fit\).*ask_person/);
    // The refusal names the truth, so the judge has no gap to fill with a cause of her own ("the parser").
    expect(out.text).toContain('Rohan has not written "4. Founder-market fit" yet');
    expect(await doc()).toBe(before);
    // A whole rewrite that slips a change into the section is refused the same way.
    const rewrite = await as('verdict')('write_doc', { text: before.replace('In one sentence:', 'In one sentence: lived it.') });
    expect(rewrite.ok).toBe(false);
    expect((await as('fit')('replace_section', { heading: '4. Founder-market fit', text: FILLED['4. Founder-market fit'] })).ok).toBe(true);
    // Nobody but the judge adds to the end, which is the verdict.
    expect((await as('pain')('append_doc', { text: 'STRONG' })).text).toMatch(/is Priya's section/);
  });

  it('writes "not assessed" in place of a verdict while a section it rests on is empty', async () => {
    const { as, doc, fill } = await setup();
    await fill(['4. Founder-market fit']);
    const out = await as('verdict')('replace_section', { heading: '5. Verdict', text: 'STRONG\n\nBecause: the founder lived it.\n\nScore: 10/10' });
    expect(out.ok).toBe(true);
    expect(out.text).toMatch(/^Not written: the verdict waits because Rohan has not written "4\. Founder-market fit" yet\..*Ask Rohan with ask_person/);
    expect(out.text).toMatch(/tell the founder exactly that.*nothing else in the document is wrong/i);
    const verdict = sectionBody(await doc(), '5. Verdict')!;
    expect(verdict).toMatch(/^Not assessed: 4\. Founder-market fit \(Rohan has not written it yet\)\n\nNo verdict and no score/);
    expect(verdict).not.toMatch(/STRONG|10\/10/);
  });

  it('caps the verdict at WEAK and 5 of 10 when no customer conversations are recorded', async () => {
    const { as, doc, fill } = await setup();
    await fill();
    expect((await as('pain')('replace_section', { heading: '3. Is the pain real?', text: 'Vitamin — painkiller — hair on fire: painkiller\n\nReal customer conversations done (of ten to twenty): 0' })).ok).toBe(true);
    const strong = await as('verdict')('replace_section', { heading: '5. Verdict', text: 'STRONG\n\nScore out of 10: 10/10' });
    expect(strong.ok).toBe(false);
    expect(strong.text).toMatch(/no customer conversations are recorded.*so the score is at most 5\/10 and the verdict is not STRONG; PIVOT REQUIRED stands\. This one says STRONG, 10 of 10/);
    expect(strong.text).toContain('The count line reads "Real customer conversations done (of ten to twenty): 0".');
    expect((await as('verdict')('replace_section', { heading: '5. Verdict', text: 'PIVOT REQUIRED (3)\n\nScore: 6/10' })).ok).toBe(false);
    expect((await as('verdict')('replace_section', { heading: '5. Verdict', text: 'WEAK: no conversations yet (3).\n\nScore: 5/10' })).ok).toBe(true);
    expect(sectionBody(await doc(), '5. Verdict')).toContain('WEAK: no conversations yet (3).');
  });

  it('caps the score only, never pushing a PIVOT REQUIRED up to WEAK', async () => {
    // A live judge refused "PIVOT REQUIRED, 6 of 10" with "at most WEAK" softened a flaw that is not survivable to WEAK 5/10.
    const { as, doc, fill } = await setup();
    await fill();
    expect((await as('pain')('replace_section', { heading: '3. Is the pain real?', text: 'Vitamin — painkiller — hair on fire: painkiller\n\nReal customer conversations done (of ten to twenty): 0' })).ok).toBe(true);
    const six = await as('verdict')('replace_section', { heading: '5. Verdict', text: 'PIVOT REQUIRED: a flaw is not survivable (2).\n\nScore: 6/10' });
    expect(six.ok).toBe(false);
    expect(six.text).toMatch(/so the score is at most 5\/10 and the verdict is not STRONG; PIVOT REQUIRED stands\. This one says 6 of 10\./);
    expect(six.text).not.toMatch(/at most WEAK/);
    expect((await as('verdict')('replace_section', { heading: '5. Verdict', text: 'STRONG (1)\n\nScore: 5/10' })).ok).toBe(false);
    expect((await as('verdict')('replace_section', { heading: '5. Verdict', text: 'PIVOT REQUIRED: a flaw is not survivable (2).\n\nScore: 5/10' })).text).toContain('The verdict is written.');
    expect(sectionBody(await doc(), '5. Verdict')).toMatch(/^PIVOT REQUIRED/);
  });

  it('reads the conversations count the pain section gives on the line under its label', async () => {
    // Meera's live section 3: the label's own line empty, the count on the line under it. The cap said none were recorded.
    const pain = 'Vitamin — painkiller — hair on fire:\nPainkiller / Hair on fire (3 paying beta users indicate willingness to pay).\n\n'
      + 'Real customer conversations done (of ten to twenty):\n3 paying beta users (Real customer conversations done: 3).\n\nPayer = user? If not, who pays:\nYes, payer = user.';
    expect(conversations(pain, 'Real customer conversations done')).toBe(3);
    expect(conversations('Real customer conversations done (of ten to twenty):\nNone yet.\n\nPayer = user? If not, who pays:\nYes.', 'Real customer conversations done')).toBe(0);
    expect(conversations('Real customer conversations done (of ten to twenty):\n\nPayer = user? If not, who pays:\n12 of them pay.', 'Real customer conversations done')).toBeNull();
    const { as, fill } = await setup();
    await fill();
    expect((await as('pain')('replace_section', { heading: '3. Is the pain real?', text: pain })).ok).toBe(true);
    expect((await as('verdict')('replace_section', { heading: '5. Verdict', text: 'PIVOT REQUIRED (2)\n\nScore: 6/10' })).text).toContain('The verdict is written.');
  });

  it('lets a strong verdict stand on real conversations', async () => {
    const { as, fill } = await setup();
    await fill();
    expect((await as('verdict')('replace_section', { heading: '5. Verdict', text: 'STRONG (1)(3)(4)\n\nScore: 8/10' })).ok).toBe(true);
  });

  it('marks the verdict stale when a section under it changes, once per section, until the judge writes it again', async () => {
    const { as, doc, fill } = await setup();
    await fill();
    await as('verdict')('replace_section', { heading: '5. Verdict', text: 'WEAK\n\nScore: 4/10' });
    const changed = await as('fit')('replace_section', { heading: '4. Founder-market fit', text: 'none: sold one extension, never bought one.' });
    expect(changed.text).toMatch(/Replaced the section "4\. Founder-market fit"\. The verdict was written before this change, so it is now marked stale; Priya judges it again\./);
    await as('fit')('replace_section', { heading: '4. Founder-market fit', text: 'none: sold one extension.' });
    await as('pain')('replace_section', { heading: '3. Is the pain real?', text: 'Real customer conversations done (of ten to twenty): 3' });
    const stale = sectionBody(await doc(), '5. Verdict')!;
    expect(stale.split('\n').filter((line) => line.startsWith('Stale:'))).toEqual([
      expect.stringMatching(/^Stale: 3\. Is the pain real\? changed after this verdict on \d{1,2} \w+ \d{4}\.$/),
      expect.stringMatching(/^Stale: 4\. Founder-market fit changed after this verdict on /),
    ]);
    expect(stale).toContain('WEAK');
    // The judge's new verdict, even one that copied the old marks, stands without them.
    await as('verdict')('replace_section', { heading: '5. Verdict', text: `${stale}\n\nRe-judged: WEAK still.` });
    expect(sectionBody(await doc(), '5. Verdict')).not.toMatch(/Stale:/);
  });

  it('leaves an empty verdict alone when a section changes', async () => {
    const { as, doc, fill } = await setup();
    await fill();
    expect(sectionBody(await doc(), '5. Verdict')).not.toMatch(/Stale:/);
  });

  it('lets anybody write a section whose person is no longer on the stage', async () => {
    const { stage, as } = await setup();
    stage.rooms = stage.rooms.filter((room) => room.id !== 'fit');
    expect((await as('verdict')('replace_section', { heading: '4. Founder-market fit', text: 'none: the founder said so.' })).ok).toBe(true);
  });
});

describe('the conversations cap, however the pain section is written', () => {
  const pain = async (text: string) => {
    const { as, fill } = await setup();
    await fill();
    expect((await as('pain')('replace_section', { heading: '3. Is the pain real?', text })).ok).toBe(true);
    return as('verdict')('replace_section', { heading: '5. Verdict', text: 'STRONG (3)\n\nScore: 8/10' });
  };

  it('reads the count from a bolded label or a bullet', async () => {
    expect((await pain('**Real customer conversations done (of ten to twenty):** 12')).ok).toBe(true);
    expect((await pain('- Real customer conversations done (of ten to twenty): 12')).ok).toBe(true);
    expect((await pain('- **Real customer conversations done:** 0')).ok).toBe(false);
  });

  it('reads the count from prose when the line was dropped, and caps only when none is found', async () => {
    expect((await pain('Painkiller. Talked to 12 founders who sold a side project last year.')).ok).toBe(true);
    expect((await pain('Painkiller: we ran 14 customer interviews in two weeks.')).ok).toBe(true);
    expect((await pain('Painkiller. twelve conversations so far.')).ok).toBe(true);
    expect((await pain('Painkiller, from what the founder believes.')).ok).toBe(false);
  });

  it('reads the count after the label, past its own bracket, however it is separated', () => {
    const LABEL = 'Real customer conversations done';
    expect(conversations('Real customer conversations done (of ten to twenty) - 0', LABEL)).toBe(0);
    expect(conversations('Real customer conversations done (of ten to twenty) — 7', LABEL)).toBe(7);
    expect(conversations('Real customer conversations done (of ten to twenty): 12', LABEL)).toBe(12);
  });

  it('does not count interviews that were denied or only planned', () => {
    const LABEL = 'Real customer conversations done';
    expect(conversations('Painkiller. None of the 12 interviews happened yet.', LABEL)).toBeNull();
    expect(conversations('No interviews yet; 10 calls planned', LABEL)).toBeNull();
    expect(conversations('Painkiller. 5 interviews are booked for next week.', LABEL)).toBeNull();
    expect(conversations('No workaround. Talked to 12 founders, all angry.', LABEL)).toBe(12);
  });

  it('counts a dozen, dozens by number and a count with a plus', () => {
    const LABEL = 'Real customer conversations done';
    expect(conversations('Painkiller. Talked to a dozen founders who sold a side project.', LABEL)).toBe(12);
    expect(conversations('Painkiller: 25+ interviews with indie buyers.', LABEL)).toBe(25);
    expect(conversations('Painkiller. Two dozen calls, most of them angry.', LABEL)).toBe(24);
    expect(conversations('Painkiller. Half a dozen interviews so far.', LABEL)).toBe(6);
    expect(conversations('Real customer conversations done (of ten to twenty): 25+', LABEL)).toBe(25);
    expect(conversations('Real customer conversations done: a dozen', LABEL)).toBe(12);
    expect(conversations('Real customer conversations done: two dozen, all founders', LABEL)).toBe(24);
    // Still none when the dozen was only planned.
    expect(conversations('A dozen interviews are booked for next week.', LABEL)).toBeNull();
  });

  it('reads a struck-out or planned count as no count', () => {
    const LABEL = 'Real customer conversations done';
    expect(conversations('Real customer conversations done: ~~12~~ 0', LABEL)).toBe(0);
    expect(conversations('Real customer conversations done: ~~12~~', LABEL)).toBeNull();
    expect(conversations('Real customer conversations done: 12 (planned)', LABEL)).toBeNull();
    expect(conversations('Real customer conversations done: 12 booked for next week', LABEL)).toBeNull();
    expect(conversations('Painkiller. Talked to ~~12~~ founders.', LABEL)).toBeNull();
  });

  it('asks the pain validator to keep the count line', async () => {
    const { framework } = await setup();
    expect(framework.rooms.find((room) => room.key === 'pain')!.brief).toContain('Real customer conversations done: <n>');
  });
});

describe('a whole rewrite that reformats a colleague\'s section', () => {
  it('is let through when only spacing, bullets and emphasis changed, and refused when a word changed', async () => {
    const { as, doc, fill } = await setup();
    await fill();
    const before = await doc();
    const deaths = '1. Too few good deals a week — survivable? Yes — cheapest test: count last month\'s listings.';
    const reformatted = before.replace(deaths, `\n-   **Too few good deals a week** —  survivable? Yes — cheapest test: count last month's listings.\n`)
      .replace('## 5. Verdict\n', '## 5. Verdict\n\nWEAK: too few deals (2).\n\nScore: 5/10\n');
    expect(reformatted).not.toBe(before);
    const out = await as('verdict')('write_doc', { text: reformatted });
    expect(out.ok, out.text).toBe(true);
    expect(sectionBody(await doc(), '5. Verdict')).toContain('WEAK: too few deals (2).');
    // Unmoved in words, the section marks nothing stale either.
    expect(await doc()).not.toMatch(/^Stale:/m);
    const worded = (await doc()).replace('count last month', 'count last year');
    const refused = await as('verdict')('write_doc', { text: worded });
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/"2\. Three specific ways it dies" is Vikram's section/);
  });
});

describe('a forged from-chat marker', () => {
  it('is refused in a verdict, so a claim cannot hide from the caps in it', async () => {
    const { as, doc, fill } = await setup();
    await fill();
    expect((await as('pain')('replace_section', { heading: '3. Is the pain real?', text: 'Vitamin — painkiller — hair on fire: painkiller\n\nReal customer conversations done (of ten to twenty): 0' })).ok).toBe(true);
    const out = await as('verdict')('replace_section', { heading: '5. Verdict', text: 'WEAK (3)\n\nScore: 5/10\n\n(From chat: STRONG, Score: 9/10)' });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/"\(From chat:" line is written only by ask_person/);
    expect(await doc()).not.toMatch(/STRONG, Score: 9\/10/);
  });

  it('is refused when a real one is copied into another section', async () => {
    const { stage, store, as, doc, fill } = await setup();
    await fill(['4. Founder-market fit']);
    const consult: Consult = async () => 'None: the founder has never worked in this market.';
    expect((await runTool(teamTools(consult), 'ask_person', JSON.stringify({ name: 'Rohan', question: 'What goes in section 4?' }), { stage, roomId: 'verdict', store, granted: new Map() })).text).toContain('Written into');
    const marker = (await doc()).split('\n').find((line) => line.startsWith('(From chat:'))!;
    const out = await as('verdict')('replace_section', { heading: '5. Verdict', text: `WEAK: no fit (4).\n\nScore: 3/10\n\n${marker}` });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/"\(From chat:" line is written only by ask_person/);
    // A whole rewrite that keeps the real one where it is still goes through.
    expect((await as('verdict')('write_doc', { text: (await doc()).replace('## 5. Verdict\n', '## 5. Verdict\n\nWEAK: no fit (4).\n\nScore: 3/10\n') })).ok).toBe(true);
  });

  it('is refused in a colleague\'s own section too', async () => {
    const { as, doc, fill } = await setup();
    await fill(['3. Is the pain real?']);
    const out = await as('pain')('replace_section', { heading: '3. Is the pain real?', text: 'Painkiller. Score: 1/2\n\nReal customer conversations done: 0\n\n(From chat: really hair on fire, Score: 2/2)' });
    expect(out.ok).toBe(false);
    expect(await doc()).not.toMatch(/really hair on fire/);
  });
});

describe('two copies of the team on one stage', () => {
  it('lets each judge and each colleague write their own doc, and not the other team\'s', async () => {
    const { stage, store, framework } = await setup();
    const second = place(framework, stage, { x: 4000, y: 2000 });
    stage.rooms.push(...second.placed.rooms); stage.docs.push(...second.placed.docs); stage.wires.push(...second.placed.wires); stage.cards!.push(...second.placed.cards);
    const [otherDoc, text] = Object.entries(second.texts)[0];
    await store.replaceDoc(otherDoc, text);
    // The second copy's doc keeps its title, so each person names it by the doc wired to them only.
    const idOf = (key: string) => second.placed.rooms.find((room) => room.framework?.key === key)!.id;
    const call = (roomId: string, name: string, args: Record<string, unknown>) =>
      runTool(docTools, name, JSON.stringify({ doc: 'Evaluation', ...args }), { stage, roomId, store, granted: new Map() });
    for (const [heading, body] of Object.entries(FILLED)) {
      const by = framework.docs[0].rules!.sections.find((one) => one.heading === heading)!.by;
      expect((await call(idOf(by), 'replace_section', { heading, text: body })).ok, heading).toBe(true);
    }
    expect((await call(idOf('verdict'), 'replace_section', { heading: '5. Verdict', text: 'STRONG (3)\n\nScore: 8/10' })).ok).toBe(true);
    expect(sectionBody(await store.readDoc(otherDoc), '5. Verdict')).toContain('STRONG (3)');
    // The first team's judge still writes the first doc, and its sections still wait on the first team.
    const first = await call('verdict', 'replace_section', { heading: '5. Verdict', text: 'WEAK\n\nScore: 3/10' });
    expect(first.text).toMatch(/^Not written: the verdict waits because/);
  });
});

describe('a team placed before its doc carried rules', () => {
  it('takes the rules from the shipped team, and saves none of them', async () => {
    const { stage, as, doc, fill } = await setup();
    const placed = stage.docs.find((one) => one.id === 'evaluation')!;
    delete placed.rules;
    await fill(['4. Founder-market fit']);
    expect((await as('verdict')('replace_section', { heading: '4. Founder-market fit', text: 'lived it' })).text).toMatch(/is Rohan's section/);
    await as('verdict')('replace_section', { heading: '5. Verdict', text: 'STRONG\n\nScore: 10/10' });
    expect(sectionBody(await doc(), '5. Verdict')).toMatch(/^Not assessed: 4\. Founder-market fit/);
    expect(placed.rules).toBeUndefined();
  });

  it('behaves as before when no shipped team matches', async () => {
    const { stage, as } = await setup();
    const placed = stage.docs.find((one) => one.id === 'evaluation')!;
    delete placed.rules;
    placed.title = 'Evaluation';
    for (const room of stage.rooms) if (room.framework) room.framework = { ...room.framework, id: 'no-such-team' };
    expect((await as('verdict')('replace_section', { heading: '4. Founder-market fit', text: 'lived it' })).ok).toBe(true);
  });
});

describe('the pain section without conversations', () => {
  const RATE = 'Vitamin — painkiller — hair on fire:';
  const pain = async (text: string) => {
    const { as, fill } = await setup();
    await fill();
    return as('pain')('replace_section', { heading: '3. Is the pain real?', text });
  };

  it('is rated at most painkiller, 1 of 2, and says why', async () => {
    const out = await pain(`${RATE} Painkiller bordering on hair-on-fire. Score: 2/2\n\nReal customer conversations done (of ten to twenty): 0`);
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/no customer conversations are recorded.*pain is at most painkiller and 1 of 2\. This one says painkiller, 2 of 2/);
    // What it read, quoted, so the writer sees the count line the cap rests on.
    expect(out.text).toContain('The count line reads "Real customer conversations done (of ten to twenty): 0".');
    const dropped = await pain(`${RATE} hair on fire. Score: 2/2`);
    expect(dropped.text).toContain('There is no "Real customer conversations done" line, and no count of conversations in the section.');
    expect((await pain(`${RATE} hair on fire\n\nReal customer conversations done: 0`)).ok).toBe(false);
    expect((await pain(`${RATE} painkiller, unproven. Score: 1/2\n\nReal customer conversations done: 0`)).ok).toBe(true);
    expect((await pain(`${RATE} vitamin\n\nReal customer conversations done: none`)).ok).toBe(true);
  });

  it('may be rated hair on fire once conversations back it', async () => {
    expect((await pain(`${RATE} hair on fire. Score: 2/2\n\nReal customer conversations done (of ten to twenty): 12`)).ok).toBe(true);
  });

  it('ships as a rule on the doc and a line in the pain validator\'s brief', async () => {
    const { framework } = await setup();
    expect(framework.docs[0].rules!.caps!.some((cap) => cap.on === '3. Is the pain real?' && cap.verdict === 'painkiller' && cap.score === 1 && cap.outOf === 2)).toBe(true);
    expect(framework.rooms.find((room) => room.key === 'pain')!.brief).toMatch(/no conversations.*at most painkiller, 1\/2/i);
  });
});

describe('a second copy of a section', () => {
  it('is refused when appended or written in, so the verdict cannot slip in under its own heading again', async () => {
    const { as, doc, fill } = await setup();
    await fill(['4. Founder-market fit']);
    const before = await doc();
    const appended = await as('verdict')('append_doc', { text: '## 5. Verdict\n\nWEAK\n\nScore: 5/10' });
    expect(appended.ok).toBe(false);
    expect(appended.text).toMatch(/"5\. Verdict" is already a section of this document; change it with replace_section/);
    const rewritten = await as('verdict')('write_doc', { text: `${before}\n## 5. Verdict\n\nSTRONG\n` });
    expect(rewritten.ok).toBe(false);
    expect(await doc()).toBe(before);
  });

  it('is checked with the first when a doc already holds two', async () => {
    const { stage, doc, fill, as } = await setup();
    await fill(['4. Founder-market fit']);
    const rules = stage.docs.find((one) => one.id === 'evaluation')!.rules!;
    const twice = `${await doc()}\n## 5. Verdict\n\n`;
    const guard = (writerId: string, after: string) => guardWrite({ rules, stage, docId: 'evaluation', writerId, before: twice, after, now: Date.now() });
    // The judge fills the second copy while the fit is empty: the verdict is "not assessed", in one section.
    const held = guard('verdict', `${twice}STRONG\n\nScore: 10/10\n`);
    expect(held.held).toBe(true);
    expect(held.text.match(/^## 5\. Verdict$/gm)).toHaveLength(1);
    expect(sectionBody(held.text, '5. Verdict')).toMatch(/^Not assessed: 4\. Founder-market fit/);
    expect(held.text).not.toMatch(/10\/10/);
    // With the fit filled, a whole rewrite of the first copy is the verdict; the old second copy's words go.
    const full = twice.replace('## 4. Founder-market fit\n\nLived it', `## 4. Founder-market fit\n\n${'In one sentence: sold one extension.'}\n\nLived it`);
    const old = `${full}STRONG\n\nScore: 10/10\n`;
    const rewritten = guardWrite({ rules, stage, docId: 'evaluation', writerId: 'verdict', before: old, after: old.replace('## 5. Verdict\n\nOne word', '## 5. Verdict\n\nWEAK (3)\n\nScore: 3/10\n\nOne word'), now: Date.now() });
    expect(rewritten.text.match(/^## 5\. Verdict$/gm)).toHaveLength(1);
    expect(sectionBody(rewritten.text, '5. Verdict')).toContain('WEAK (3)');
    expect(rewritten.text).not.toMatch(/^STRONG$|10\/10/m);
    // And a colleague may not write into the second copy either.
    expect(() => guard('pain', `${twice}STRONG\n`)).toThrow(/is Priya's section/);
    // Every copy's words count: a colleague's section filled in its second copy is filled.
    expect(filled(sectionBody(`## 4. Founder-market fit\n\nIn one sentence:\n\n## 4. Founder-market fit\n\nlived it\n`, '4. Founder-market fit'))).toEqual(['lived it']);
    void as;
  });
});

describe('a verdict written again over a section emptied since', () => {
  // The founder empties a section in the doc editor, which no guard sees; the judge is then asked to rewrite her verdict.
  const STANDING = 'WEAK: the founder lived it, but no pain is proven (4).\n\nScore: 5/10';
  async function standing() {
    const all = await setup();
    await all.fill();
    expect((await all.as('verdict')('replace_section', { heading: '5. Verdict', text: STANDING })).ok).toBe(true);
    const text = await all.doc();
    await all.store.replaceDoc('evaluation', text.replace(sectionBody(text, '4. Founder-market fit')!, 'Lived it / unusual access / technical edge / contrarian insight / earned secret / none:\n\nIn one sentence:'));
    return all;
  }

  it('is held when the judge writes the same text again, and says "not assessed"', async () => {
    const { as, doc } = await standing();
    const out = await as('verdict')('replace_section', { heading: '5. Verdict', text: STANDING });
    expect(out.ok).toBe(true);
    expect(out.text).toMatch(/^Not written: the verdict waits because Rohan has not written "4\. Founder-market fit" yet/);
    expect(sectionBody(await doc(), '5. Verdict')).toMatch(/^Not assessed: 4\. Founder-market fit \(Rohan has not written it yet\)/);
  });

  it('is held on a whole-doc write that keeps the verdict, by the judge or anyone else', async () => {
    const judge = await standing();
    const out = await judge.as('verdict')('write_doc', { text: await judge.doc() });
    expect(out.text).toMatch(/^Not written: the verdict waits because Rohan/);
    expect(sectionBody(await judge.doc(), '5. Verdict')).toMatch(/^Not assessed: 4\. Founder-market fit/);
    // A colleague's whole-doc write of their own section still goes in; the verdict under it becomes "not assessed".
    const other = await standing();
    const before = await other.doc();
    const mine = await other.as('assumption')('write_doc', { text: before.replace('Cheapest way to test it: a landing page with a paid pre-order.', 'Cheapest way to test it: ten paid pre-orders.') });
    expect(mine.ok).toBe(true);
    expect(mine.text).toMatch(/^Wrote \d+ characters\. The verdict now says "Not assessed": Rohan has not written "4\. Founder-market fit" yet\./);
    const after = await other.doc();
    expect(after).toContain('ten paid pre-orders');
    expect(sectionBody(after, '5. Verdict')).toMatch(/^Not assessed: 4\. Founder-market fit/);
  });

  it('is refused by the cap when the conversations were taken out since, though its text did not change', async () => {
    const all = await setup();
    await all.fill();
    const strong = 'STRONG (1)(3)(4)\n\nScore: 8/10';
    expect((await all.as('verdict')('replace_section', { heading: '5. Verdict', text: strong })).ok).toBe(true);
    await all.store.replaceDoc('evaluation', (await all.doc()).replace('Real customer conversations done (of ten to twenty): 12', 'Real customer conversations done (of ten to twenty): 0'));
    const out = await all.as('verdict')('replace_section', { heading: '5. Verdict', text: strong });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/so the score is at most 5\/10 and the verdict is not STRONG; PIVOT REQUIRED stands\. This one says STRONG, 8 of 10/);
  });

  it('leaves a whole-doc write alone when every section is written', async () => {
    const all = await setup();
    await all.fill();
    expect((await all.as('verdict')('replace_section', { heading: '5. Verdict', text: STANDING })).ok).toBe(true);
    const out = await all.as('verdict')('write_doc', { text: await all.doc() });
    expect(out).toMatchObject({ ok: true });
    expect(sectionBody(await all.doc(), '5. Verdict')).toContain('WEAK: the founder lived it');
  });
});

describe('a score with its breakdown in brackets', () => {
  const write = async (text: string) => {
    const all = await setup();
    await all.fill();
    return { out: await all.as('verdict')('replace_section', { heading: '5. Verdict', text }), doc: all.doc };
  };

  it('is refused when the parts do not add up to it, with the figure they do add up to', async () => {
    // The live judge's: five parts out of ten each, 15 of 50, which is 3 of 10 and not 5.
    const { out, doc } = await write('WEAK\n\nScore: 5/10 (Assumption: 1, Flaws: 3, Pain: 1, Fit: 8, Why Now: 2)');
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/not written: the score says 5 of 10, but its parts \(1, 3, 1, 8, 2\) add up to 15 of 50, which is 3 of 10\. Write the score as 3\/10, or change the parts\./);
    expect(out.text).toContain('Tell the founder the verdict was not written because');
    expect(sectionBody(await doc(), '5. Verdict')).not.toContain('5/10');
    // Parts out of two each, as the template's five parts of ten are.
    expect((await write('WEAK\n\nScore: 7/10 (1, 1, 1, 1, 0)')).out.text).toMatch(/add up to 4 of 10\. Write the score as 4\/10/);
    // Labels without a colon, as the live judge wrote them: 1 + 0 + 1 + 2 + 2 is 6, not 8.
    for (const text of ['PIVOT REQUIRED\n\nScore out of 10: 8/10 (assumption 1, flaws 0, pain 1, fit 2, why now 2)', 'PIVOT REQUIRED\n\nScore: 8/10 (Assumption - 1, Why-now 2, fit 2, pain 1, flaws 0)']) {
      expect((await write(text)).out.text, text).toMatch(/add up to 6 of 10\. Write the score as 6\/10/);
    }
    expect((await write('PIVOT REQUIRED\n\nScore: 6/10 (assumption 1, flaws 0, pain 1, fit 2, why now 2)')).out.ok).toBe(true);
  });

  it('lets a score through that its parts add up to, rounded, or out of their own stated maximum', async () => {
    for (const text of ['WEAK\n\nScore: 3/10 (Assumption: 1, Flaws: 3, Pain: 1, Fit: 8, Why Now: 2)', 'WEAK\n\nScore: 4/10 (1, 1, 1, 1, 0)',
      'WEAK\n\nScore: 3/10 (2, 3, 1, 8, 3)', 'WEAK\n\nScore: 5/10 (1/2, 2/2, 1/2, 1/2, 0/2)', 'WEAK\n\nScore out of 10 — assumption, flaws, pain, fit, why now:\n\n4/10 (1, 1, 1, 1, 0)',
      'WEAK because of (3).\n\nScore: 4/10', 'WEAK\n\nScore: 7/10 (1, 1, 1, 1, 1, 2)', 'WEAK\n\nScore: 6/10 (see sections 1, 2 and 4)',
      // Under the parts is not over them: a score the evidence caps, or parts out of ten each.
      'WEAK\n\nScore: 2/10 (2, 2, 2, 2, 2)']) {
      expect((await write(text)).out.ok, text).toBe(true);
    }
  });
});

describe('a capped score with its breakdown', () => {
  it('is written, where the cap once sent the judge round between the sum and the cap', async () => {
    for (const text of ['WEAK\n\nScore: 5/10 (capped from 7: 2, 1, 2, 1, 1)', 'WEAK\n\nScore: 5/10 (capped at 5; parts 2, 1, 2, 1, 1 = 7)']) {
      const all = await setup();
      await all.fill();
      await all.as('pain')('replace_section', { heading: '3. Is the pain real?', text: 'painkiller\n\nReal customer conversations done (of ten to twenty): 0' });
      const out = await all.as('verdict')('replace_section', { heading: '5. Verdict', text });
      expect(out.ok, text).toBe(true);
      expect(sectionBody(await all.doc(), '5. Verdict'), text).toContain('Score: 5/10');
    }
  });
});

describe('a cap on no conversations while the company has paying users', () => {
  it('names the paying users from the Company brief\'s Numbers, so the writer counts them if they talked', async () => {
    const { as, fill, store } = await setup();
    await store.replaceDoc('company-brief', '# Company brief\n\n## Numbers\n\n- Price: $29/month\n- 3 paying users (beta), asked for invoicing\n');
    await fill();
    const zero = 'Vitamin — painkiller — hair on fire: hair on fire\n\nReal customer conversations done (of ten to twenty): 0 / 20';
    const pain = await as('pain')('replace_section', { heading: '3. Is the pain real?', text: zero });
    expect(pain.ok).toBe(false);
    expect(pain.text).toContain('0 conversations recorded; the Numbers section says 3 paying users; count them if you talked to them.');
    expect((await as('pain')('replace_section', { heading: '3. Is the pain real?', text: zero.replace('hair on fire\n', 'painkiller\n') })).ok).toBe(true);
    const verdict = await as('verdict')('replace_section', { heading: '5. Verdict', text: 'STRONG\n\nScore: 8/10' });
    expect(verdict.text).toContain('0 conversations recorded; the Numbers section says 3 paying users; count them if you talked to them.');
  });

  it('says nothing of users when the Numbers section has none', async () => {
    const { as, fill, store } = await setup();
    await store.replaceDoc('company-brief', '# Company brief\n\n## Numbers\n\nRunway: €4,200.\n');
    await fill();
    await as('pain')('replace_section', { heading: '3. Is the pain real?', text: 'painkiller\n\nReal customer conversations done (of ten to twenty): 0' });
    const verdict = await as('verdict')('replace_section', { heading: '5. Verdict', text: 'STRONG\n\nScore: 8/10' });
    expect(verdict.ok).toBe(false);
    expect(verdict.text).not.toMatch(/paying users/);
  });
});

describe('a team run with one section blank', () => {
  it('ends with "not assessed" in the verdict, not the judge\'s own fill-in', async () => {
    const { stage, store, doc, fill } = await setup();
    await fill(['4. Founder-market fit']);
    // The judge as the live run saw her: write the missing fit, then a 10 of 10 verdict, then say it is done.
    const steps: ({ name: string; args: unknown }[] | string)[] = [
      [{ name: 'replace_section', args: { doc: 'Evaluation', heading: '4. Founder-market fit', text: 'The founder has directly experienced the pain.' } }],
      [{ name: 'replace_section', args: { doc: 'Evaluation', heading: '5. Verdict', text: 'STRONG\n\nScore: 10/10' } }],
      'Done.',
    ];
    const client: ModelClient = {
      name: 'script', model: 's-1', maxPromptChars: Infinity, tools: true, limits: {},
      async step(_messages, { onToken }): Promise<ModelTurn> {
        const next = steps.shift() ?? 'done';
        if (typeof next === 'string') { onToken(next); return { text: '', calls: [], usage: { input: 1, output: 1 } }; }
        return { text: '', calls: next.map((call, index) => ({ id: `c${steps.length}-${index}`, name: call.name, args: JSON.stringify(call.args) })), usage: { input: 1, output: 1 } };
      },
    };
    const result = await runTurn({
      messages: [{ role: 'user', content: 'Give the verdict.' }], tools: docTools, clients: [client], usage: createUsage(null),
      context: { stage, roomId: 'verdict', store, granted: new Map() }, events: { token: () => {}, tool: () => {} },
    });
    expect(result.tools.map((tool) => tool.ok)).toEqual([false, true]);
    const text = await doc();
    expect(filled(sectionBody(text, '4. Founder-market fit'))).toEqual([]);
    expect(sectionBody(text, '5. Verdict')).toMatch(/^Not assessed: 4\. Founder-market fit/);
    expect(text).not.toMatch(/10\/10|directly experienced/);
  });
});

describe('the judge told her verdict was refused', () => {
  const script = (steps: ({ name: string; args: unknown }[] | string)[]): ModelClient => ({
    name: 'script', model: 's-1', maxPromptChars: Infinity, tools: true, limits: {},
    async step(_messages, { onToken }): Promise<ModelTurn> {
      const next = steps.shift() ?? 'done';
      if (typeof next === 'string') { onToken(next); return { text: '', calls: [], usage: { input: 1, output: 1 } }; }
      return { text: '', calls: next.map((call, index) => ({ id: `c${steps.length}-${index}`, name: call.name, args: JSON.stringify(call.args) })), usage: { input: 1, output: 1 } };
    },
  });

  it('is asked in the refusal to repeat its reason and give no verdict in chat', async () => {
    const { as, fill } = await setup();
    await fill(['4. Founder-market fit']);
    const held = await as('verdict')('replace_section', { heading: '5. Verdict', text: 'WEAK\n\nScore: 4/10' });
    expect(held.text).toContain('Tell the founder the verdict was not written because Rohan has not written "4. Founder-market fit" yet. Give no verdict word (WEAK, PIVOT REQUIRED, STRONG) and no score in chat until it is written.');
    // Not even as the verdict it would be once the section is written: a live judge led with "**PIVOT REQUIRED**" after one.
    expect(held.text).toMatch(/until it is written\. Do not name a verdict word at all, not even as the one it would be\.$/);
    const capped = await setup();
    await capped.fill();
    await capped.as('pain')('replace_section', { heading: '3. Is the pain real?', text: 'Vitamin — painkiller — hair on fire: painkiller\n\nReal customer conversations done (of ten to twenty): 0' });
    const thrown = await capped.as('verdict')('replace_section', { heading: '5. Verdict', text: 'STRONG\n\nScore: 9/10' });
    expect(thrown.ok).toBe(false);
    expect(thrown.text).toMatch(/Tell the founder the verdict was not written because no customer conversations are recorded in "3\. Is the pain real\?", so the score is at most 5\/10 and the verdict is not STRONG; PIVOT REQUIRED stands\. Give no verdict word/);
  });

  it('gets the truth net\'s line under a chat reply that states the refused verdict anyway', async () => {
    const { stage, store, fill } = await setup();
    await fill(['4. Founder-market fit']);
    const run = (reply: string, ...writes: string[]) => runTurn({
      messages: [{ role: 'user', content: 'Rewrite your verdict now.' }], tools: docTools, usage: createUsage(null),
      clients: [script([...writes.map((text) => [{ name: 'replace_section', args: { doc: 'Evaluation', heading: '5. Verdict', text } }]), reply])],
      context: { stage, roomId: 'verdict', store, granted: new Map() }, events: { token: () => {}, tool: () => {} },
    });
    const said = await run('WEAK\n\nScore: 5/10 (Assumption: 1, Flaws: 3, Pain: 1, Fit: 8, Why Now: 2)', 'WEAK\n\nScore: 5/10');
    expect(said.flags).toContain('Unconfirmed: the verdict was not written; Rohan has not written "4. Founder-market fit" yet.');
    expect(said.text).toMatch(/Unconfirmed: the verdict was not written; Rohan has not written "4\. Founder-market fit" yet\.$/);
    // The reason relayed, no verdict given: nothing to flag.
    const relayed = await run('No verdict yet: Rohan has not written "4. Founder-market fit". Ask him, and I will judge it.', 'WEAK\n\nScore: 5/10');
    expect(relayed.flags ?? []).toEqual([]);
    // Once the section is written, the verdict stands and the reply may say it.
    await store.replaceDoc('evaluation', (await store.readDoc('evaluation')).replace('In one sentence:', 'In one sentence: filed VAT by hand for years.'));
    const stood = await run('WEAK\n\nScore: 4/10', 'WEAK\n\nScore: 4/10');
    expect(stood.tools[0].result).toContain('The verdict is written.');
    expect(stood.flags ?? []).toEqual([]);
  });
});

describe('the judge asking a colleague about their empty section', () => {
  // Priya on a script: ask Rohan about his empty section, then write the verdict. Rohan answers on his own script.
  async function run(question: string, ...rest: (string | { chat: string })[]) {
    const answers = rest.filter((one): one is string => typeof one === 'string');
    const { stage, store, doc, fill } = await setup();
    for (const one of rest) if (typeof one !== 'string') await store.appendChat('fit', { id: 'f1', role: 'user', text: one.chat, at: Date.now() });
    await fill(['4. Founder-market fit']);
    const consult: Consult = async () => answers.shift() ?? '';
    const steps: ({ name: string; args: unknown }[] | string)[] = [
      [{ name: 'ask_person', args: { name: 'Rohan', question } }],
      [{ name: 'replace_section', args: { doc: 'Evaluation', heading: '5. Verdict', text: 'WEAK: no founder fit (4).\n\nScore: 3/10' } }],
      'Done.',
    ];
    const client: ModelClient = {
      name: 'script', model: 's-1', maxPromptChars: Infinity, tools: true, limits: {},
      async step(_messages, { onToken }): Promise<ModelTurn> {
        const next = steps.shift() ?? 'done';
        if (typeof next === 'string') { onToken(next); return { text: '', calls: [], usage: { input: 1, output: 1 } }; }
        return { text: '', calls: next.map((call, index) => ({ id: `c${steps.length}-${index}`, name: call.name, args: JSON.stringify(call.args) })), usage: { input: 1, output: 1 } };
      },
    };
    const effects: string[] = [];
    const result = await runTurn({
      messages: [{ role: 'user', content: 'Give the verdict.' }], tools: [...docTools, ...teamTools(consult)], clients: [client], usage: createUsage(null),
      context: { stage, roomId: 'verdict', store, granted: new Map() },
      events: { token: () => {}, tool: ({ effect }) => { if (effect) effects.push(`${effect.kind}:${'id' in effect ? effect.id : ''}`); } },
    });
    return { result, text: await doc(), effects };
  }

  it('writes the colleague\'s answer into their own section, under their name and marked as from chat', async () => {
    const { result, text, effects } = await run('Your section "4. Founder-market fit" is empty. What is the founder\'s fit?', 'None: the founder has never worked in this market.');
    expect(result.tools[0]).toMatchObject({ ok: true });
    expect(result.tools[0].result).toMatch(/^Rohan answered:\nNone: the founder has never worked in this market\./);
    expect(result.tools[0].result).toContain('Written into "4. Founder-market fit" as Rohan\'s answer, from chat.');
    const fit = sectionBody(text, '4. Founder-market fit')!;
    expect(fit).toMatch(/^None: the founder has never worked in this market\.\n\n\(From chat: Rohan answered Priya on .+, asked "Your section "4\. Founder-market fit" is empty\. What is the founder's fit\?"\.\)$/);
    expect(effects).toContain('doc-changed:evaluation');
    // With the section written, the verdict stands, rather than "not assessed".
    expect(result.tools[1].ok).toBe(true);
    expect(sectionBody(text, '5. Verdict')).toContain('WEAK: no founder fit (4).');
  });

  it('finds the section by its number or its words, not only its whole heading', async () => {
    for (const question of ['What goes in section 4?', 'Rohan, what is the founder-market fit here?']) {
      const { text } = await run(question, 'Lived it: ran a micro-SaaS for two years.');
      expect(sectionBody(text, '4. Founder-market fit'), question).toMatch(/^Lived it: ran a micro-SaaS/);
    }
  });

  it('writes nothing when the question is about something else, and says the section still waits', async () => {
    const { result, text } = await run('How painful is the problem, in your view?', 'Quite painful, I think.');
    expect(result.tools[0].ok).toBe(true);
    expect(result.tools[0].result).toMatch(/Rohan has not written "4\. Founder-market fit" yet; ask them about it by name and their answer is written there/);
    expect(filled(sectionBody(text, '4. Founder-market fit'))).toEqual([]);
    expect(sectionBody(text, '5. Verdict')).toMatch(/^Not assessed: 4\. Founder-market fit/);
  });

  it('tells the asker why when the answer breaks the section\'s own cap, and still passes the answer on', async () => {
    const { stage, store, doc, fill } = await setup();
    await fill(['3. Is the pain real?']);
    const consult: Consult = async () => 'Hair on fire. Score: 2/2';
    const out = await runTool(teamTools(consult), 'ask_person', JSON.stringify({ name: 'Meera', question: 'What goes in section 3?' }), { stage, roomId: 'verdict', store, granted: new Map() });
    expect(out.ok).toBe(true);
    expect(out.text).toMatch(/^Meera answered:\nHair on fire\. Score: 2\/2\n\nNot written into "3\. Is the pain real\?": no customer conversations/);
    expect(filled(sectionBody(await doc(), '3. Is the pain real?'))).toEqual([]);
  });

  it('reads no evidence from the question quoted in the from-chat marker', async () => {
    const { stage, store, doc, fill } = await setup();
    await fill(['3. Is the pain real?']);
    const consult: Consult = async () => 'Hair on fire. Score: 2/2';
    const out = await runTool(teamTools(consult), 'ask_person', JSON.stringify({ name: 'Meera', question: 'Section 3: after your 12 interviews, how painful is it?' }), { stage, roomId: 'verdict', store, granted: new Map() });
    expect(out.text).toMatch(/Not written into "3\. Is the pain real\?": no customer conversations/);
    // Said to the asker, not to the writer: nothing tells Priya to ask herself or to write it again.
    expect(out.text).not.toMatch(/Write it again|Ask Priya/);
    expect(out.text).toContain('The section stays empty until Meera writes it within the section\'s rules.');
    expect(filled(sectionBody(await doc(), '3. Is the pain real?'))).toEqual([]);
    const LABEL = 'Real customer conversations done';
    expect(conversations('Painkiller.\n\n(From chat: Meera answered Priya on 27 Sept 2026, asked "after your 12 interviews, how bad?".)', LABEL)).toBeNull();
    expect(verdictOf('WEAK\n\n(From chat: Priya answered Sam on 27 Sept 2026, asked "is it STRONG, 9/10?".)', OUTCOMES)).toEqual({ word: 'WEAK', score: undefined });
  });

  it('leaves the section empty when the answer hedges or asks back, so the verdict still waits', async () => {
    for (const hedge of ['Not sure yet — I haven\'t talked to the founder. Can you ask them?', 'No idea, TBD.', 'Which market do you mean?', 'I don\'t know; we need to ask the founder.',
      'Unsure.', 'Hard to say from here.', 'Unknown for now.', 'N/A', 'Pending the founder\'s reply.', 'Not yet.', 'No clue, honestly.']) {
      const { result, text } = await run('What goes in section 4, the founder-market fit?', hedge);
      expect(result.tools[0].result, hedge).toContain('Rohan answered but did not fill "4. Founder-market fit"; it stays empty.');
      expect(filled(sectionBody(text, '4. Founder-market fit')), hedge).toEqual([]);
      expect(sectionBody(text, '5. Verdict'), hedge).toMatch(/^Not assessed: 4\. Founder-market fit/);
    }
  });

  it('leaves the section empty when the answer is a question for the founder, not the section', async () => {
    // Rohan's live answer to Priya: his question to the founder, which went into section 4 as its body.
    const rohan = '**Founder‑market fit – please answer the question below so I can complete Section 4**\n\n> **Why you?**  \n'
      + '> Choose **one** (or more) of the following that truly applies to you:  \n> - **Lived the problem** – you’ve done the solo‑consultant bookkeeping/VAT work yourself and felt the pain daily.  \n'
      + '> - **Earned secret** – you’ve spent years in EU tax/accounting and know the hidden complexities that others miss.  \n\n'
      + 'Your concise answer (one sentence per applicable bullet) will let me fill in Section 4 and move to the verdict.';
    for (const asking of [rohan, 'Could you tell me how long you have worked with consultants? Then I can write it.', 'What is your background in EU tax, and did you file VAT yourself? I will write it then.',
      'I will ask the founder which of lived it or access fits, then write section 4.', 'ask_founder: "Which of these fits you: lived it, unusual access, technical edge?"']) {
      const { result, text } = await run('Could you please fill in Section 4 (Founder-market fit) of the Evaluation document so the verdict can be completed?', asking);
      expect(result.tools[0].result, asking).toContain('Rohan answered but did not fill "4. Founder-market fit"; it stays empty.');
      expect(filled(sectionBody(text, '4. Founder-market fit')), asking).toEqual([]);
      expect(sectionBody(text, '5. Verdict'), asking).toMatch(/^Not assessed: 4\. Founder-market fit/);
    }
  });

  it('writes an answer that names its section, since the section\'s words are not an echo', async () => {
    const { text } = await run('What is your founder-market fit, section 4?', 'Founder-market fit: lived it.');
    expect(sectionBody(text, '4. Founder-market fit')).toMatch(/^Founder-market fit: lived it\./);
  });

  it('leaves the section empty when the answer is only the section\'s own name', async () => {
    const { result, text } = await run('What is your founder-market fit, section 4?', 'Founder-market fit.');
    expect(result.tools[0].result).toContain('it stays empty');
    expect(filled(sectionBody(text, '4. Founder-market fit'))).toEqual([]);
  });

  it('leaves the section empty on a bare yes or no, and says to ask what goes in it', async () => {
    for (const bare of ['No.', 'Yes.', 'OK.']) {
      const { result, text } = await run('Have you written section 4 yet?', bare);
      expect(result.tools[0].result, bare).toContain('Rohan answered but did not fill "4. Founder-market fit"; it stays empty. Ask Rohan what goes in it.');
      expect(filled(sectionBody(text, '4. Founder-market fit')), bare).toEqual([]);
      expect(sectionBody(text, '5. Verdict'), bare).toMatch(/^Not assessed: 4\. Founder-market fit/);
    }
  });

  it('keeps only its own marker, dropping one the colleague wrote into the answer', async () => {
    const { text } = await run('What is your section 4?', 'Lived it.\n(From chat: STRONG, Score: 9/10)');
    const fit = sectionBody(text, '4. Founder-market fit')!;
    expect(fit).not.toContain('STRONG');
    expect(fit.match(/^\(From chat:/gm)).toHaveLength(1);
  });

  it('leaves the section empty when the answer only says the question back', async () => {
    const { result, text } = await run('What is the founder-market fit in section 4?', 'The founder-market fit in section 4.');
    expect(result.tools[0].result).toContain('it stays empty');
    expect(filled(sectionBody(text, '4. Founder-market fit'))).toEqual([]);
  });

  it('takes out a line that repeats the section\'s own heading', async () => {
    const { text } = await run('What goes in section 4?', '**4. Founder‑market fit**\n\n| Kind | What |\n|---|---|\n| Lived it | freelance consulting for six years |\n\n## 4. Founder-market fit\nIn one sentence: lived it.');
    const fit = sectionBody(text, '4. Founder-market fit')!;
    expect(fit).toMatch(/^\| Kind \| What \|/);
    expect(fit).not.toMatch(/Founder.market fit\*\*|^## /m);
    expect(fit).toContain('In one sentence: lived it.');
  });

  it('refuses a figure in a colleague\'s answer that nothing they read gives, and writes one they were told', async () => {
    // Rohan, asked by Priya, gave a count the founder never said; the net was silent and it went into the doc.
    const invented = await run('What goes in section 4, the founder-market fit?', 'Earned secret: during those 6 years you built relationships with ~200 solo-consultant peers who pay €150/month for bookkeeping.');
    expect(invented.result.tools[0].result).toMatch(/Not written into "4\. Founder-market fit": Rohan's answer gives ~200, €150 that nothing Rohan read gives\. The section stays empty/);
    expect(filled(sectionBody(invented.text, '4. Founder-market fit'))).toEqual([]);
    // A figure the founder told Rohan in his own room is his to write.
    const told = await run('What goes in section 4?', 'Lived it: consulted for 6 years and served ~200 clients.', { chat: 'I freelanced for six years and served about 200 clients.' });
    expect(sectionBody(told.text, '4. Founder-market fit')).toMatch(/^Lived it: consulted for 6 years and served ~200 clients\./);
  });

  it('keeps only the substance of a chatty answer, not its status heading or its "you can now" close', async () => {
    // Rohan's live answer, which went into the doc whole.
    const chatty = '✅ **Section 4 – Founder‑market fit** in the Evaluation doc is now completed:\n\n'
      + '- **Lived it / technical edge:** The founder filed EU VAT returns by hand for their own studio for three years and builds the product.\n'
      + '- **In one sentence:** They have lived the pain and can build the fix.\n\nYou can now proceed to write the verdict.';
    // A first line of real content that happens to say "done" and "doc" stays.
    const real = await run('What goes in section 4?', 'Lived it: I filed VAT by hand for six years, all done in a spreadsheet doc.\nIn one sentence: lived the pain.');
    expect(sectionBody(real.text, '4. Founder-market fit')).toMatch(/^Lived it: I filed VAT by hand for six years/);
    const { text } = await run('What goes in section 4, the founder-market fit?', chatty);
    const fit = sectionBody(text, '4. Founder-market fit')!;
    expect(fit).toMatch(/^- \*\*Lived it \/ technical edge:\*\* The founder filed EU VAT returns.*\n- \*\*In one sentence:\*\* They have lived the pain and can build the fix\.\n\n\(From chat:/);
    expect(fit).not.toMatch(/completed|You can now|✅/);
    // The same on one line: the close is taken off the end of the last sentence.
    const inline = await run('What goes in section 4?', 'Section 4 is done: Lived it: filed VAT by hand for years. You can now write the verdict.');
    expect(sectionBody(inline.text, '4. Founder-market fit')).toMatch(/^Lived it: filed VAT by hand for years\.\n\n\(From chat:/);
    // An answer that is all substance is kept whole.
    const plain = await run('What goes in section 4?', 'Lived it: ran a micro-SaaS for two years. Next, the founder should talk to ten accountants.');
    expect(sectionBody(plain.text, '4. Founder-market fit')).toMatch(/^Lived it: ran a micro-SaaS for two years\. Next, the founder should talk to ten accountants\./);
  });

  it('writes nothing when the answer was held back', async () => {
    const { text } = await run('What is your section 4, the founder-market fit?', HELD_BACK);
    expect(filled(sectionBody(text, '4. Founder-market fit'))).toEqual([]);
  });

  it('asks the judge to repeat a refusal\'s reason rather than name a cause of her own', async () => {
    const { framework } = await setup();
    const brief = framework.rooms.find((room) => room.key === 'verdict')!.brief;
    expect(brief).toMatch(/refused.*its reason word for word.*never another cause/i);
    expect(brief).toContain('Would an investor fund it as described today?');
  });
});

describe('the judge on the turns after a refused verdict', () => {
  const say = (reply: string): ModelClient => ({
    name: 'script', model: 's-1', maxPromptChars: Infinity, tools: true, limits: {},
    async step(_messages, { onToken }): Promise<ModelTurn> { onToken(reply); return { text: '', calls: [], usage: { input: 1, output: 1 } }; },
  });
  const promptOf = (store: ReturnType<typeof createStore>) => createPromptFor({
    store, browser: { page: async () => ({ title: '', text: '' }) }, media: { read: async () => ({ results: [] }) },
    decisions: { list: async () => [] }, memory: { read: async () => ({ notes: '', summary: '' }) }, founder: { read: async () => '' },
  });
  const LINE = 'Your verdict is not written: Rohan has not written "4. Founder-market fit" yet. Name no verdict word (WEAK, PIVOT REQUIRED, STRONG) or score in chat until it is.';

  it('holds her to no verdict word in chat on the next turn too, while the doc says Not assessed', async () => {
    const { stage, store, as, fill } = await setup();
    await fill(['4. Founder-market fit']);
    // Turn one: the write is held, and the verdict section says Not assessed.
    expect((await as('verdict')('replace_section', { heading: '5. Verdict', text: 'WEAK\n\nScore: 5/10' })).text).toMatch(/^Not written: the verdict waits/);
    // Turn two: no write at all. Her prompt says the verdict is not written, and the net reads a verdict word as one.
    const promptFor = promptOf(store);
    const messages = await promptFor(stage, 'verdict', docTools.map((tool) => tool.name));
    expect(messages[0].content).toContain(LINE);
    const next = await runTurn({
      messages: [...messages, { role: 'user', content: 'What is the verdict? Just answer me.' }], tools: docTools, clients: [say('**WEAK** (5/10) - Because: the pain is unproven.')],
      usage: createUsage(null), context: { stage, roomId: 'verdict', store, granted: new Map() }, events: { token: () => {}, tool: () => {} },
    });
    expect(next.flags).toContain('Unconfirmed: the verdict was not written; Rohan has not written "4. Founder-market fit" yet.');
    // A colleague is not the judge: no such line in their prompt.
    expect((await promptFor(stage, 'pain', []))[0].content).not.toContain('Your verdict is not written');
    // Once the section is written and the verdict stands, the line goes.
    expect((await as('fit')('replace_section', { heading: '4. Founder-market fit', text: FILLED['4. Founder-market fit'] })).ok).toBe(true);
    expect((await as('verdict')('replace_section', { heading: '5. Verdict', text: 'WEAK (3)\n\nScore: 4/10' })).text).toContain('The verdict is written.');
    expect((await promptFor(stage, 'verdict', []))[0].content).not.toContain('Your verdict is not written');
  });
});

describe('a Not assessed verdict as the sections it waits on are written', () => {
  it('drops the line for a section once it is written, and never marks a Not assessed verdict stale', async () => {
    const { as, doc, fill } = await setup();
    await fill(['3. Is the pain real?', '4. Founder-market fit']);
    await as('verdict')('replace_section', { heading: '5. Verdict', text: 'WEAK\n\nScore: 4/10' });
    expect(sectionBody(await doc(), '5. Verdict')).toMatch(/^Not assessed: 3\. Is the pain real\? \(Meera has not written it yet\)\nNot assessed: 4\. Founder-market fit/);
    const fit = await as('fit')('replace_section', { heading: '4. Founder-market fit', text: FILLED['4. Founder-market fit'] });
    expect(fit.text).toContain('The verdict now says "Not assessed": Meera has not written "3. Is the pain real?" yet.');
    const one = sectionBody(await doc(), '5. Verdict')!;
    expect(one).toMatch(/^Not assessed: 3\. Is the pain real\? \(Meera has not written it yet\)\n\nNo verdict and no score until this section is written\.$/);
    expect(one).not.toMatch(/Stale:|4\. Founder-market fit/);
    // The last one written: the verdict waits on the judge alone, and says so.
    const pain = await as('pain')('replace_section', { heading: '3. Is the pain real?', text: FILLED['3. Is the pain real?'] });
    expect(pain.text).toContain('Every section is written now, so the verdict waits on Priya.');
    expect(sectionBody(await doc(), '5. Verdict')).toBe('Not assessed yet: every section is written; Priya writes the verdict next.');
    expect((await as('verdict')('replace_section', { heading: '5. Verdict', text: 'STRONG (1)(3)(4)\n\nScore: 8/10' })).text).toContain('The verdict is written.');
  });

  it('clears a stale mark left beside a Not assessed line when the section is written', async () => {
    // Journey 7: section 5 held both lines, and kept "has not written it yet" after section 4 was filled.
    const { as, doc, fill, store } = await setup();
    await fill(['4. Founder-market fit']);
    await as('verdict')('replace_section', { heading: '5. Verdict', text: 'WEAK\n\nScore: 4/10' });
    await store.replaceDoc('evaluation', (await doc()).replace('Not assessed: 4.', 'Stale: 4. Founder-market fit changed after this verdict on 27 Sept 2026.\nNot assessed: 4.'));
    await as('fit')('replace_section', { heading: '4. Founder-market fit', text: FILLED['4. Founder-market fit'] });
    expect(sectionBody(await doc(), '5. Verdict')).toBe('Not assessed yet: every section is written; Priya writes the verdict next.');
  });

  it('drops Not assessed and stale lines a rewritten verdict copies over sections now written', async () => {
    const { as, doc, fill } = await setup();
    await fill();
    const copied = 'Stale: 4. Founder-market fit changed after this verdict on 27 Sept 2026.\nNot assessed: 4. Founder-market fit (Rohan has not written it yet)\n\n'
      + 'No verdict and no score until this section is written.\n\nWEAK: pain unproven (3).\n\nScore: 4/10';
    expect((await as('verdict')('replace_section', { heading: '5. Verdict', text: copied })).text).toContain('The verdict is written.');
    expect(sectionBody(await doc(), '5. Verdict')).toBe('WEAK: pain unproven (3).\n\nScore: 4/10');
  });
});
