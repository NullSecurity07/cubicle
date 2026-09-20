import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// `roomId` is who wrote it, so that a reply to it on the phone reaches them; `threadId` is the topic it belongs in.
// Both are written down with the words, because a message resent after a restart has to land where it was meant to.
// `file` is a picture or a film a person made, by its path in the shared files; for one of those the text is the
// caption that goes under it, which may be no more than what the picture was called.
export type Outgoing = { id: string; chatId: number; text: string; at: number; roomId?: string; threadId?: number; loud?: boolean; file?: string };
export type Outbox = ReturnType<typeof createOutbox>;

const newId = () => `out-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

// Every reply that goes out to the phone is written down before it is sent and marked once it has gone. The file is
// only ever appended to, so a crash can lose nothing it had accepted; on the next start, whatever is written and
// unmarked is sent again.
//
// The honest gap: a crash *between* the send and the mark sends that one message twice, because Telegram has it and
// this file does not know. The mark is the very next thing after the request comes back, so the window is
// milliseconds wide — rare, not impossible. Losing a message the founder is waiting for would be worse than seeing
// one twice, so it is this way round on purpose.
export function createOutbox(path: string) {
  let queue: Promise<unknown> = Promise.resolve();
  const line = (entry: unknown) => {
    queue = queue.then(async () => { await mkdir(dirname(path), { recursive: true }); await appendFile(path, `${JSON.stringify(entry)}\n`); });
    return queue;
  };

  return {
    settled: () => queue.catch(() => {}),
    async write(chatId: number, text: string, extra: Omit<Partial<Outgoing>, 'id' | 'chatId' | 'text'> = {}): Promise<Outgoing> {
      const entry: Outgoing = { id: newId(), chatId, text, at: Date.now(), ...extra };
      await line(entry);
      return entry;
    },
    async mark(id: string) { await line({ sent: id }); },
    // What was written and never marked, oldest first.
    async pending(): Promise<Outgoing[]> {
      const text = await readFile(path, 'utf8').catch(() => '');
      const written: Outgoing[] = [];
      const sent = new Set<string>();
      for (const row of text.split('\n')) {
        if (!row.trim()) continue;
        try {
          const entry = JSON.parse(row) as Outgoing & { sent?: string };
          if (entry.sent) sent.add(entry.sent);
          // A picture with nothing said about it is still something to send, so a file counts as much as words do.
          else if (entry.id && (entry.text || entry.file)) written.push(entry);
        } catch { /* a half-written last line after a crash: the rest still stands */ }
      }
      return written.filter((entry) => !sent.has(entry.id));
    },
  };
}
