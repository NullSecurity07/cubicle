import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chaseLine, dueOf, keptPromiseLine, promisesAttention, promisesBook, promisesIn, type FounderPromise as Said } from './promises.ts';

// Monday 28 September 2026, ten in the morning where the founder is.
const MONDAY = new Date('2026-09-28T10:00').getTime();

describe('a promise in the founder\'s words', () => {
  it('takes "I will", "I\'ll" and "I\'m going to" with what follows, dated by what the sentence says', () => {
    expect(promisesIn('Great. I\'ll call 5 beta users by Friday.', MONDAY)).toEqual([{ what: 'call 5 beta users by Friday', due: '2026-10-02' }]);
    expect(promisesIn('I will ship the VAT export tomorrow', MONDAY)).toEqual([{ what: 'ship the VAT export tomorrow', due: '2026-09-29' }]);
    expect(promisesIn('I\'m going to rewrite the landing page this week!', MONDAY)).toEqual([{ what: 'rewrite the landing page this week', due: '2026-10-02' }]);
    // Said for the company, with a day on it.
    expect(promisesIn('We\'ll send the survey by 2026-10-05.', MONDAY)).toEqual([{ what: 'send the survey by 2026-10-05', due: '2026-10-05' }]);
    // No day said: a week from today, only for an action with something it is done to.
    expect(promisesIn('I\'ll email the accountant about VAT.', MONDAY)).toEqual([{ what: 'email the accountant about VAT', due: '2026-10-05' }]);
    expect(promisesIn('I\'ll talk to the three beta users.', MONDAY)).toEqual([{ what: 'talk to the three beta users', due: '2026-10-05' }]);
    expect(promisesIn('I\'ll finish the pricing page.', MONDAY)).toEqual([{ what: 'finish the pricing page', due: '2026-10-05' }]);
    // With a day, the day makes it a promise whatever the verb.
    expect(promisesIn('I\'ll sort the invoices by Friday.', MONDAY)).toEqual([{ what: 'sort the invoices by Friday', due: '2026-10-02' }]);
  });

  it('takes a day said with no "I will" when the founder is the one doing it', () => {
    expect(promisesIn('Calling the three beta users by Friday.', MONDAY)).toEqual([{ what: 'Calling the three beta users by Friday', due: '2026-10-02' }]);
    expect(promisesIn('I call the bank this week', MONDAY)).toEqual([{ what: 'call the bank this week', due: '2026-10-02' }]);
  });

  it('leaves a question, a condition, a thought, words to the app and a "we will" with no day', () => {
    for (const said of [
      'Should I call them by Friday?', 'What will I need this week?', 'If it rains I\'ll call them tomorrow.', 'I\'ll think about it.',
      'I\'ll paste the CSV now.', 'I\'ll let you know.', 'I will not raise this year.', 'I\'ll be at the conference this week.',
      'We\'ll see.', 'We will grow.', 'Maybe I\'ll call them tomorrow.', 'What is due this week?', 'Revenue grew this week.', 'I\'ll send you the deck.',
      'I\'ll go with option B.', 'I\'ll take the $9 price.', 'Sure I\'ll pick option 2.', 'Thanks, I\'ll do that.', 'I\'ll look into it.',
      'I\'ll give it a go.', 'I\'ll keep that in mind.', 'I\'ll choose the second one.', 'I\'ll use Stripe.', 'I\'ll admit it is slow.', 'I\'ll try to be faster.',
      'I\'ll do it.', 'I\'ll ship it.',
      '/tool generate_voice {"text":"I\'ll ship it this week."}',
    ]) expect(promisesIn(said, MONDAY), said).toEqual([]);
  });

  it('reads the day a sentence names', () => {
    expect(dueOf('by Friday', MONDAY)).toBe('2026-10-02');
    expect(dueOf('on Monday', MONDAY)).toBe('2026-10-05');
    expect(dueOf('by next Friday', MONDAY)).toBe('2026-10-09');
    expect(dueOf('today', MONDAY)).toBe('2026-09-28');
    expect(dueOf('tonight', MONDAY)).toBe('2026-09-28');
    expect(dueOf('next week', MONDAY)).toBe('2026-10-09');
    expect(dueOf('in 3 days', MONDAY)).toBe('2026-10-01');
    expect(dueOf('in two weeks', MONDAY)).toBe('2026-10-12');
    expect(dueOf('by Oct 10', MONDAY)).toBe('2026-10-10');
    expect(dueOf('by 3 October', MONDAY)).toBe('2026-10-03');
    expect(dueOf('by the end of the week', MONDAY)).toBe('2026-10-02');
    // "This week" on a Saturday is the Sunday.
    expect(dueOf('this week', new Date('2026-10-03T10:00').getTime())).toBe('2026-10-04');
    expect(dueOf('sometime', MONDAY)).toBeNull();
  });
});

describe('the promises ledger', () => {
  it('keeps one open promise per thing said, closes it for good, and chases it once', async () => {
    let clock = MONDAY;
    const book = promisesBook(await mkdtemp(join(tmpdir(), 'promises-')), () => clock);
    const one = await book.add({ what: 'call 5 beta users by Friday', due: '2026-10-02', roomId: 'p1' });
    expect(one).toMatchObject({ what: 'call 5 beta users by Friday', due: '2026-10-02', status: 'open', said: '2026-09-28', roomId: 'p1' });
    expect(await book.add({ what: 'Call 5 beta users by Friday', due: '2026-10-02', roomId: 'p1' })).toBeNull();
    clock = new Date('2026-10-03T09:00').getTime();
    expect(await book.chased(one!.id)).toBe(true);
    expect(await book.chased(one!.id)).toBe(false);
    await book.close(one!.id, true);
    expect((await book.list())[0]).toMatchObject({ status: 'done', closed: '2026-10-03' });
    await expect(book.close(one!.id, false)).rejects.toThrow('already closed');
  });
});

describe('a promise in Needs you', () => {
  const promise = (extra: Partial<Said> = {}): Said => ({ id: 'promise-1', what: 'call 5 beta users by Friday', due: '2026-10-02', said: '2026-09-28', at: MONDAY, roomId: 'p1', status: 'open', ...extra });

  it('waits until its day, then says it is due today, then how late it is', () => {
    expect(promisesAttention([promise()], '2026-10-01')).toEqual([]);
    expect(promisesAttention([promise()], '2026-10-02')).toEqual([{ id: 'promise:promise-1', kind: 'promise', title: 'You said you would call 5 beta users by Friday', detail: 'Due today. Said on 2026-09-28.', at: new Date('2026-10-02T00:00').getTime(), roomId: 'p1' }]);
    expect(promisesAttention([promise()], '2026-10-04')[0].detail).toBe('Due 2026-10-02, 2 days ago. Said on 2026-09-28.');
    expect(promisesAttention([promise({ status: 'done' })], '2026-10-04')).toEqual([]);
  });

  it('is said in words the founder reads', () => {
    expect(keptPromiseLine([{ what: 'call 5 beta users by Friday', due: '2026-10-02' }])).toBe('*Kept as a promise: call 5 beta users by Friday (due 2026-10-02). It comes to Needs you on the day.*');
    expect(chaseLine(promise())).toBe('You said you would call 5 beta users by Friday (due 2026-10-02). Done? Close it in Needs you, or tell me what got in the way.');
  });
});

describe('the kill signal of a verdict, kept as a check', () => {
  it('comes to Needs you as a check on its day, one at a time, and is not chased as the founder\'s word', async () => {
    const book = promisesBook(await mkdtemp(join(tmpdir(), 'checks-')), () => MONDAY);
    const first = await book.add({ what: '6 paying users', due: '2026-10-26', roomId: 'p1', check: true });
    const second = await book.add({ what: '8 paying users', due: '2026-11-02', roomId: 'p1', check: true });
    const all = await book.list();
    expect(all.find((one) => one.id === first!.id)!.status).toBe('dropped');
    expect(promisesAttention(all, '2026-10-26')).toEqual([]);
    expect(promisesAttention(all, '2026-11-02')).toEqual([expect.objectContaining({ id: `promise:${second!.id}`, title: 'Check: 8 paying users by 2026-11-02?', roomId: 'p1' })]);
  });
});
