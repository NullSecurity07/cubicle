import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Framework } from '../../shared/frameworks.ts';
import { DOC_SIZE, FRAMEWORK_ID, sizeLine } from '../../shared/frameworks.ts';
import { seedStage } from '../../shared/model.ts';
import { MOST_BRIEF_CHARS } from '../forge/propose.ts';
import { idOf } from '../library/notes.ts';
import { titleOfNote } from './store.ts';

// The first framework that shipped with the app. It is a hand-written file, so nothing else in the build would notice if
// a brief grew past what a prompt should carry, a wire pointed at a key nobody has, or the note it was built from was
// edited without its hash being written again. This does.
const here = resolve(import.meta.dirname, '../../frameworks/startup-evaluation');
const NOTE_FILE = 'startup-evaluation-notes.md';
const MOST_BRIEF = 1500;

const load = async () => JSON.parse(await readFile(resolve(here, 'framework.json'), 'utf8')) as Framework;
const note = () => readFile(resolve(here, 'notes', NOTE_FILE), 'utf8');

describe('the startup evaluation framework', () => {
  it('is the five steps of the note, left to right, and says so in one line', async () => {
    const framework = await load();
    expect(framework.rooms.map((room) => room.role)).toEqual(['Assumption finder', 'Death hunter', 'Pain validator', 'Founder-fit', 'Verdict judge']);
    expect(framework.rooms.every((room) => room.name.trim() && /^#[0-9a-f]{6}$/.test(room.accent))).toBe(true);
    // Read left to right, the people are the note's own order: assumption, flaws, pain, fit, verdict.
    const across = framework.rooms.map((room) => framework.layout[room.key].x);
    expect([...across].sort((one, two) => one - two)).toEqual(across);
    expect(sizeLine(framework)).toBe('5 people · 1 doc · 1 browser · 1 note');
  });

  it('gives every person a brief a prompt can carry, written from the note and naming their step', async () => {
    const framework = await load();
    const steps = ['STEP ONE', 'STEP TWO', 'STEP THREE', 'STEP FOUR', 'STEP FIVE'];
    framework.rooms.forEach((room, at) => {
      expect(room.brief.length).toBeLessThanOrEqual(MOST_BRIEF);
      expect(room.brief).toContain(steps[at]);
      expect(room.brief).toContain('Evaluating a Startup Idea — First-Time Founder Notes');
    });
    // The rules the note is emphatic about, each in the brief of whoever is meant to hold to it.
    const [assumption, deaths, pain, fit, verdict] = framework.rooms.map((room) => room.brief);
    expect(assumption).toContain('falsifiable sentence');
    expect(deaths).toContain('specific');
    expect(pain).toContain('Mom Test');
    expect(fit).toContain('why you?');
    for (const word of ['STRONG', 'WEAK', 'PIVOT REQUIRED', 'It has potential, but']) expect(verdict).toContain(word);
  });

  it('shares one doc with a section for every step, and stands a browser and the note beside them', async () => {
    const framework = await load();
    expect(framework.docs.map((doc) => doc.title)).toEqual(['Evaluation']);
    for (const heading of ['## 1. Core assumption', '## 2. Three specific ways it dies', '## 3. Is the pain real?', '## 4. Founder-market fit', '## 5. Verdict']) {
      expect(framework.docs[0].text).toContain(heading);
    }
    expect(framework.cards.map((card) => card.kind)).toEqual(['browser', 'library']);
  });

  it('wires everybody to the doc and the note, the two who look things up to the browser, and the judge to the rest', async () => {
    const framework = await load();
    const keys = new Set([...framework.rooms, ...framework.docs, ...framework.cards].map((one) => one.key));
    for (const wire of framework.wires) { expect(keys.has(wire.from)).toBe(true); expect(keys.has(wire.to)).toBe(true); }
    for (const key of Object.keys(framework.layout)) expect(keys.has(key)).toBe(true);
    expect([...keys].every((key) => key in framework.layout)).toBe(true);
    const wired = new Set(framework.wires.map((wire) => `${wire.from}>${wire.to}`));
    const people = framework.rooms.map((room) => room.key);
    const [doc, notes, browser] = [framework.docs[0].key, framework.cards[1].key, framework.cards[0].key];
    for (const key of people) { expect(wired.has(`${key}>${doc}`)).toBe(true); expect(wired.has(`${notes}>${key}`)).toBe(true); }
    expect(wired.has(`${people[1]}>${browser}`)).toBe(true);
    expect(wired.has(`${people[2]}>${browser}`)).toBe(true);
    for (const key of people.slice(0, 4)) expect(wired.has(`${people[4]}>${key}`)).toBe(true);
  });

  it('was built from the note beside it, and says which version', async () => {
    const [framework, words] = [await load(), await note()];
    expect(framework.notes).toHaveLength(1);
    expect(framework.notes[0].id).toBe(idOf(titleOfNote(NOTE_FILE, words)));
    // The hash is what a later round uses to notice the founder has edited the note since. It has to be of the words
    // that are really in the file, so it is checked here rather than trusted.
    expect(framework.notes[0].hash).toBe(createHash('sha1').update(words).digest('hex'));
    const card = framework.cards.find((one) => one.kind === 'library');
    expect(card && 'noteId' in card && card.noteId).toBe(framework.notes[0].id);
  });

  it('comes with a dataset drawn from the note, every case belonging to somebody', async () => {
    const framework = await load();
    expect(framework.dataset.length).toBeGreaterThanOrEqual(8);
    const people = new Set(framework.rooms.map((room) => room.key));
    const seen = new Set<string>();
    for (const held of framework.dataset) {
      expect(held.keys.length).toBeGreaterThan(0);
      for (const key of held.keys) expect(people.has(key)).toBe(true);
      expect(held.input.trim()).not.toBe('');
      // Every case says how it is judged: the answer the note states, or the criteria in the note's own words.
      expect(held.expected?.trim() || held.rubric?.trim()).toBeTruthy();
      expect(held.addedBy).toBe('founder');
      expect(seen.has(held.id)).toBe(false);
      seen.add(held.id);
    }
    // Every person has something to be tested on, so no brief goes unmeasured when the evals round comes.
    for (const key of people) expect(framework.dataset.some((held) => held.keys.includes(key))).toBe(true);
  });
});

// Every framework that ships, whoever wrote it: the rules a hand-written file can break without anything else in the
// build noticing, checked the same way for each.
const shelf = resolve(import.meta.dirname, '../../frameworks');
const builtIns = async () => (await readdir(shelf, { withFileTypes: true })).filter((one) => one.isDirectory()).map((one) => one.name).sort();
const loadOne = async (dir: string) => JSON.parse(await readFile(resolve(shelf, dir, 'framework.json'), 'utf8')) as Framework;
type Box = { x: number; y: number; w: number; h: number };
const overlap = (one: Box, other: Box) => one.x < other.x + other.w && other.x < one.x + one.w && one.y < other.y + other.h && other.y < one.y + one.h;

// The teams on the shelf, in folder order. A folder added without being named here is a team nobody decided to ship.
const SHIPPED = ['customer-discovery', 'due-diligence', 'hiring-scorecard', 'investor-update', 'launch-team', 'lean-canvas', 'linkedin-content-system', 'pitch-practice', 'pmf-engine',
  'positioning', 'pre-mortem', 'pricing-unit-economics', 'seed-round-prep', 'startup-evaluation', 'traction-bullseye', 'weekly-metrics', 'working-backwards'];
// The teams written after the eval runner stopped offering tools, held to the same rule as the three that lean on them.
// The one-page plan is left out only of the one-case-per-person count: two people and at least three cases cannot be both.
const NO_TOOL_CASES = ['launch-team', 'pitch-practice', 'due-diligence', 'linkedin-content-system', 'weekly-metrics', 'customer-discovery', 'investor-update', 'pmf-engine', 'seed-round-prep', 'pre-mortem',
  'pricing-unit-economics', 'traction-bullseye', 'hiring-scorecard', 'positioning', 'working-backwards'];

describe('every built-in framework', () => {
  it('ships every team on the shelf', async () => {
    expect(await builtIns()).toEqual(SHIPPED);
  });

  it('is named by its folder, and gives every person a name, a colour and a brief the forge would accept', async () => {
    for (const dir of await builtIns()) {
      const framework = await loadOne(dir);
      expect(framework.id).toBe(dir);
      expect(FRAMEWORK_ID.test(framework.id)).toBe(true);
      expect(framework.name.trim() && framework.intent.trim()).toBeTruthy();
      for (const room of framework.rooms) {
        expect(room.name.trim() && room.role.trim()).toBeTruthy();
        expect(room.accent).toMatch(/^#[0-9a-f]{6}$/);
        expect(room.brief.length).toBeLessThanOrEqual(MOST_BRIEF_CHARS);
      }
      expect(new Set(framework.rooms.map((room) => room.name)).size).toBe(framework.rooms.length);
    }
  });

  it('wires and places only what it has, and nothing it places stands on anything else', async () => {
    for (const dir of await builtIns()) {
      const framework = await loadOne(dir);
      const all = [...framework.rooms, ...framework.docs.map((doc) => ({ ...doc, w: doc.w ?? DOC_SIZE.w, h: doc.h ?? DOC_SIZE.h })), ...framework.cards];
      const keys = all.map((one) => one.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const wire of framework.wires) { expect(keys).toContain(wire.from); expect(keys).toContain(wire.to); }
      expect(Object.keys(framework.layout).sort()).toEqual([...keys].sort());
      const boxes = all.map((one) => ({ key: one.key, ...framework.layout[one.key], w: one.w, h: one.h }));
      for (const [at, one] of boxes.entries()) for (const other of boxes.slice(at + 1)) expect(overlap(one, other), `${dir}: ${one.key} and ${other.key}`).toBe(false);
      // Everybody is wired to a doc they write into.
      const docs = new Set(framework.docs.map((doc) => doc.key));
      for (const room of framework.rooms) expect(framework.wires.some((wire) => (wire.from === room.key && docs.has(wire.to)) || (wire.to === room.key && docs.has(wire.from)))).toBe(true);
      for (const card of framework.cards) if (card.kind === 'source') { expect(card.url).toMatch(/^https:\/\//); expect(card.about.trim()).not.toBe(''); }
    }
  });

  // A colleague is asked by name, and two teams often stand on one stage: two people called the same would answer for
  // each other. So nobody on the shelf shares a name with anybody else on it, or with the people a new stage starts with.
  it('gives every person on the shelf a name nobody else on it, or on a new stage, has', async () => {
    const names = [...seedStage.rooms.map((room) => room.name)];
    for (const dir of await builtIns()) names.push(...(await loadOne(dir)).rooms.map((room) => room.name));
    expect(names.filter((name, at) => names.indexOf(name) !== at)).toEqual([]);
  });

  // A tool is only offered when what it works on is wired to the person: a brief that sends somebody to the board, the
  // leads or a colleague is a brief that fails on its first turn unless the framework wires them there.
  it('wires everybody to what their brief sends them to', async () => {
    for (const dir of await builtIns()) {
      const framework = await loadOne(dir);
      const kindOf = new Map(framework.cards.map((card) => [card.key, card.kind]));
      const rooms = new Set(framework.rooms.map((room) => room.key));
      for (const room of framework.rooms) {
        const ends = framework.wires.flatMap((wire) => (wire.from === room.key ? [wire.to] : wire.to === room.key ? [wire.from] : []));
        const reaches = (kind: string) => ends.some((key) => kindOf.get(key) === kind);
        if (/propose_task|list_tasks/.test(room.brief)) expect(reaches('board'), `${dir}: ${room.key} board`).toBe(true);
        if (/add_lead|note_lead/.test(room.brief)) expect(reaches('leads'), `${dir}: ${room.key} leads`).toBe(true);
        if (/\bbrows(e|ing) the\b/.test(room.brief)) expect(reaches('browser'), `${dir}: ${room.key} browser`).toBe(true);
        if (/ask_person/.test(room.brief)) expect(ends.some((key) => rooms.has(key)), `${dir}: ${room.key} colleague`).toBe(true);
      }
    }
  });

  it('was built from the notes beside it, each named by its title and hashed from its words', async () => {
    for (const dir of await builtIns()) {
      const framework = await loadOne(dir);
      const files = (await readdir(resolve(shelf, dir, 'notes'))).filter((name) => /\.(md|markdown|txt)$/i.test(name));
      const found = await Promise.all(files.map(async (file) => {
        const words = await readFile(resolve(shelf, dir, 'notes', file), 'utf8');
        return { id: idOf(titleOfNote(file, words)), hash: createHash('sha1').update(words).digest('hex') };
      }));
      const byId = (one: { id: string }, other: { id: string }) => one.id.localeCompare(other.id);
      expect([...framework.notes].sort(byId)).toEqual(found.sort(byId));
      // Every note it was built from is on the stage as a card, and no card holds a note it was not built from.
      const onCards = framework.cards.flatMap((card) => (card.kind === 'library' ? [card.noteId] : []));
      expect([...onCards].sort()).toEqual(framework.notes.map((one) => one.id).sort());
    }
  });

  it('comes with a dataset that tests every person, judged by an answer or a rubric', async () => {
    for (const dir of await builtIns()) {
      const framework = await loadOne(dir);
      const people = new Set(framework.rooms.map((room) => room.key));
      expect(framework.dataset.length).toBeGreaterThanOrEqual(3);
      expect(new Set(framework.dataset.map((held) => held.id)).size).toBe(framework.dataset.length);
      for (const held of framework.dataset) {
        expect(held.keys.length).toBeGreaterThan(0);
        for (const key of held.keys) expect(people.has(key)).toBe(true);
        expect(held.input.trim()).not.toBe('');
        expect(held.expected?.trim() || held.rubric?.trim()).toBeTruthy();
        expect(held.addedBy).toBe('founder');
      }
      for (const key of people) expect(framework.dataset.some((held) => held.keys.includes(key)), `${dir}: ${key}`).toBe(true);
    }
  });

  // An eval answers with no tools at all (a team is measured on its judgement, not on what it can fetch), so a case
  // that can only be met by searching, reading a page or writing a doc is a case nobody can pass. The three teams
  // that lean on tools test the rules that hold without them: asking first, refusing, never inventing, the shape.
  it('asks nothing of the three tool-using teams that only a tool could do, one case per person', async () => {
    const needsTool = /search_source|web_search|web_fetch|read_youtube|read_reddit|read_feed|\bsearches\b|\bopens? the\b|writes? .* into the .* doc|each with its link|ends with a link|linked\)/i;
    for (const dir of NO_TOOL_CASES) {
      const framework = await loadOne(dir);
      for (const held of framework.dataset) expect(held.rubric ?? '', `${dir}: ${held.id}`).not.toMatch(needsTool);
      for (const room of framework.rooms) expect(framework.dataset.filter((held) => held.keys.includes(room.key)), `${dir}: ${room.key}`).toHaveLength(1);
    }
    const said = async (dir: string, key: string) => (await loadOne(dir)).dataset.find((held) => held.keys.includes(key))!.rubric!;
    expect(await said('launch-team', 'benchmarks')).toMatch(/no revenue figure/i);
    expect(await said('launch-team', 'writer')).toMatch(/asks for the story/i);
    expect(await said('due-diligence', 'profiler')).toMatch(/gives no funding amount/i);
    expect(await said('due-diligence', 'people')).toMatch(/no words in her mouth/i);
    expect(await said('due-diligence', 'risks')).toMatch(/invents no third risk/i);
  });
});

describe('the launch team', () => {
  it('plans, benchmarks, writes and replies, and says so in one line', async () => {
    const framework = await loadOne('launch-team');
    expect(framework.rooms.map((room) => room.role)).toEqual(['Launch planner', 'Benchmark reader', 'Post writer', 'Reply drafter']);
    expect(sizeLine(framework)).toBe('4 people · 2 docs · 2 notes · 1 source · 1 browser');
    expect(framework.docs.map((doc) => doc.title)).toEqual(['Launch plan', 'Posts']);
    expect(framework.docs[0].text).toContain('| Place | Why | What to post | Rules checked | Status | Date |');
    const source = framework.cards.find((card) => card.kind === 'source');
    expect(source && 'url' in source && source.url).toBe('https://trustmrr.com');
  });

  it('never lets anybody post: the founder presses send', async () => {
    const [planner, benchmarks, writer, replies] = (await loadOne('launch-team')).rooms.map((room) => room.brief);
    expect(planner).toContain('Where to post your startup');
    expect(planner).toContain('the founder presses send');
    expect(benchmarks).toContain('never an estimate');
    for (const brief of [writer, replies]) expect(brief).toContain('LinkedIn craft');
    expect(writer).toContain('You never post');
    for (const word of ['delve', 'game-changer', 'unlock', 'leverage']) expect(writer).toContain(word);
    expect(replies).toContain('Nothing is automated');
  });

  it('wires each note only to the people who work from it, and the browser to the two who look things up', async () => {
    const framework = await loadOne('launch-team');
    const wired = new Set(framework.wires.map((wire) => `${wire.from}>${wire.to}`));
    for (const pair of ['places>planner', 'craft>writer', 'craft>replies', 'planner>browser', 'benchmarks>browser', 'benchmarks>trustmrr', 'planner>plan', 'benchmarks>plan', 'writer>posts', 'replies>posts']) {
      expect(wired.has(pair), pair).toBe(true);
    }
    expect(wired.has('places>writer')).toBe(false);
  });
});

describe('pitch practice', () => {
  it('is four investors, each reading the pitch and the note and writing a verdict into the feedback', async () => {
    const framework = await loadOne('pitch-practice');
    expect(framework.rooms.map((room) => room.role)).toEqual(['Seed angel', 'Growth VC', 'Operator', 'Skeptic']);
    expect(sizeLine(framework)).toBe('4 people · 2 docs · 1 note');
    for (const heading of ['## Problem', '## Who has it', '## Product', '## Traction', '## Why now', '## Business model', '## Team', '## The ask']) {
      expect(framework.docs[0].text).toContain(heading);
    }
    const wired = new Set(framework.wires.map((wire) => `${wire.from}>${wire.to}`));
    for (const room of framework.rooms) {
      for (const pair of [`pitch>${room.key}`, `${room.key}>feedback`, `reading>${room.key}`]) expect(wired.has(pair), pair).toBe(true);
      for (const words of ['ONE question', 'Never lecture', 'INVEST', 'PASS', 'COME BACK WHEN', 'three hardest questions', 'Documents that moved capital']) {
        expect(room.brief, `${room.role}: ${words}`).toContain(words);
      }
    }
  });
});

describe('due diligence', () => {
  it('profiles the company, reads the people, finds the risks and writes the brief, and says so in one line', async () => {
    const framework = await loadOne('due-diligence');
    expect(framework.rooms.map((room) => room.role)).toEqual(['Company profiler', 'People reader', 'Risk finder', 'Brief writer']);
    expect(sizeLine(framework)).toBe('4 people · 2 docs · 1 sticky note · 1 note · 1 browser');
    expect(framework.docs.map((doc) => doc.title)).toEqual(['Profile', 'Brief']);
    for (const heading of ['## Company', '## People', '## Risks', '## Sources']) expect(framework.docs[0].text).toContain(heading);
    for (const heading of ['## Verdict', '## Five facts', '## Three questions to ask', '## One risk to watch', '## Sources']) expect(framework.docs[1].text).toContain(heading);
    const target = framework.cards.find((card) => card.kind === 'note');
    expect(target && 'text' in target && target.text).toContain('Who:');
  });

  it('links every line, says not found rather than guessing, and will not brief from an empty profile', async () => {
    const [profiler, people, risks, writer] = (await loadOne('due-diligence')).rooms.map((room) => room.brief);
    for (const brief of [profiler, people, risks, writer]) expect(brief).toContain('Reading a company from outside');
    for (const brief of [profiler, people]) { expect(brief).toContain('not found'); expect(brief).toContain('link'); }
    expect(profiler).toContain('read_feed');
    expect(profiler).toContain('never guess');
    expect(people).toContain('meeting-brief');
    expect(people).toContain('read_youtube');
    expect(risks).toContain('read_reddit');
    expect(risks).toContain('contract-review');
    for (const word of ['SURVIVABLE', 'NOT SURVIVABLE']) expect(risks).toContain(word);
    for (const word of ['GO', 'GO WITH CONDITIONS', 'PASS', 'refuse']) expect(writer).toContain(word);
  });

  it('wires the target to everybody, the three to the profile, the writer to them all and the browser to the two who look', async () => {
    const framework = await loadOne('due-diligence');
    const wired = new Set(framework.wires.map((wire) => `${wire.from}>${wire.to}`));
    for (const room of framework.rooms) for (const pair of [`target>${room.key}`, `reading>${room.key}`, `${room.key}>profile`]) expect(wired.has(pair), pair).toBe(true);
    for (const pair of ['writer>brief', 'writer>profiler', 'writer>people', 'writer>risks', 'profiler>browser', 'risks>browser']) expect(wired.has(pair), pair).toBe(true);
    expect(wired.has('people>brief')).toBe(false);
    expect(framework.dataset.find((held) => held.keys.includes('writer'))?.rubric).toContain('Refuses');
  });
});

const wiresOf = (framework: Framework) => new Set(framework.wires.map((wire) => `${wire.from}>${wire.to}`));

describe('the LinkedIn content system', () => {
  const NOTE = 'LinkedIn Founder-Led Content System — Notes v2';

  it('researches, writes, distributes, keeps score and follows up, and says so in one line', async () => {
    const framework = await loadOne('linkedin-content-system');
    expect(framework.rooms.map((room) => room.role)).toEqual(['Buyer researcher', 'Post writer', 'Distributor', 'Scorekeeper', 'Outbound']);
    expect(sizeLine(framework)).toBe('5 people · 5 docs · 1 sticky note · 1 note · 1 browser · 1 lead list · 1 task board');
    expect(framework.docs.map((doc) => doc.title)).toEqual(['ICP worksheet', 'Content calendar', 'Posts', 'Weekly scorecard', 'DM drafts']);
    const across = framework.rooms.map((room) => framework.layout[room.key].x);
    expect([...across].sort((one, two) => one - two)).toEqual(across);
    const linkedin = framework.cards.find((card) => card.kind === 'browser');
    expect(linkedin && 'app' in linkedin && linkedin.app?.key).toBe('linkedin');
    expect(framework.docs[3].text).toContain('| Week | Posts | Impressions | ICP engagers | Warm convos | Meetings |');
    for (const day of ['Mon: Visibility', 'Tue: Trust', 'Wed: Visibility', 'Thu: Trust', 'Fri: Conversion']) expect(framework.docs[2].text).toContain(day);
  });

  it('works from the owner\'s own sections, and nobody but the founder posts, connects or sends', async () => {
    const [researcher, writer, distributor, scorekeeper, outbound] = (await loadOne('linkedin-content-system')).rooms.map((room) => room.brief);
    for (const brief of [researcher, writer, distributor, scorekeeper, outbound]) expect(brief).toContain(NOTE);
    expect(researcher).toContain('1. Buyer research');
    expect(researcher).toContain('ask_founder');
    expect(researcher).toContain('never fill a [ ___ ] blank with a guess');
    for (const words of ['CPIO', 'Hook patterns', '4. Pre-publishing checklist', 'linkedin-post', 'hook-extract', 'humanize-draft', 'You never post', 'first comment']) expect(writer).toContain(words);
    for (const words of ['The three moves', 'linkedin-comment', 'linkedin-reply', 'never comment, connect, like, message or withdraw', 'ceiling']) expect(distributor).toContain(words);
    expect(scorekeeper.startsWith('Before anything else')).toBe(true);
    for (const words of ['Never estimate', 'ICP engagers', 'four things per post', 'four weeks']) expect(scorekeeper).toContain(words);
    for (const words of ['The soft DM', 'add_lead', 'note_lead', 'icp-fit', 'no link, no calendar', 'You never send']) expect(outbound).toContain(words);
  });

  it('wires the LinkedIn card only to those who read it, the leads only to outbound, and the board to the two who plan the week', async () => {
    const framework = await loadOne('linkedin-content-system');
    const wired = wiresOf(framework);
    for (const room of framework.rooms) for (const pair of [`who>${room.key}`, `reading>${room.key}`]) expect(wired.has(pair), pair).toBe(true);
    for (const pair of ['researcher>icp', 'researcher>linkedin', 'writer>posts', 'writer>calendar', 'writer>board', 'distributor>calendar', 'distributor>linkedin',
      'scorekeeper>scorecard', 'scorekeeper>board', 'scorekeeper>writer', 'outbound>dms', 'outbound>leads', 'outbound>icp']) expect(wired.has(pair), pair).toBe(true);
    expect([...wired].filter((pair) => pair.endsWith('>leads'))).toEqual(['outbound>leads']);
    expect(wired.has('writer>linkedin')).toBe(false);
  });

  it('keeps the owner\'s notes word for word', async () => {
    const words = await readFile(resolve(shelf, 'linkedin-content-system', 'notes', 'linkedin-content-system.md'), 'utf8');
    expect(titleOfNote('linkedin-content-system.md', words)).toBe(NOTE);
    for (const heading of ['## 1. Buyer research', '## 3. Writing a post — the CPIO framework', '## 4. Pre-publishing checklist', '## 7. Warm outbound', '## 10. Weekly operating rhythm']) expect(words).toContain(heading);
  });
});

// The twelve teams from the 2026-09-25 research, each built from one note of its own. For each: who is in it, in order;
// the line the panel shows; the doc they share; and, per person, the sections of the note their brief names, which
// must be headings in that note, and the words their brief must not lose.
type Team = { note: string; roles: string[]; size: string; doc: string; headings: string[]; sections: string[][]; words: string[][] };
const TEAMS: Record<string, Team> = {
  'weekly-metrics': {
    note: 'Weekly metrics that tell the truth', roles: ['Metric definer', 'Weekly counter', 'Weekly reviewer'],
    size: '3 people · 1 doc · 1 sticky note · 1 note · 1 task board', doc: 'Metrics', headings: ['## Definitions', '## This week', '## Retention by cohort (monthly)', '## Review'],
    sections: [['Four or five, written down', 'Vanity numbers', 'One primary KPI', 'A North Star before revenue'], ['The weekly row', 'Retention, stacked'], ['The weekly goal', 'The biggest blocker', 'Benchmarks, with their years']],
    words: [['propose_decision', 'remember', 'never change a confirmed definition'], ['recall', '"missing", never estimated', 'cumulative'], ['HIT', 'MISSED', 'One blocker', 'propose_task']],
  },
  'customer-discovery': {
    note: 'Talking to customers without leading them', roles: ['Interview planner', 'Notes reader', 'Pattern writer'],
    size: '3 people · 1 doc · 1 sticky note · 1 note', doc: 'Interviews', headings: ['## Plan', '## Conversations', '## Findings'],
    sections: [['The three rules', 'Three big questions', 'Who to talk to first', 'The five questions'], ['Bad data and how to catch it', 'Signals that count'], ['Reading the pattern']],
    words: [['No question mentions the product', '"Would you"', 'ask_founder', 'icp-fit'], ['FACT', 'PAIN', 'WORKAROUND', 'COMMITMENT', 'BAD DATA', 'no advance'], ['YES', 'NO', 'UNCLEAR', 'one-off', 'zombies']],
  },
  'investor-update': {
    note: 'The monthly update', roles: ['Numbers keeper', 'Asks writer', 'Update writer'],
    size: '3 people · 1 doc · 1 sticky note · 1 note', doc: 'Update', headings: ['## Numbers', '## Asks', '## Recap', '## Thank you'],
    sections: [['Same numbers, same order', 'Honest numbers'], ['Asks that can be answered'], ['Short recap', 'Shape of the email']],
    words: [['Never drop a metric because it fell', 'not reported this month'], ['at most three asks', 'No asks this month', 'recall'], ['Under 400 words', 'humanize-draft', 'You never send']],
  },
  'pmf-engine': {
    note: 'Measuring product-market fit', roles: ['Survey runner', 'Segment reader', 'Roadmap splitter'],
    size: '3 people · 1 doc · 1 sticky note · 1 note · 1 task board', doc: 'PMF', headings: ['## Survey', '## Segments', '## Roadmap'],
    sections: [['The four questions', 'Who to ask'], ['Segment before you judge', 'The customer who expects the most'], ['Half and half', 'Reading it with retention']],
    words: [['too few to trust', 'Never round up', 'at least twice in the last two weeks'], ['at least ten answers', 'never yours in quote marks'], ['Double down', 'Unblock', 'Nothing from the not-disappointed']],
  },
  'seed-round-prep': {
    note: 'Raising a seed round', roles: ['Round planner', 'Investor lister', 'Data room keeper', 'Process keeper'],
    size: '4 people · 1 doc · 1 sticky note · 1 note · 1 browser · 1 task board', doc: 'Round', headings: ['## Plan', '## Investors', '## One-pager', '## Data room', '## Questions they will ask', '## Pipeline'],
    sections: [['When to raise', 'How much', 'Safe, cap and dilution'], ['Who to meet', 'Warm first'], ['The one-pager', 'The data room', 'Questions they will ask'], ['Every meeting ends with a next step', 'Close fast']],
    words: [['post-money', 'working', 'lawyer', 'propose_decision'], ['"not found"', 'Due diligence', 'evidence-outreach', 'You never send'], ['HAVE, MISSING or N/A', 'IP assignment'], ['no next step', 'You never negotiate']],
  },
  'pre-mortem': {
    note: 'Imagining the failure first', roles: ['Failure imaginer', 'Evidence checker', 'Risk registrar'],
    size: '3 people · 1 doc · 1 sticky note · 1 note · 1 task board', doc: 'Premortem', headings: ['## Failure stories', '## Register', '## Review dates'],
    sections: [['It already failed', 'Everyone writes alone'], ['Evidence, not worry'], ['From stories to a register', 'Early warnings']],
    words: [['Past tense', 'No "might"', 'ask_founder'], ['no evidence found', 'INSIDE', 'OUTSIDE', 'watch_page'], ['No more than five', 'fatal', 'propose_task']],
  },
  'pricing-unit-economics': {
    note: 'Pricing from buyers, checked by the numbers', roles: ['Price listener', 'Unit economist', 'Price proposer'],
    size: '3 people · 1 doc · 1 sticky note · 1 note', doc: 'Pricing', headings: ['## Price range', '## Unit economics', '## Proposal'],
    sections: [['Four price questions', 'Who to ask about price', 'Reading the answers'], ['Gross margin', 'CAC, the honest kind', 'LTV as profit', 'Payback'], ['Payback', 'Deciding']],
    words: [['"too few"', 'Never invent an answer', 'never as the answer'], ['Never use revenue as LTV', '"missing"', 'Referral fees'], ['fix margin first', 'propose_decision', 'never change a live price']],
  },
  'traction-bullseye': {
    note: 'Finding the channel that works', roles: ['Channel scout', 'Ring ranker', 'Test judge'],
    size: '3 people · 1 doc · 1 sticky note · 1 note · 1 task board', doc: 'Channels', headings: ['## Brainstorm', '## Rings', '## Tests', '## Focus'],
    sections: [['The nineteen channels', 'One idea per channel'], ['Three rings', 'Cut to three', 'Designing a cheap test'], ['Reading a test', 'Focus']],
    words: [['19 channels', 'crawl_site', 'marked as guesses'], ['Never more than three', 'pass line', 'propose_task'], ['PASS', 'FAIL', '"incomplete"', 'one focus channel']],
  },
  'hiring-scorecard': {
    note: 'Hiring against a scorecard', roles: ['Scorecard writer', 'Sourcer', 'Interview guide'],
    size: '3 people · 1 doc · 1 sticky note · 1 note · 1 browser', doc: 'Hire', headings: ['## Scorecard', '## Candidates', '## Interviews', '## Decision'],
    sections: [['Mission', 'Outcomes, not duties', 'Competencies'], ['Sourcing starts with people you know'], ['The screening call', 'The career walk-through', 'References that tell the truth', 'Rating against the scorecard']],
    words: [['never activities', 'propose_decision', 'No sourcing until the scorecard is confirmed'], ['Never a person\'s private life', 'evidence-outreach', 'You never send'], ['HIRE', 'NO HIRE', 'MORE EVIDENCE', 'Never rate on likeability']],
  },
  positioning: {
    note: 'Positioning from the alternatives up', roles: ['Best-customer reader', 'Difference finder', 'Market framer'],
    size: '3 people · 1 doc · 1 sticky note · 1 note', doc: 'Positioning', headings: ['## Customers', '## Alternatives', '## Attributes', '## Value', '## Best-fit customers', '## Market category', '## Trend', '## Statement'],
    sections: [['Start from happy customers', 'What they would do instead'], ['Unique attributes, with proof', 'Value, in the customer\'s words'], ['Who cares most', 'A frame that makes the value obvious', 'A trend, carefully', 'Writing it down']],
    words: [['positioning is premature', 'not the founder\'s list of competitors'], ['No attribute without proof', 'ours, not theirs', 'watch-a-competitor'], ['propose_decision', 'traces back']],
  },
  'working-backwards': {
    note: 'Writing the launch first', roles: ['Press release writer', 'FAQ writer', 'Reader'],
    size: '3 people · 1 doc · 1 sticky note · 1 note', doc: 'PR/FAQ', headings: ['## Press release', '## External FAQ', '## Internal FAQ', '## Review'],
    sections: [['The press release, part by part', 'Plain words'], ['External questions', 'Internal questions'], ['Reading it together']],
    words: [['Under one page', '[hypothetical]', 'no superlative without a number'], ['top three reasons this will fail', '"unknown"'], ['BUILD', 'REVISE', 'DROP', 'two revision rounds']],
  },
  'lean-canvas': {
    note: 'The business on one page', roles: ['Canvas drafter', 'Riskiest-guess finder'],
    size: '2 people · 1 doc · 1 sticky note · 1 note · 1 task board', doc: 'Plan', headings: ['## Canvas', '## Riskiest guesses', '## This week\'s test', '## History'],
    sections: [['Nine boxes', 'Twenty minutes', 'The sub-boxes', 'Unfair advantage'], ['Riskiest first', 'A test a week']],
    words: [['KNOWN', 'GUESS', '"none yet"'], ['One test at a time', 'written before the result', 'propose_task', 'Customer discovery']],
  },
};

describe.each(Object.entries(TEAMS))('the %s team', (dir, team) => {
  it('is its people in order, left to right, and says so in one line', async () => {
    const framework = await loadOne(dir);
    expect(framework.rooms.map((room) => room.role)).toEqual(team.roles);
    expect(sizeLine(framework)).toBe(team.size);
    const across = framework.rooms.map((room) => framework.layout[room.key].x);
    expect([...across].sort((one, two) => one - two)).toEqual(across);
    expect(framework.docs.map((doc) => doc.title)).toEqual([team.doc]);
    for (const heading of team.headings) expect(framework.docs[0].text).toContain(heading);
  });

  it('gives each person the sections of the note they work from, by the note\'s own headings', async () => {
    const framework = await loadOne(dir);
    const [file] = await readdir(resolve(shelf, dir, 'notes'));
    const words = await readFile(resolve(shelf, dir, 'notes', file), 'utf8');
    expect(titleOfNote(file, words)).toBe(team.note);
    framework.rooms.forEach((room, at) => {
      expect(room.brief).toContain(`"${team.note}"`);
      for (const section of team.sections[at]) { expect(words, `${dir} note: ${section}`).toContain(`## ${section}\n`); expect(room.brief, `${room.key}: ${section}`).toContain(section); }
      for (const said of team.words[at]) expect(room.brief, `${room.key}: ${said}`).toContain(said);
    });
    // The last person writes from what the others made, so they open with the rule that stops them writing from nothing.
    expect(framework.rooms.at(-1)!.brief.startsWith('Before anything else')).toBe(true);
    // Every source the note is written from is a link a founder can open.
    expect(words).toMatch(/https:\/\//);
  });

  it('wires the card and the note to everybody, everybody to the doc, and the last person to the others', async () => {
    const framework = await loadOne(dir);
    const wired = wiresOf(framework);
    const [card, doc] = [framework.cards.find((one) => one.kind === 'note')!.key, framework.docs[0].key];
    const people = framework.rooms.map((room) => room.key);
    for (const key of people) for (const pair of [`${card}>${key}`, `reading>${key}`, `${key}>${doc}`]) expect(wired.has(pair), pair).toBe(true);
    const last = people.at(-1)!;
    for (const key of people.slice(0, -1)) expect(wired.has(`${last}>${key}`), `${last}>${key}`).toBe(true);
  });
});
