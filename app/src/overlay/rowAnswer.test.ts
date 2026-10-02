import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Attention } from '../../shared/model';
import { answerQuick, quickAnswer } from './rowAnswer';

const step = (name: string, more: Partial<Attention> = {}): Attention => ({
  id: `approval:${name}`, kind: 'approval', title: name, at: 1, roomId: 'build', who: 'Dev',
  event: { id: `t-${name}`, name, args: { language: 'javascript', code: 'console.log(1)', tries: 2 }, waiting: true }, ...more,
});

describe('a dashboard row that waits for the founder\'s OK', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('carries the same two answers the needs-you list gives', () => {
    expect(quickAnswer(step('run_code'))).toMatchObject({ yes: 'Run', tool: { id: 't-run_code' } });
    expect(quickAnswer(step('send_email'))?.yes).toBe('Send');
    expect(quickAnswer(step('run_code', { kind: 'run-approval' }))?.yes).toBe('Run');
  });

  it('leaves to their own place a question, a step done by hand, a coder\'s ask, a lapsed step and anything else', () => {
    expect(quickAnswer(step('ask_founder'))).toBeNull();
    expect(quickAnswer(step('browse_help'))).toBeNull();
    expect(quickAnswer(step('coder_permission', { coder: { tool: 'bash', what: 'ls' } as Attention['coder'] }))).toBeNull();
    expect(quickAnswer(step('run_code', { lapsed: true }))).toBeNull();
    expect(quickAnswer({ id: 'page-changed:w', kind: 'page-changed', title: 'x', at: 1 })).toBeNull();
    expect(quickAnswer(undefined)).toBeNull();
  });

  it('answers in the same approvals book: yes with the step as asked, no with nothing', async () => {
    const sent: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { sent.push({ url, body: JSON.parse(String(init.body)) }); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); });
    const quick = quickAnswer(step('run_code'))!;
    await answerQuick(quick, true);
    await answerQuick(quick, false);
    expect(sent.map((one) => one.url)).toEqual(['/api/approvals/t-run_code', '/api/approvals/t-run_code']);
    expect(sent[0].body).toEqual({ ok: true, args: { language: 'javascript', code: 'console.log(1)' } });
    expect(sent[1].body).toEqual({ ok: false });
  });
});
