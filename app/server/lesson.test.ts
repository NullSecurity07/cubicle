import { describe, expect, it } from 'vitest';
import { checkLesson, mostSteps, type Ground, type Lesson } from './lesson.ts';

// The task a real founder gave Maya on a scratch workspace, and the skill gemini wrote from it, word for word.
const ASKED = 'Write a short launch FAQ for the export add-on into the Brand doc\n\nRead the company brief first, draft five questions, then save it.';
const LIVE: Lesson = {
  name: 'Draft launch FAQ for export add-on in Brand doc',
  when: 'When needing a quick FAQ for a new export add-on to be added to the Brand documentation',
  procedure: [
    'Read the company brief to understand the product and brand tone',
    'Identify the key points users will need about the export add-on',
    'Formulate five concise, relevant questions covering purpose, usage, benefits, limitations, and support',
    'Write clear answers that align with brand voice and guidelines',
    'Insert the Q&A into the designated section of the Brand doc',
    'Save and version‑control the updated Brand doc',
    'Notify stakeholders that the FAQ is available',
  ],
  pitfalls: ['Missing critical user concerns', 'Using language that conflicts with brand tone', 'Failing to update the correct version of the Brand doc', 'Neglecting to inform relevant team members'],
  verify: 'The Brand doc contains a new FAQ section with five questions and answers, matches brand style, and stakeholders have confirmed receipt',
};
// The lesson that was in there all along, written for the next case instead of this one.
const GOOD: Lesson = {
  name: 'Write a FAQ that answers what people really ask',
  when: 'When the founder asks for a set of questions and answers about something the company sells',
  procedure: ['Read the company background first, so the answers say what the product really does', 'Write the questions somebody outside would ask, not the ones easiest to answer', 'Save it where the founder asked for it'],
  pitfalls: ['Never promise anything that is not built yet'],
  verify: 'A stranger can read it and knows what the thing does and what it costs.',
};
const ground = (over: Partial<Ground> = {}): Ground => ({ names: ['Maya', 'Dev', 'Brand doc', 'Company brief'], asked: ASKED, calls: 2, ...over });

describe('what makes a lesson a lesson', () => {
  it('refuses the skill the live model really wrote, and says which of the three it broke', () => {
    // All three rules at once. Names come first and come together, so one rewrite can take every one of them out.
    expect(() => checkLesson(LIVE, ground())).toThrow(/"Brand doc" and "Company brief" are names of a document, a card or a person on this stage/);
    expect(() => checkLesson({ ...GOOD, name: 'Draft launch FAQ for the export add-on' }, ground({ names: [] })))
      .toThrow(/"launch faq export" is taken word for word out of this one piece of work/);
    expect(() => checkLesson({ ...GOOD, procedure: LIVE.procedure }, ground({ names: [] }))).toThrow(/there are 7 steps: only write steps that were really done\. 2 tool calls were made, so write at most 4 steps/);
  });

  it('lets the lesson that was in there all along through', () => {
    expect(() => checkLesson(GOOD, ground())).not.toThrow();
  });

  describe('names on this stage', () => {
    for (const [what, line] of [
      ['a document', 'Insert the answers into the Brand doc'], ['a person', 'Ask Maya to read it before it goes out'],
      ['the other document', 'Read the Company brief first'], ['a card the founder titled', 'Check the Pricing page for the numbers'],
    ] as const) {
      it(`refuses ${what}`, () => {
        expect(() => checkLesson({ ...GOOD, procedure: [line] }, ground({ names: [...ground().names, 'Pricing page'] }))).toThrow(/is the name of a document, a card or a person on this stage/);
      });
    }
    for (const line of ['Insert the answers into the document the founder wired to you', 'Ask whoever owns that field to read it first', 'Read the company background first', 'brand documents are not the same as a brand doctor']) {
      it(`allows "${line.slice(0, 40)}"`, () => { expect(() => checkLesson({ ...GOOD, procedure: [line] }, ground())).not.toThrow(); });
    }
    it('leaves a name too short to mean anything alone out of it', () => {
      expect(() => checkLesson(GOOD, ground({ names: ['Ed', 'a'] }))).not.toThrow();
    });
    // What the live run cost: refused for one name, the model took it out, was refused for the second and had no
    // turn left. Both are named at once so one correction can take both out.
    it('names every one of them in the same breath', () => {
      expect(() => checkLesson({ ...GOOD, procedure: ['Read the Company brief first', 'Write it into the Brand doc'] }, ground()))
        .toThrow('"Brand doc" and "Company brief" are names of a document, a card or a person on this stage, and a skill has to fit the next case too. Say what kind of thing each is, not what this one is called, and take out every one of them');
    });
  });

  describe('words borrowed from the one job', () => {
    for (const name of ['Draft launch FAQ for export add-on', 'How to write a short launch FAQ', 'Draft five questions for a product']) {
      it(`refuses "${name}"`, () => { expect(() => checkLesson({ ...GOOD, name }, ground())).toThrow(/taken word for word out of this one piece of work/); });
    }
    // It reads the words as they were written: "drafting five questions" is not "draft five questions" to it, and
    // it lets that through. What stops a reworded copy is the doctrine and the three nearest skills, not this.
    it('is about copying, not about the idea', () => {
      expect(() => checkLesson({ ...GOOD, name: 'Drafting five questions for a product' }, ground({ names: [] }))).not.toThrow();
    });
    for (const name of ['When the founder asks for a FAQ', 'Write a FAQ that answers what people really ask', 'How to draft questions a stranger would ask']) {
      it(`allows "${name}"`, () => { expect(() => checkLesson({ ...GOOD, name }, ground())).not.toThrow(); });
    }
    it('only looks at the name and when: a step may say what was really done', () => {
      expect(() => checkLesson({ ...GOOD, procedure: ['Read the company brief first, draft five questions, then save it'] }, ground({ names: [] }))).not.toThrow();
    });
    it('says nothing about a conversation, where the founder\'s own words are the lesson', () => {
      const said = { ...GOOD, name: 'Never use exclamation marks', when: 'When writing anything the founder will read' };
      expect(() => checkLesson(said, ground({ asked: 'no, never use exclamation marks and keep every answer under two sentences' }))).toThrow(/taken word for word/);
      expect(() => checkLesson(said, ground({ asked: '' }))).not.toThrow();
    });
  });

  describe('steps nobody took', () => {
    for (const [calls, steps, ok] of [[0, 3, true], [0, 4, false], [1, 3, true], [2, 4, true], [2, 5, false], [3, 5, true], [6, 8, true]] as const) {
      it(`${calls} calls and ${steps} steps is ${ok ? 'fair' : 'too many'}`, () => {
        const lesson = { ...GOOD, procedure: Array.from({ length: steps }, (_, at) => `Step ${at + 1}`) };
        if (ok) expect(() => checkLesson(lesson, ground({ calls, names: [] }))).not.toThrow();
        else expect(() => checkLesson(lesson, ground({ calls, names: [] }))).toThrow(/only write steps that were really done/);
      });
    }
    it('always allows three, however little was done', () => { expect(mostSteps(0)).toBe(3); expect(mostSteps(1)).toBe(3); expect(mostSteps(5)).toBe(7); });
    it('leaves the count alone for a patch, which only holds the lines it changes', () => {
      expect(() => checkLesson({ procedure: Array.from({ length: 8 }, (_, at) => `Step ${at + 1}`) }, ground({ calls: 0, names: [] }), false)).not.toThrow();
    });
  });
});
