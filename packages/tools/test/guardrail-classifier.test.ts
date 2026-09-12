/**
 * The constitution guardrail's `banned_tactics` classifier: the one check in the tool layer that leaves the
 * process. B1 (2026-09-13) found it unbounded — it inherited the provider's `timeout_ms`, which is 300 000 ms
 * for the local floor — and failing **open**, which made the constitution's strictest rule the one rule a flat
 * local model could quietly switch off.
 */
import { describe, it, expect } from 'vitest';
import type { Router, RoutedChatResult, RouteRequest } from '@cubicle/router';
import { classifyBannedTactic, CLASSIFIER_TIMEOUT_MS } from '../src/index.js';

/** A router whose one chat call does whatever `fn` says, and remembers how it was asked to route. */
function router(fn: (req: RouteRequest) => Promise<Partial<RoutedChatResult>>): Router & { seen: RouteRequest[] } {
  const seen: RouteRequest[] = [];
  const r = {
    seen,
    async chat(req: RouteRequest): Promise<RoutedChatResult> {
      seen.push(req);
      const out = await fn(req);
      return { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'cheap', downgraded: false, parsedToolCalls: [], ...out } as RoutedChatResult;
    },
  };
  return r as unknown as Router & { seen: RouteRequest[] };
}

const says = (json: string) => router(async () => ({ content: json }));
/** Distinct copy per case: a verdict is memoised per (text, tactics), so a repeat would never be asked. */
let n = 0;
const freshText = (): string => `An ordinary note about the roadmap, number ${++n}-${Date.now()}`;

describe('the banned_tactics classifier is bounded by its own clock', () => {
  it('gives up after CLASSIFIER_TIMEOUT_MS rather than inheriting the provider timeout, and refuses the call', async () => {
    // Never settles — the wedged local model of the B1 report, whose provider bound is 300 000 ms.
    const wedged = router(() => new Promise<Partial<RoutedChatResult>>(() => undefined));
    const warnings: string[] = [];
    const t0 = Date.now();
    const res = await classifyBannedTactic(wedged, freshText(), ['fake urgency'], { warn: (m) => warnings.push(m) });
    const elapsed = Date.now() - t0;

    expect(res.verdict).toBe('unavailable');
    expect(elapsed).toBeLessThan(CLASSIFIER_TIMEOUT_MS * 2);
    expect(CLASSIFIER_TIMEOUT_MS).toBe(20_000);
    // Fails CLOSED: a reason, naming the guardrail and the cause, not a null that would let the copy out.
    expect(res.reason).toContain('constitution guardrail');
    expect(res.reason).toContain('banned_tactics classifier');
    expect(res.reason).toContain(`no answer in ${CLASSIFIER_TIMEOUT_MS} ms`);
    expect(warnings.length).toBe(1);
  }, 60_000);

  it('fails closed on a transport error and on a reply with no verdict, and never throws', async () => {
    const broken = router(async () => { throw new Error('ollama down'); });
    const rambling = says('I think that is probably fine?');
    const warnings: string[] = [];

    const a = await classifyBannedTactic(broken, freshText(), ['fake urgency'], { warn: (m) => warnings.push(m) });
    expect(a.verdict).toBe('unavailable');
    expect(a.reason).toContain('ollama down');

    const b = await classifyBannedTactic(rambling, freshText(), ['fake urgency'], { warn: (m) => warnings.push(m) });
    expect(b.verdict).toBe('unavailable');
    expect(b.reason).toContain('answered with no verdict');

    expect(warnings.length).toBe(2);
    for (const w of warnings) expect(w).toContain('refusing the call rather than sending it unchecked');
  });

  it('still says yes and no when the model answers, and remembers the answer', async () => {
    const clear = says('{"violates": false, "tactic": ""}');
    const text = freshText();
    expect((await classifyBannedTactic(clear, text, ['fake urgency'])).verdict).toBe('clear');
    expect((await classifyBannedTactic(clear, text, ['fake urgency'])).memoised).toBe(true);
    expect(clear.seen.length).toBe(1);

    const caught = says('{"violates": true, "tactic": "fake urgency"}');
    const hit = await classifyBannedTactic(caught, freshText(), ['fake urgency']);
    expect(hit.verdict).toBe('violation');
    expect(hit.reason).toContain('fake urgency');
  });
});
