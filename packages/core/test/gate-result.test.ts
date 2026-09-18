/**
 * Ruling W4-6: a returned review is not a failed job.
 *
 * `Jobs/job_20260914_3ac2f4.md` in the 2026-09-14 dry run, verbatim: `finish({"status":"failed", …})`, summary
 * "The job is returned because the Site/src/pages/index.astro file does not contain the brand name, palette, or
 * voice as required by the job's 'Done when' criteria. It currently contains default Astro placeholder content.
 * Please update the content to reflect the SpeedAudit brand.", `"findings": []`. Nine seconds later
 * `job_20260914_45bddb` passed the same gate, and the owner was left with a permanent red job carrying nothing
 * anyone could act on.
 */
import { describe, it, expect } from 'vitest';
import { normaliseGateResult, isGateJobType, GATE_JOB_TYPES } from '../src/jobs.js';

/** The exact summary the live reviewer wrote into `status: failed`. */
const LIVE_SUMMARY = "The job is returned because the Site/src/pages/index.astro file does not contain the brand name, palette, or voice as required by the job's 'Done when' criteria. It currently contains default Astro placeholder content. Please update the content to reflect the SpeedAudit brand.";

const result = (over: Partial<Parameters<typeof normaliseGateResult>[1]> = {}) =>
  ({ status: 'done' as const, summary: '', blockers: [], findings: [], artifacts: [], metrics: {}, lessons: [], ...over });

describe('isGateJobType', () => {
  it('knows every gate in the table, under both the office-era and pre-office names', () => {
    for (const t of GATE_JOB_TYPES) expect(isGateJobType(t)).toBe(true);
    // …and the shape, so a gate an owner added to config/gates.yaml by hand is covered before it is listed.
    expect(isGateJobType('office:privacy.review')).toBe(true);
    expect(isGateJobType('team:design.verify')).toBe(true);
    expect(isGateJobType('engineer.ship')).toBe(false);
    expect(isGateJobType('research')).toBe(false);
  });
});

describe('normaliseGateResult (W4-6)', () => {
  it('a gate that says in prose it returned the work is a return, with that sentence as its finding', () => {
    const out = normaliseGateResult('team:qa.review', result({ status: 'failed', summary: LIVE_SUMMARY }));
    expect(out.status).toBe('done');
    expect(out.verdict).toBe('return');
    expect(out.findings).toEqual([LIVE_SUMMARY]);
  });

  it('reads the verb in any of its shapes, and only in the summary of a gate with nothing else to say', () => {
    expect(normaliseGateResult('research.review', result({ status: 'failed', summary: 'Returning this: Docs/offer.md names no price.' })).verdict).toBe('return');
    expect(normaliseGateResult('research.review', result({ status: 'failed', summary: 'I return it to the author.' })).verdict).toBe('return');
    // A gate that failed for its own reasons — the review did not happen — stays failed. That is a different
    // fact about the company and the owner should see it as one.
    expect(normaliseGateResult('research.review', result({ status: 'failed', summary: 'The model ran out of steps.' })).status).toBe('failed');
    // A reviewer that filed real findings meant `failed`, whatever its prose says: nothing is guessed at over it.
    const filed = normaliseGateResult('research.review', result({ status: 'failed', summary: 'Returned.', findings: ['Docs/offer.md:12 cites no source'] }));
    expect(filed.status).toBe('failed');
    expect(filed.findings).toEqual(['Docs/offer.md:12 cites no source']);
  });

  it('a gate job can never come to rest red and silent', () => {
    // Nothing at all: the fallback says the review did not happen, rather than leaving the author with `[]`.
    expect(normaliseGateResult('team:qa.review', result({ status: 'failed' })).findings).toEqual(['the reviewer finished without saying what was wrong']);
    // Blockers are findings when the reviewer filed no findings — that is where a failing gate puts its reasons.
    expect(normaliseGateResult('team:qa.review', result({ status: 'failed', summary: 'no good', blockers: ['ci.run is red on speedaudit'] })).findings).toEqual(['ci.run is red on speedaudit']);
    // …and a `verdict: return` with no findings is red too: the author is being sent back with no reason.
    expect(normaliseGateResult('office:operations.verify', result({ status: 'done', verdict: 'return', summary: 'Not verified.' })).findings).toEqual(['Not verified.']);
  });

  it('leaves a pass, and every job that is not a gate, exactly as they were written', () => {
    const pass = result({ status: 'done', verdict: 'pass', summary: 'Checked Workspace/site/.cubicle-ci/latest: green.' });
    expect(normaliseGateResult('team:qa.review', pass)).toEqual(pass);
    // An `engineer.ship` that returns its own work in prose is not a gate and is not touched.
    const ship = result({ status: 'failed', summary: 'I am returning this to the backlog.' });
    expect(normaliseGateResult('engineer.ship', ship)).toEqual(ship);
  });
});
