import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toastLift } from './panel.js';
import { announcementFor, layoutRefusal } from './notify.js';
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
 * Ruling W6-2. A line the daemon would not take is said out loud in the daemon's own sentence — the same one
 * `Office/campus.md` gains under "Couldn't apply" — so the office and the note can never tell it differently.
 */
describe('what the office says about a floor change that did not take', () => {
  it('says the daemon’s sentence, which names what the line was left at', () => {
    expect(layoutRefusal([{ line: 'nodes.cto', reason: 'that spot is taken', sentence: 'cto: 30, 20 is inside a wall — kept at 44, 8', kept: '44, 8' }]))
      .toBe('cto: 30, 20 is inside a wall — kept at 44, 8');
  });
  it('names the first and counts the rest, rather than a queue of toasts', () => {
    const two = layoutRefusal([
      { line: 'nodes.cto', reason: 'that spot is taken', sentence: 'cto: 30, 20 is inside a wall — kept at 44, 8' },
      { line: 'nodes.cfo', reason: 'that spot is off the campus', sentence: 'cfo: 90, 90 is off the campus' },
    ]);
    expect(two).toBe('cto: 30, 20 is inside a wall — kept at 44, 8 — and 1 other line the office could not take');
    expect(layoutRefusal([{ line: 'a', reason: 'r', sentence: 's' }, { line: 'b', reason: 'r', sentence: 's' }, { line: 'c', reason: 'r', sentence: 's' }])).toContain('2 other lines');
  });
  it('still says something for a daemon that sends no sentence, and nothing at all for a clean write', () => {
    expect(layoutRefusal([{ line: 'nodes.cto', reason: 'that spot is taken' }])).toBe('that spot is taken (nodes.cto)');
    expect(layoutRefusal([])).toBe('');
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
