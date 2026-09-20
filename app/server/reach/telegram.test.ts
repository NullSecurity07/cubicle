import { describe, expect, it } from 'vitest';
import { BREAK_AFTER, BREAK_FOR, LIMIT, TOO_BIG_TO_SEND, createApi, createPoller, kindOf, pieces, type Update } from './telegram.ts';

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
    const sent = await api.send(5, 'Allow this?', { buttons: [[{ text: 'Approve', data: 'ok:k1' }, { text: 'Deny', data: 'no:k1' }]], loud: true });
    expect(sent.message_id).toBe(7);
    expect(body.reply_markup.inline_keyboard[0]).toEqual([{ text: 'Approve', callback_data: 'ok:k1' }, { text: 'Deny', callback_data: 'no:k1' }]);
  });

  it('lands quietly unless it is something the founder has to act on, and in the topic it belongs to', async () => {
    const bodies: any[] = [];
    const api = createApi(async () => 'key', async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return answer({ message_id: 1 }); });
    await api.send(5, 'Maya finished the launch note');
    await api.send(5, 'Maya needs your OK', { loud: true, threadId: 12 });
    expect(bodies[0].disable_notification).toBe(true);
    expect(bodies[1]).toMatchObject({ message_thread_id: 12 });
    expect(bodies[1].disable_notification).toBeUndefined();
  });

  it('asks for the one kind of update that says it was put in a group', async () => {
    let body: any = null;
    const api = createApi(async () => 'key', async (_url, init) => { body = JSON.parse(String(init?.body)); return answer([]); });
    await api.updates(0);
    expect(body.allowed_updates).toContain('my_chat_member');
  });
});

describe('how a reply is drawn on the phone', () => {
  it('sends markdown as what Telegram draws, and the same words plainly if Telegram will not take it', async () => {
    const bodies: any[] = [];
    const api = createApi(async () => 'key', async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return answer({ message_id: 1 }); });
    await api.send(5, '**Launch** on *Friday*');
    expect(bodies[0]).toMatchObject({ chat_id: 5, text: '<b>Launch</b> on <i>Friday</i>', parse_mode: 'HTML' });

    // Telegram refuses the drawing: the founder still gets every word, as plain text, in one more call.
    const tried: any[] = [];
    const fussy = createApi(async () => 'key', async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      tried.push(body);
      return body.parse_mode ? answer(null, false, 400) : answer({ message_id: 2 });
    });
    expect((await fussy.send(5, '**Launch** on Friday')).message_id).toBe(2);
    expect(tried).toHaveLength(2);
    expect(tried[1]).toEqual({ chat_id: 5, text: '**Launch** on Friday', disable_notification: true });
    // Anything else that goes wrong is not papered over by trying again.
    const down = createApi(async () => 'key', async () => answer(null, false, 502));
    await expect(down.send(5, 'hello')).rejects.toThrow('Telegram answered 502');
  });
});

describe('a picture, a film or a file on the founder\'s phone', () => {
  // What went up: which call it was, and the parts of the form, so a picture can be checked for arriving as a picture.
  const watched = (refuse: (method: string, form: FormData) => Response | null = () => null) => {
    const calls: { method: string; form: FormData }[] = [];
    const api = createApi(async () => 'key', async (url, init) => {
      const method = String(url).split('/').pop()!;
      const form = init!.body as FormData;
      calls.push({ method, form });
      return refuse(method, form) ?? answer({ message_id: calls.length });
    });
    return { api, calls, methods: () => calls.map((one) => one.method) };
  };

  it('knows what each kind of file is to Telegram', () => {
    expect(kindOf('cat.png')).toBe('photo');
    expect(kindOf('CAT.JPEG')).toBe('photo');
    expect(kindOf('media/a.webp')).toBe('photo');
    expect(kindOf('launch.mp4')).toBe('video');
    expect(kindOf('clip.mov')).toBe('video');
    expect(kindOf('said.wav')).toBe('audio');
    expect(kindOf('song.mp3')).toBe('audio');
    expect(kindOf('notes.pdf')).toBe('document');
    expect(kindOf('nothing')).toBe('document');
  });

  it('sends a picture as a picture, in the topic it belongs to and without a sound', async () => {
    const { api, calls } = watched();
    const sent = await api.sendFile(5, { bytes: Buffer.from('PNG'), name: 'cat.png' }, { caption: '**a cat** on a roof', threadId: 12 });
    expect(sent.message_id).toBe(1);
    expect(calls[0].method).toBe('sendPhoto');
    expect((calls[0].form.get('photo') as File).name).toBe('cat.png');
    expect(calls[0].form.get('chat_id')).toBe('5');
    expect(calls[0].form.get('message_thread_id')).toBe('12');
    expect(calls[0].form.get('disable_notification')).toBe('true');
    expect(calls[0].form.get('caption')).toBe('<b>a cat</b> on a roof');
    expect(calls[0].form.get('parse_mode')).toBe('HTML');
  });

  it('sends a film as a film it can play where it stands, a recording as a recording, and everything else as a file', async () => {
    const { api, calls, methods } = watched();
    await api.sendFile(5, { bytes: Buffer.from('MP4'), name: 'launch.mp4' }, { loud: true });
    await api.sendFile(5, { bytes: Buffer.from('WAV'), name: 'said.wav' }, {});
    await api.sendFile(5, { bytes: Buffer.from('PDF'), name: 'notes.pdf' }, {});
    expect(methods()).toEqual(['sendVideo', 'sendAudio', 'sendDocument']);
    expect(calls[0].form.get('supports_streaming')).toBe('true');
    expect(calls[0].form.get('disable_notification')).toBeNull();
  });

  it('sends a picture too big for Telegram to draw as a file instead, so the founder still has it', async () => {
    const { api, methods } = watched();
    await api.sendFile(5, { bytes: Buffer.allocUnsafe(11 * 1024 * 1024), name: 'huge.png' }, {});
    expect(methods()).toEqual(['sendDocument']);
  });

  it('tries once more as a file when Telegram will not take the picture at all', async () => {
    const { api, methods } = watched((method) => (method === 'sendPhoto' ? answer(null, false, 400) : null));
    const sent = await api.sendFile(5, { bytes: Buffer.from('PNG'), name: 'cat.png' }, { caption: 'a cat' });
    expect(methods().at(-1)).toBe('sendDocument');
    expect(sent.message_id).toBeGreaterThan(0);
  });

  it('says so in words a founder can read when a file is bigger than Telegram will ever take', async () => {
    const { api, calls } = watched();
    await expect(api.sendFile(5, { bytes: Buffer.allocUnsafe(51 * 1024 * 1024), name: 'film.mp4' }, {})).rejects.toThrow(TOO_BIG_TO_SEND);
    expect(calls).toEqual([]);
  });

  it('sends the caption plainly when Telegram will not take the drawing of it', async () => {
    const { api, calls } = watched((_method, form) => (form.get('parse_mode') ? answer(null, false, 400) : null));
    await api.sendFile(5, { bytes: Buffer.from('PNG'), name: 'cat.png' }, { caption: '**a cat**' });
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe('sendPhoto');
    expect(calls[1].form.get('caption')).toBe('**a cat**');
    expect(calls[1].form.get('parse_mode')).toBeNull();
  });

  it('never sends a caption longer than Telegram allows under a picture', async () => {
    const { api, calls } = watched();
    await api.sendFile(5, { bytes: Buffer.from('PNG'), name: 'cat.png' }, { caption: 'a'.repeat(3000) });
    expect(String(calls[0].form.get('caption')).length).toBeLessThanOrEqual(1024);
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
