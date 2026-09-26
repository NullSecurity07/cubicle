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
import { runTool } from './registry.ts';
import { filled, sectionBody, verdictOf } from './verdict.ts';

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
      const by = placed.docs[0].rules!.sections.find((one) => one.heading === heading)!.by;
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
    expect(out.text).toMatch(/^Not written: the verdict waits for "4\. Founder-market fit", which is empty\..*Ask Rohan with ask_person/);
    const verdict = sectionBody(await doc(), '5. Verdict')!;
    expect(verdict).toMatch(/^Not assessed: 4\. Founder-market fit\n\nNo verdict and no score/);
    expect(verdict).not.toMatch(/STRONG|10\/10/);
  });

  it('caps the verdict at WEAK and 5 of 10 when no customer conversations are recorded', async () => {
    const { as, doc, fill } = await setup();
    await fill();
    expect((await as('pain')('replace_section', { heading: '3. Is the pain real?', text: 'Vitamin — painkiller — hair on fire: painkiller\n\nReal customer conversations done (of ten to twenty): 0' })).ok).toBe(true);
    const strong = await as('verdict')('replace_section', { heading: '5. Verdict', text: 'STRONG\n\nScore out of 10: 10/10' });
    expect(strong.ok).toBe(false);
    expect(strong.text).toMatch(/no customer conversations are recorded.*at most WEAK and the score at most 5 of 10\. This one says STRONG, 10 of 10/);
    expect((await as('verdict')('replace_section', { heading: '5. Verdict', text: 'PIVOT REQUIRED (3)\n\nScore: 6/10' })).ok).toBe(false);
    expect((await as('verdict')('replace_section', { heading: '5. Verdict', text: 'WEAK: no conversations yet (3).\n\nScore: 5/10' })).ok).toBe(true);
    expect(sectionBody(await doc(), '5. Verdict')).toContain('WEAK: no conversations yet (3).');
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
