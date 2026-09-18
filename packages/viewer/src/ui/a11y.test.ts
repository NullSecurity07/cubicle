import { describe, it, expect } from 'vitest';
import { applySnapshot, emptyState, type Snapshot } from '../state.js';
import { officeOutline, outlineHtml } from './a11y.js';

const snap: Snapshot = {
  op: 'snapshot', at: 'now',
  roles: [
    { role: 'ceo', display: 'CEO', sprite: 'ceo', desk: 'ceo', active: true, title: 'Chief executive' },
    { role: 'qa_lead', display: 'QA Lead', sprite: 'qa_lead', desk: 'qa_lead', active: true, title: 'Head of QA' },
    { role: 'gone', display: 'Gone', sprite: 'gone', desk: 'gone', active: false },
  ],
  jobs: [], surfaces: [], quota: [], latestRun: null, plan: '# Plan\n\n## Objective\nShip the scanner.\n', pendingProposals: 1,
  inbox: [{ id: 'p1', kind: 'founder_brief', title: 'founder_brief', path: '00 Inbox/x.md', created: '2026-09-18T09:00:00.000Z' }],
  layout: {
    version: 1,
    nodes: { note_1: { kind: 'note', x: 20, y: 20, label: 'Ask the CFO about runway' }, cto: { x: 4, y: 4 } },
    connections: [{ from: 'ceo', to: 'qa_lead', kind: 'peer' }],
  },
};
const s = applySnapshot(emptyState(), snap);

describe('the office as a list', () => {
  const groups = officeOutline(s);
  const find = (title: string) => groups.find((g) => g.title === title);

  it('opens with what is waiting on the owner, named as a person would say it', () => {
    expect(groups[0].title).toBe('Needs you');
    expect(groups[0].items[0]).toEqual({ open: 'decision:p1', label: 'Founder brief', detail: 'needs you' });
  });

  it('names everyone who is in, and nobody who is not', () => {
    const people = find('People')!;
    expect(people.items.map((i) => i.label)).toEqual(['CEO', 'QA Lead']);
    expect(people.items[0].open).toBe('agent:ceo');
    expect(people.items[0].detail).toContain('Chief executive');
  });

  it('carries every wall screen with the line it is showing', () => {
    const screens = find('Screens')!;
    const plan = screens.items.find((i) => i.open === 'whiteboard')!;
    expect(plan.label).toBe('Plan');
    expect(plan.detail).toContain('Ship the scanner');
  });

  it('names what the owner put on the floor, and only what is still on it', () => {
    const floor = find('On the floor')!;
    expect(floor.items).toEqual([{ open: 'thing:note_1', label: 'Ask the CFO about runway', detail: 'note' }]);
  });

  it('says what a line between two desks means, in words', () => {
    expect(find('Connections')!.items[0]).toEqual({ open: 'org', label: 'CEO and QA Lead', detail: 'can message each other' });
  });

  it('is buttons that open what clicking the thing would open, and is escaped', () => {
    const html = outlineHtml([{ title: 'People & "others"', items: [{ open: 'agent:ceo', label: '<CEO>', detail: 'idle at desk' }] }]);
    expect(html).toContain('<button data-open="agent:ceo">');
    expect(html).toContain('&lt;CEO&gt;');
    expect(html).toContain('People &amp; &quot;others&quot;');
  });

  it('says nothing about an empty office rather than a list of empty headings', () => {
    const bare = officeOutline(emptyState());
    expect(bare.some((g) => g.title === 'Needs you')).toBe(false);
    expect(bare.some((g) => g.title === 'People')).toBe(false);
  });
});
