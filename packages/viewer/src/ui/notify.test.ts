import { describe, it, expect } from 'vitest';
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
