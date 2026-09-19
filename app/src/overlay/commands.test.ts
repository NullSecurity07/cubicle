import { describe, expect, it } from 'vitest';
import { suggest, type Known } from './commands';

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
