import { describe, expect, it } from 'vitest';
import type { Attention } from '../shared/model.ts';
import { askFounder, createApprovals, putToFounder } from './approvals.ts';

const entry = (id: string): Attention & { event: { id: string; name: string; args: Record<string, unknown> } } => ({ id: `approval:${id}`, kind: 'approval', title: 'Send it?', at: 1, event: { id, name: 'send_email', args: {} } });

// A "Needs you" list whose write takes as long as the test says, so an answer can arrive in the middle of it.
function slowBook() {
  const open = new Set<string>();
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  return {
    open, release,
    async raise(one: Attention) { await held; open.add(one.id); },
    async clear(id: string) { open.delete(id); },
  };
}

describe('askFounder', () => {
  it('hears an answer given while the question is still being put up', async () => {
    const approvals = createApprovals();
    const book = slowBook();
    const asked = askFounder(book, approvals, entry('call-1'));
    // The window already shows the question (it came over another road) and the founder presses yes at once.
    expect(approvals.answer('call-1', { ok: true })).toBe(true);
    book.release();
    expect(await asked).toEqual({ ok: true });
    expect(book.open.size).toBe(0);
  });

  it('takes the question out of "Needs you" once it is answered', async () => {
    const approvals = createApprovals();
    const book = slowBook();
    book.release();
    const { answer } = await putToFounder(book, approvals, entry('call-2'));
    expect([...book.open]).toEqual(['approval:call-2']);
    approvals.answer('call-2', { ok: false });
    expect(await answer).toEqual({ ok: false });
    expect(book.open.size).toBe(0);
  });

  it('answers no for a stopped turn, and leaves nothing waiting when the question could not be shown', async () => {
    const approvals = createApprovals();
    const stop = new AbortController();
    const book = slowBook();
    book.release();
    const asked = askFounder(book, approvals, entry('call-3'), stop.signal);
    await Promise.resolve();
    stop.abort();
    expect(await asked).toEqual({ ok: false });
    const broken = { raise: async () => { throw new Error('disk full'); }, clear: async () => {} };
    await expect(askFounder(broken, approvals, entry('call-4'))).rejects.toThrow('disk full');
    expect(approvals.answer('call-4', { ok: true })).toBe(false);
  });
});
