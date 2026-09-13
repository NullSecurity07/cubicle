import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toastLift } from './panel.js';
import { announcementFor } from './notify.js';
import type { CubicleEvent } from '../state.js';

const ev = (type: string, payload: Record<string, unknown>, agent: string | null = 'ceo'): CubicleEvent => ({ ts: '2026-09-11T09:00:00.000Z', type, agent, job: null, payload });

describe('owner-facing announcements (aria-live)', () => {
  it('speaks what needs the owner and what the company finished', () => {
    expect(announcementFor(ev('proposal.created', { kind: 'brand_change', title: 'Name the company: PlateReady' }))).toBe('Needs you: Name the company: PlateReady');
    expect(announcementFor(ev('agent.spoke', { to: 'owner', text: 'I proposed a name.' }))).toBe('CEO: I proposed a name.');
    expect(announcementFor(ev('heartbeat.completed', { run: 'Runs/2026-09-11-0900.md' }))).toBe('Brief written');
    expect(announcementFor(ev('deploy.done', { url: 'https://x.pages.dev' }))).toBe('Deployed https://x.pages.dev');
    expect(announcementFor(ev('guardrail.blocked', { reason: 'max_emails_per_day' }))).toBe('Blocked: max_emails_per_day');
    expect(announcementFor(ev('role.hired', { role: 'sales_1' }, 'daemon'))).toBe('sales_1 joined the company');
  });
  it('stays quiet on chatter that is not for the owner', () => {
    expect(announcementFor(ev('proposal.created', { kind: 'message', title: 'hello', to: 'ceo' }))).toBeNull();
    expect(announcementFor(ev('agent.spoke', { to: 'cto', text: 'internal' }))).toBeNull();
    expect(announcementFor(ev('agent.tool_call', { tool: 'shell.run' }))).toBeNull();
    expect(announcementFor(ev('job.started', {}))).toBeNull();
  });
});

/**
 * Ruling P8-12: a toast never covers a fixed action bar. The stylesheet puts it at `max(68px, --toast-lift)`, and
 * the lift is the distance from the bottom of the viewport up to the top of the bar plus a gap — measured, so a
 * bar of any height (one row of buttons, or three rows of option chips) is cleared by the same rule.
 */
describe('a toast clears a reader\u2019s action bar', () => {
  it('rises to the top of the bar, with a gap', () => {
    expect(toastLift(700, 800)).toBe(112);          // an 88 px bar at the foot of the reader
    expect(toastLift(700, 800, 0)).toBe(100);
    expect(toastLift(640, 800)).toBe(172);          // a taller bar lifts it further
  });
  it('is nothing at all when no bar is on the screen', () => {
    expect(toastLift(null, 800)).toBe(0);
    expect(toastLift(Number.NaN, 800)).toBe(0);
  });
  it('never pulls the toast downwards, whatever the bar reports', () => {
    expect(toastLift(900, 800)).toBe(0);            // a bar scrolled below the fold
    expect(toastLift(812, 800)).toBe(0);
  });
  it('the stylesheet takes the larger of the toast\u2019s own place and the lift', () => {
    const css = readFileSync(fileURLToPath(new URL('./app.css', import.meta.url)), 'utf8');
    expect(css).toMatch(/#toast \{[^}]*bottom: max\(68px, var\(--toast-lift, 0px\)\)/);
  });
});
