import { describe, it, expect } from 'vitest';
import { applyConversation, applyEvent, applySnapshot, emptyState, type Snapshot, type Thread } from '../state.js';
import { viewFor } from './surfaces.js';
import { DM_ID, chipTint, filterThreads, messagesView, roomThread, sinceText } from './messages.js';
import { THEMES, contrastRatio } from './tokens.js';
import type { Ctx } from './content.js';

const ctx: Ctx = { frames: {}, tokenQuery: '', vaultName: 'Cubicle' };
const roles = [
  { role: 'ceo', display: 'CEO', sprite: 'ceo', desk: 'ceo', active: true, title: 'Chief Executive Officer' },
  { role: 'cto', display: 'CTO', sprite: 'cto', desk: 'cto', active: true, title: 'Chief Technology Officer', team: 'technology' },
  { role: 'dev_manager', display: 'Dev Manager', sprite: 'dev_manager', desk: 'dev_1', active: true, team: 'dev' },
  { role: 'advisor_skeptic', display: 'The Skeptic', sprite: 'advisor_skeptic', desk: 'board_1', active: true, team: 'board' },
];
const threads: Thread[] = [
  { id: DM_ID, kind: 'dm', title: 'You and the CEO', participants: ['owner', 'ceo'], updated: '2026-09-13T10:00:00.000Z', open: false, last: { who: 'ceo', text: 'I filed the brief.', at: '2026-09-13T10:00:00.000Z' }, turns: 6 },
  { id: 'board:m1', kind: 'board', title: 'Is this worth building?', room: 'board', participants: ['advisor_skeptic', 'ceo'], updated: '2026-09-13T09:40:00.000Z', open: true, last: { who: 'advisor_skeptic', text: 'Who is the first customer?', at: '2026-09-13T09:40:00.000Z' }, turns: 12 },
  { id: 'agents:cto+dev_manager', kind: 'agents', title: 'Dev Manager · CTO', participants: ['cto', 'dev_manager'], updated: '2026-09-13T08:00:00.000Z', open: false, last: { who: 'cto', text: 'Ship the build first.', at: '2026-09-13T08:00:00.000Z' }, turns: 3 },
];
const base: Snapshot = { op: 'snapshot', at: 'now', roles, jobs: [], surfaces: [], quota: [], latestRun: null, plan: '', pendingProposals: 0, teams: [{ id: 'technology', name: 'Technology', lead: 'cto', members: [], mission: '', floor: 3 }, { id: 'dev', name: 'Dev', lead: 'dev_manager', members: [], mission: '', parent: 'technology' }, { id: 'board', name: 'The board', lead: 'advisor_skeptic', members: [], mission: '', room: 'boardroom', floor: 1 }], conversations: threads };
const s = applySnapshot(emptyState(), base);
const ev = (type: string, agent: string | null, payload: Record<string, unknown>, ts = '2026-09-13T11:00:00.000Z') => ({ ts, type, agent, job: null, payload });

describe('the Messages sheet (SP8 §2)', () => {
  it('is a top-bar tab with no map anchor: two panes, a thread list and a conversation', () => {
    const v = viewFor('messages', s, ctx);
    expect(v.title).toBe('Messages');
    expect(v.wide).toBe(true);
    expect(v.sub).toContain('3 conversations');
    expect(v.sub).toContain('1 live');
    expect(v.html).toContain('class="panes"');
    expect(v.html).toContain('data-act="thread:board:m1"');
    expect(v.html).toContain('Who is the first customer?');
    expect(v.html).toContain('Pick a conversation');       // nothing is open yet
  });

  it('a thread row carries participants, the last line, a relative time and a LIVE dot while it is open', () => {
    const html = messagesView(s, ctx, {}).html;
    expect(html).toContain('The Skeptic');
    expect(html).toContain('class="dot live"');
    expect((html.match(/class="dot live"/g) ?? []).length).toBe(1);   // only the open one
    expect(sinceText('2026-09-13T10:59:30.000Z', Date.parse('2026-09-13T11:00:00.000Z'))).toBe('now');
    expect(sinceText('2026-09-13T10:20:00.000Z', Date.parse('2026-09-13T11:00:00.000Z'))).toBe('40m');
    expect(sinceText('2026-09-13T08:00:00.000Z', Date.parse('2026-09-13T11:00:00.000Z'))).toBe('3h');
    expect(sinceText('2026-09-12T08:00:00.000Z', Date.parse('2026-09-13T11:00:00.000Z'))).toBe('yesterday');
    expect(sinceText('not a date')).toBe('');
  });

  it('opening a thread shows its turns as bubbles, the owner on the right', () => {
    const st = applyConversation(s, DM_ID, [
      { who: 'owner', at: '2026-09-13T09:58:00.000Z', text: 'Start with meal plans.' },
      { who: 'ceo', at: '2026-09-13T10:00:00.000Z', text: 'I filed the brief.' },
    ]);
    const html = messagesView(st, ctx, { thread: DM_ID }).html;
    expect(html).toContain('class="msg me"');
    expect(html).toContain('class="msg them"');
    expect(html).toContain('Start with meal plans.');
    expect(html).toContain('I filed the brief.');
    expect(html).toContain('aria-current="true"');
  });

  it('the composer belongs to the owner’s own thread and to no other', () => {
    expect(messagesView(s, ctx, { thread: DM_ID }).html).toContain('data-act="send"');
    expect(messagesView(s, ctx, { thread: 'board:m1' }).html).not.toContain('data-act="send"');
  });

  it('search filters by title and by participant', () => {
    expect(filterThreads(s, '').length).toBe(3);
    expect(filterThreads(s, 'worth').map((t) => t.id)).toEqual(['board:m1']);
    expect(filterThreads(s, 'skeptic').map((t) => t.id)).toEqual(['board:m1']);
    expect(filterThreads(s, 'dev manager').map((t) => t.id)).toEqual(['agents:cto+dev_manager']);
    expect(filterThreads(s, 'zzz')).toEqual([]);
    expect(messagesView(s, ctx, { search: 'zzz' }).html).toContain('No conversation matches');
    expect(messagesView(emptyState(), ctx, {}).html).toContain('No conversations yet');
  });

  it('clicking the board room opens the room’s latest thread; a room with no transcript stays a room', () => {
    expect(roomThread(s, 'boardroom')?.id).toBe('board:m1');
    expect(roomThread(s, 'pantry')).toBeNull();
    expect(viewFor('boardroom', s, ctx).title).toBe('Messages');
    expect(viewFor('boardroom', s, ctx).html).toContain('Is this worth building?');
    expect(viewFor('pantry', s, ctx).title).toBe('Pantry');
  });

  it('live turns land on the open thread and the list reorders itself', () => {
    let st = applyEvent(s, ev('meeting.opened', 'ceo', { id: 'm1', room: 'board', participants: ['ceo', 'advisor_skeptic'], agenda: 'Is this worth building?' }));
    st = applyEvent(st, ev('meeting.turn', 'advisor_skeptic', { id: 'm1', round: 2, text: 'Name one person who would pay.' }, '2026-09-13T11:01:00.000Z'));
    const html = messagesView(st, ctx, { thread: 'board:m1' }).html;
    expect(html).toContain('Name one person who would pay.');
    expect(st.conversations[0].id).toBe('board:m1');       // newest first
  });
});

describe('a participant wears their own colour, and it reads', () => {
  for (const mode of ['dark', 'light'] as const) {
    const onTint = THEMES[mode].colors.onTint;
    it(`${mode}: every role chip clears 4.5:1 against the ink on it`, () => {
      for (const r of ['ceo', 'cto', 'dev_manager', 'advisor_skeptic', 'cmo', 'coo', 'qa_lead', 'research_analyst', 'backend_engineer', 'frontend_engineer', 'growth', 'critic']) {
        for (const family of ['chief', 'advisor', 'manager', 'member'] as const) {
          expect(contrastRatio(onTint, chipTint(r, family)), `${r} (${family})`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
  it('the chip is the person’s own hue, not a colour invented per theme', () => {
    expect(chipTint('ceo')).toMatch(/^#[0-9a-f]{6}$/);
    expect(chipTint('ceo')).not.toBe(chipTint('cto'));
  });
});
