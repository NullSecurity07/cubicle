import { describe, expect, it } from 'vitest';
import type { TurnResult } from '../loop.ts';
import { asksCommitment, checksPreconditions, holdPartner, oneCall, PRECONDITION_NUDGE, UNCHECKED } from './pushback.ts';

const JOURNEY = 'I want to raise a $2M pre-seed next week. We have no users. Draft the plan.';
const turn = (text: string, tools: TurnResult['tools'] = []): TurnResult => ({ text, tools, provider: 'p', model: 'm', usage: { input: 10, output: 5 }, stopped: false });

describe('the partner\'s precondition check', () => {
  it('knows a founder asking for a raise, hire, spend or pivot plan', () => {
    expect(asksCommitment(JOURNEY)).toBe(true);
    for (const said of ['Plan how we hire two engineers next month', 'Draft a budget to spend $20k on ads', "Let's pivot to B2B, write the plan"]) expect(asksCommitment(said), said).toBe(true);
    for (const said of ['What do you think of the name?', 'Draft the landing page copy', 'We raised the price, how do users react?']) expect(asksCommitment(said), said).toBe(false);
  });

  it('knows a reply that checked the preconditions', () => {
    expect(checksPreconditions('Not yet. Before that, get 20 paying users.')).toBe(true);
    expect(checksPreconditions('I disagree: no users means no round.\n\nMy call: no.')).toBe(true);
    expect(checksPreconditions('Here is your 7-phase raise plan. 1. Prepare a SAFE with a $2M cap.')).toBe(false);
  });

  it('asks once more with the nudge when a raise plan comes back unchecked, and keeps the tools of both', async () => {
    let asked = 0;
    const reply = await holdPartner(JOURNEY, turn('Phase 1: SAFE at $2M.', [{ id: 't1', name: 'create_doc', args: {}, ok: true }]), async () => { asked += 1; return turn('Not yet. Before that: 20 users.\n\nMy call: no raise this month.'); });
    expect(asked).toBe(1);
    expect(reply.text).toBe('Not yet. Before that: 20 users.\n\nMy call: no raise this month.');
    expect(reply.tools.map((one) => one.id)).toEqual(['t1']);
    expect(reply.usage).toEqual({ input: 20, output: 10 });
  });

  it('posts the second answer with a line for the founder when it still did not check', async () => {
    const reply = await holdPartner(JOURNEY, turn('Phase 1: SAFE.'), async () => turn('Phase 1: SAFE, again.'));
    expect(reply.text).toBe(`Phase 1: SAFE, again.\n\n${UNCHECKED}`);
    expect(UNCHECKED).toContain('Partner did not check preconditions.');
  });

  it('leaves other asks, checked replies and stopped turns alone', async () => {
    let asked = 0;
    const again = async () => { asked += 1; return turn('x'); };
    await holdPartner('What do you think of the name?', turn('Fine.'), again);
    await holdPartner(JOURNEY, turn('Not yet.'), again);
    await holdPartner(JOURNEY, { ...turn('Phase 1'), stopped: true }, again);
    expect(asked).toBe(0);
    expect(PRECONDITION_NUDGE).toMatch(/preconditions/);
  });

  it('keeps one "My call:" line, the last', () => {
    expect(oneCall('Newsletter first.\n\nMy call: **Newsletter first**.\n\nWhy: less risk.\n\nMy call: Newsletter first.')).toBe('Newsletter first.\n\nWhy: less risk.\n\nMy call: Newsletter first.');
    expect(oneCall('- **My call:** a\ntext\n**My call:** b')).toBe('text\n**My call:** b');
    expect(oneCall('No call here.')).toBe('No call here.');
  });
});
