import { describe, expect, it } from 'vitest';
import { canAnswer, choicesOf, fieldLabel } from './Approval';
import { failedLine, receiptOf } from './Message';

describe('what a receipt says', () => {
  it('names a skill read, a line kept about the founder and a question put to them', () => {
    expect(receiptOf({ name: 'use_skill', args: { name: 'How to answer a late invoice' } })).toEqual({ doing: 'Reading the skill', done: 'Read the skill', subject: 'How to answer a late invoice' });
    expect(receiptOf({ name: 'note_founder', args: { fact: 'Likes answers in  one line' } })).toEqual({ doing: 'Noting about you:', done: 'Noted about you:', subject: 'Likes answers in one line' });
    expect(receiptOf({ name: 'ask_founder', args: { answer: 'Yes' }, question: 'Ship on Friday?' }).subject).toBe('Ship on Friday?');
  });

  it('says a tool from an outside server in words, never as its raw name', () => {
    expect(receiptOf({ name: 'mcp_github_search_issues', args: {} })).toEqual({ doing: 'Using', done: 'Used', subject: 'github search issues' });
  });

  it('asks the founder for their answer, and anyone else for why not', () => {
    expect(fieldLabel('ask_founder', 'answer')).toBe('Your answer');
    expect(fieldLabel('browse_help', 'answer')).toBe("Why not (if you won't)");
    expect(fieldLabel('send_email', 'to')).toBe('To');
  });

  it('offers a question\'s choices as its answers, in the room and in Needs you', () => {
    const asking = { id: 'ask-1', name: 'ask_founder', args: { question: 'What is your founder fit?', choices: ['Lived it', 'Unusual access', 'None'] } };
    expect(receiptOf(asking).subject).toBe('What is your founder fit? (Lived it · Unusual access · None)');
    expect(choicesOf({ ...asking, args: { answer: 'Lived it' }, choices: ['Lived it', 'Unusual access', 'None'] })).toEqual(['Lived it', 'Unusual access', 'None']);
    expect(choicesOf({ id: 'e', name: 'send_email', args: {}, choices: ['x'] })).toEqual([]);
    expect(choicesOf({ id: 'q', name: 'ask_founder', args: {} })).toEqual([]);
    // An empty answer would close the question with nothing said: Answer waits for words or a choice.
    expect(canAnswer('ask_founder', { answer: '  ' })).toBe(false);
    expect(canAnswer('ask_founder', { answer: 'Lived it' })).toBe(true);
    expect(canAnswer('send_email', { to: 'a@b.c' })).toBe(true);
  });
});

describe('a failed step with words of its own', () => {
  it('says a draft had no address on record, and leaves every other failure to the plain line', () => {
    const refused = { name: 'draft_email', args: { to: 'office@example.com' }, ok: false, result: 'Failed: no address on record for office@example.com: nothing read ...' };
    expect(failedLine(refused)).toBe('No address on record for office@example.com: ask the founder or find it on their site');
    expect(failedLine({ ...refused, result: 'Failed: not an email address: x' })).toBeNull();
    expect(failedLine({ ...refused, ok: true })).toBeNull();
  });
});
