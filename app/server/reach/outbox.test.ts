import { mkdtempSync, readFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOutbox } from './outbox.ts';

const where = () => join(mkdtempSync(join(tmpdir(), 'reach-out-')), 'outbox.jsonl');

describe('the outbox', () => {
  it('has nothing pending before anything is written', async () => {
    expect(await createOutbox(where()).pending()).toEqual([]);
  });

  it('keeps a message pending until it is marked as sent', async () => {
    const path = where();
    const outbox = createOutbox(path);
    const one = await outbox.write(11, 'first');
    await outbox.write(11, 'second');
    expect((await outbox.pending()).map((entry) => entry.text)).toEqual(['first', 'second']);
    await outbox.mark(one.id);
    expect((await outbox.pending()).map((entry) => entry.text)).toEqual(['second']);
  });

  it('sends again, after a crash between writing it down and sending it', async () => {
    const path = where();
    const before = createOutbox(path);
    await before.write(11, 'the founder is waiting for this');
    await before.settled();
    // The app dies here: nothing marked it, so the next start finds it and sends it.
    const after = createOutbox(path);
    expect((await after.pending()).map((entry) => entry.text)).toEqual(['the founder is waiting for this']);
  });

  it('may send twice, after a crash between sending it and marking it', async () => {
    const path = where();
    const before = createOutbox(path);
    const sent = await before.write(11, 'already on the phone');
    await before.settled();
    // Telegram took it; the mark never got written. The next start cannot know, so it goes out again: the founder
    // sees one message twice, which is the way round we chose.
    const after = createOutbox(path);
    expect((await after.pending()).map((entry) => entry.id)).toEqual([sent.id]);
    await after.mark(sent.id);
    await after.settled();
    expect(await after.pending()).toEqual([]);
  });

  it('reads the rest of the file when a crash left half a line behind', async () => {
    const path = where();
    const outbox = createOutbox(path);
    await outbox.write(11, 'whole');
    await outbox.settled();
    appendFileSync(path, '{"id":"out-half","chatId":11,"te');
    const after = createOutbox(path);
    expect((await after.pending()).map((entry) => entry.text)).toEqual(['whole']);
  });

  it('keeps a picture waiting the same way it keeps words, caption and all', async () => {
    const path = where();
    const outbox = createOutbox(path);
    const picture = await outbox.write(11, 'a cat on a roof', { file: 'media/cat.png', roomId: 'marketing' });
    // A picture with nothing said about it is still a picture: the words being empty is not the same as nothing to send.
    const bare = await outbox.write(11, '', { file: 'media/poster.png' });
    expect((await outbox.pending()).map((entry) => entry.file)).toEqual(['media/cat.png', 'media/poster.png']);
    expect((await outbox.pending())[0]).toMatchObject({ text: 'a cat on a roof', roomId: 'marketing' });
    await outbox.mark(picture.id);
    await outbox.mark(bare.id);
    expect(await outbox.pending()).toEqual([]);
  });

  it('still reads a line written before any of this could carry a file', async () => {
    const path = where();
    const outbox = createOutbox(path);
    await outbox.write(11, 'whole');
    await outbox.settled();
    appendFileSync(path, `${JSON.stringify({ id: 'out-old', chatId: 11, text: 'from an older day', at: 1 })}\n`);
    expect((await createOutbox(path).pending()).map((entry) => entry.text)).toEqual(['whole', 'from an older day']);
  });

  it('only ever appends, so nothing it accepted can be lost by a later write', async () => {
    const path = where();
    const outbox = createOutbox(path);
    const one = await outbox.write(11, 'one');
    await outbox.mark(one.id);
    await outbox.write(12, 'two');
    await outbox.settled();
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1])).toEqual({ sent: one.id });
  });
});
