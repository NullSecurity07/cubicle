import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Framework } from '../../shared/frameworks.ts';
import { DOC_SIZE, FRAMEWORK_ID, sizeLine } from '../../shared/frameworks.ts';
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

describe('every built-in framework', () => {
  it('ships the four teams', async () => {
    expect(await builtIns()).toEqual(['due-diligence', 'launch-team', 'pitch-practice', 'startup-evaluation']);
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
    for (const dir of ['launch-team', 'pitch-practice', 'due-diligence']) {
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
