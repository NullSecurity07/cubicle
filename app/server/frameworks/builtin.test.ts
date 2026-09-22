import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Framework } from '../../shared/frameworks.ts';
import { sizeLine } from '../../shared/frameworks.ts';
import { idOf } from '../library/notes.ts';
import { titleOfNote } from './store.ts';

// The one framework that ships with the app. It is a hand-written file, so nothing else in the build would notice if
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
