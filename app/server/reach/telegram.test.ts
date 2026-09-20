import { describe, expect, it } from 'vitest';
import { BREAK_AFTER, BREAK_FOR, LIMIT, createApi, createPoller, pieces, type Update } from './telegram.ts';

const answer = (result: unknown, ok = true, status = 200) => new Response(JSON.stringify({ ok, result }), { status, headers: { 'content-type': 'application/json' } });

describe('splitting a long reply', () => {
  it('keeps a short one whole', () => {
    expect(pieces('One line.')).toEqual(['One line.']);
  });

  it('breaks between paragraphs, never inside one', () => {
    const paragraph = 'a'.repeat(3000);
    const split = pieces(`${paragraph}\n\n${paragraph}`);
    expect(split).toEqual([paragraph, paragraph]);
  });

  it('fills each piece with as many paragraphs as fit', () => {
    const split = pieces(['one', 'two', 'three'].join('\n\n'), 12);
    expect(split).toEqual(['one\n\ntwo', 'three']);
  });

  it('falls back to lines, then to words, for a paragraph with nothing to break on', () => {
    const lines = pieces(`${'a'.repeat(3000)}\n${'b'.repeat(3000)}`);
    expect(lines).toEqual(['a'.repeat(3000), 'b'.repeat(3000)]);
    const words = pieces(`${'a'.repeat(3000)} ${'b'.repeat(3000)}`);
    expect(words.every((piece) => piece.length <= LIMIT)).toBe(true);
    expect(words.join('')).toBe('a'.repeat(3000) + 'b'.repeat(3000));
  });

  it('cuts a single unbroken wall of text at the limit', () => {
    const split = pieces('x'.repeat(LIMIT * 2 + 5));
    expect(split.every((piece) => piece.length <= LIMIT)).toBe(true);
    expect(split.join('').length).toBe(LIMIT * 2 + 5);
  });
});

describe('talking to Telegram', () => {
  it('will not call without a token, and says what came back when it fails', async () => {
    const api = createApi(async () => null, async () => answer(true));
    await expect(api.send(1, 'hello')).rejects.toThrow('no bot token is set');
    const refused = createApi(async () => 'key', async () => answer(null, false, 401));
    await expect(refused.send(1, 'hello')).rejects.toThrow('Telegram answered 401');
  });

  it('sends the buttons Telegram expects', async () => {
    let body: any = null;
    const api = createApi(async () => 'key', async (_url, init) => { body = JSON.parse(String(init?.body)); return answer({ message_id: 7 }); });
    const sent = await api.send(5, 'Allow this?', [[{ text: 'Approve', data: 'ok:k1' }, { text: 'Deny', data: 'no:k1' }]]);
    expect(sent.message_id).toBe(7);
    expect(body.reply_markup.inline_keyboard[0]).toEqual([{ text: 'Approve', callback_data: 'ok:k1' }, { text: 'Deny', callback_data: 'no:k1' }]);
  });
});

describe('long polling', () => {
  const update = (id: number): Update => ({ update_id: id, message: { message_id: id, chat: { id: 1 }, text: `m${id}` } });

  it('hands over each update once and asks again from after the last one', async () => {
    const asked: number[] = [];
    const seen: number[] = [];
    let done: () => void;
    const finished = new Promise<void>((settle) => { done = settle; });
    const poller = createPoller({
      updates: async (offset) => { asked.push(offset); if (offset) done(); return offset === 0 ? [update(4), update(5)] : []; },
      onUpdate: async (one) => { seen.push(one.update_id); },
      onTrouble: () => {},
      wait: async () => {},
    });
    poller.start();
    await finished;
    await poller.close();
    expect(seen).toEqual([4, 5]);
    expect(asked.slice(0, 2)).toEqual([0, 6]);
  });

  it('waits twice as long after each failure, and rests once it has failed five times', async () => {
    const waits: number[] = [];
    const said: (string | null)[] = [];
    const poller = createPoller({
      updates: async () => { throw new Error('no network'); },
      onUpdate: async () => {},
      onTrouble: (why) => said.push(why),
      // Closing from inside the loop's own wait: the abort ends the loop, and the close settles after it.
      wait: async (ms) => { waits.push(ms); if (waits.length >= BREAK_AFTER) void poller.close(); },
    });
    await poller.start();
    expect(waits).toEqual([1000, 2000, 4000, 8000, BREAK_FOR]);
    expect(said.at(-1)).toContain('resting for five minutes');
  });

  it('forgets its trouble the moment Telegram answers again', async () => {
    const said: (string | null)[] = [];
    let first = true;
    let done: () => void;
    const quiet = new Promise<void>((settle) => { done = settle; });
    const poller = createPoller({
      updates: async () => { if (first) { first = false; throw new Error('down'); } return []; },
      onUpdate: async () => {},
      onTrouble: (why) => { said.push(why); if (why === null && said.length > 1) done(); },
      wait: async () => {},
    });
    poller.start();
    await quiet;
    await poller.close();
    expect(said[0]).toContain('Telegram did not answer');
    expect(said).toContain(null);
  });

  it('stops cleanly, and starting twice runs one loop', async () => {
    let calls = 0;
    const poller = createPoller({ updates: async () => { calls += 1; return []; }, onUpdate: async () => {}, onTrouble: () => {}, wait: async () => {} });
    const running = poller.start();
    expect(poller.start()).toBe(running);
    await poller.close();
    expect(poller.on()).toBe(false);
    const after = calls;
    await new Promise((done) => { setTimeout(done, 20); });
    expect(calls).toBe(after);
  });
});
