import { describe, expect, it } from 'vitest';
import { commandWords, suggest, type Command, type Known } from './commands';

const known: Known = {
  cards: [
    { id: 'marketing', type: 'room', label: 'Maya', role: 'Marketing' }, { id: 'build', type: 'room', label: 'Dev', role: 'Build' },
    { id: 'brand-doc', type: 'doc', label: 'Brand doc' }, { id: 'board-1', type: 'board', label: 'Board' },
  ],
};
const first = (input: string) => suggest(input, known)[0];
const actions = (input: string) => suggest(input, known).map((one) => one.action);

describe('command bar', () => {
  it('with nothing typed, offers the founder\'s views and the ways to add', () => {
    const labels = suggest('', known).map((one) => one.label);
    expect(labels.slice(0, 3)).toEqual(['Needs you', 'Messages', 'Decisions']);
    expect(labels).toContain('Add a person');
  });

  it('opens the dashboard by the words a founder reaches for', () => {
    for (const typed of ['dashboard', 'Home', 'today', 'my day', 'dash']) expect(actions(typed)).toContainEqual({ do: 'panel', name: 'dashboard' });
  });

  it('hires by role and adds cards by name', () => {
    expect(first('hire a designer').action).toEqual({ do: 'add', kind: 'room', data: { role: 'Designer' } });
    expect(first('add a growth marketer').action).toEqual({ do: 'add', kind: 'room', data: { role: 'Growth marketer' } });
    expect(first('add person').action).toEqual({ do: 'add', kind: 'room' });
    expect(first('new doc Launch plan').action).toEqual({ do: 'add', kind: 'doc', data: { title: 'Launch plan' } });
    expect(first('add a task board').action).toEqual({ do: 'add', kind: 'board' });
    expect(first('add sticky note').action).toEqual({ do: 'add', kind: 'note' });
    expect(first('add browser').action).toEqual({ do: 'add', kind: 'browser' });
    expect(first('add a picture').action).toEqual({ do: 'add', kind: 'image' });
    expect(first('add an image studio').action).toEqual({ do: 'add', kind: 'imagegen' });
    expect(first('add a voice studio').action).toEqual({ do: 'add', kind: 'voicegen' });
    expect(first('add text to speech').action).toEqual({ do: 'add', kind: 'voicegen' });
    expect(first('add a video studio').action).toEqual({ do: 'add', kind: 'videogen' });
    expect(first('add leads').action).toEqual({ do: 'add', kind: 'leads' });
  });

  it('adds each of the newer cards by its own words, and never hires a person called "Survey"', () => {
    const want: [string, string][] = [
      ['add metrics', 'metrics'], ['add a runway card', 'runway'], ['add a pitch deck', 'deck'], ['new deck', 'deck'], ['add a site studio', 'site'], ['add a landing page', 'site'],
      ['add a competitor', 'competitor'], ['add an interview', 'interview'], ['add a survey', 'survey'], ['add a pmf survey', 'survey'],
    ];
    for (const [typed, kind] of want) expect(first(typed).action, typed).toEqual({ do: 'add', kind });
    expect(suggest('add survey', known).some((one) => one.label.startsWith('Add a person'))).toBe(false);
  });

  it('adds a source website, and never hires a person called "Source"', () => {
    for (const typed of ['add source', 'add a source', 'add website', 'add a web site', 'add a source website']) {
      expect(first(typed).action).toEqual({ do: 'add', kind: 'source' });
      expect(actions(typed)).not.toContainEqual(expect.objectContaining({ kind: 'room' }));
    }
  });

  it('adds a note from the library by opening the notes to pick one', () => {
    for (const typed of ['add a note from the library', 'add note from library', 'add library note', 'add library']) expect(first(typed).action).toEqual({ do: 'panel', name: 'library' });
    expect(first('add a note').action).toEqual({ do: 'add', kind: 'note' });
    expect(commandWords().some((word) => word.say.includes('add a source'))).toBe(true);
  });

  it('asks a person by name, in the ways a founder would type it', () => {
    const ask = { do: 'ask', roomId: 'marketing', text: 'draft three taglines' };
    expect(first('ask maya draft three taglines').action).toEqual(ask);
    expect(first('ask Maya to draft three taglines').action).toEqual(ask);
    expect(first('maya: draft three taglines').action).toEqual(ask);
    expect(first('@maya draft three taglines').action).toEqual(ask);
    expect(first('tell dev to fix the login bug').action).toEqual({ do: 'ask', roomId: 'build', text: 'fix the login bug' });
  });

  it('focuses and finds cards by name, a few letters are enough', () => {
    expect(first('focus maya').action).toEqual({ do: 'focus', id: 'marketing' });
    expect(first('open brand').action).toEqual({ do: 'focus', id: 'brand-doc' });
    expect(actions('bra')).toContainEqual({ do: 'jump', id: 'brand-doc' });
    expect(actions('mark')).toContainEqual({ do: 'jump', id: 'marketing' }); // by role too
  });

  it('opens views and answers small questions', () => {
    expect(first('needs').action).toEqual({ do: 'panel', name: 'needs' });
    expect(first('what needs me').action).toEqual({ do: 'panel', name: 'needs' });
    expect(first('decisions').action).toEqual({ do: 'panel', name: 'decisions' });
    expect(first('record a decision').action).toEqual({ do: 'new-decision' });
    expect(first('who is idle?').action).toEqual({ do: 'idle' });
    expect(first('show everything').action).toEqual({ do: 'fit' });
    expect(first('shortcuts').action).toEqual({ do: 'keys' });
  });

  it('never guesses: text that matches nothing is offered to each person as a question', () => {
    const offered = suggest('what should our refund policy be', known);
    expect(offered.map((one) => one.action)).toEqual([
      { do: 'ask', roomId: 'marketing', text: 'what should our refund policy be' },
      { do: 'ask', roomId: 'build', text: 'what should our refund policy be' },
    ]);
    expect(offered[0].label).toBe('Ask Maya');
    expect(offered[0].section).toBe('Ask');
    // Only these offers may be outranked by what the workspace search finds; an outright "ask maya …" may not.
    expect(offered.every((one) => one.fallback)).toBe(true);
    expect(first('ask maya draft three taglines').fallback).toBeUndefined();
  });
});

// The cheatsheet lists these words; each one it lists must really be answered by the bar, never only offered around.
describe('command bar words', () => {
  const slices: Command[] = [
    { section: 'Do', label: 'Health', hint: 'Is everything working?', action: { do: 'idle' } },
    { section: 'Do', label: 'Health', hint: 'Is everything working?', action: { do: 'idle' }, when: (typed) => typed === 'checkup' },
    { section: 'Do', label: 'Dashboard', action: { do: 'fit' }, when: (typed) => typed === 'numbers', say: ['numbers'] },
  ];

  it('are all answered outright', () => {
    const words = commandWords(slices);
    for (const word of words.slice(0, -1)) {
      for (const say of word.say) {
        const typed = say.replace('…', 'Maya');
        expect(suggest(typed, known, slices).filter((one) => !one.fallback).length, typed).toBeGreaterThan(0);
      }
    }
    // Anything else is a search, and a question for the people.
    expect(suggest(words.at(-1)!.say[0], known, slices).every((one) => one.fallback)).toBe(true);
  });

  it('list a slice command once, by its own words when it gives them', () => {
    const words = commandWords(slices);
    expect(words.filter((word) => word.does.startsWith('Health'))).toEqual([{ say: ['health'], does: 'Health: is everything working?' }]);
    expect(words.find((word) => word.does === 'Dashboard')?.say).toEqual(['numbers']);
    expect(words.find((word) => word.does.startsWith('Keyboard'))?.say).toContain('shortcuts');
  });
});
