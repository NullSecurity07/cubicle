import { describe, expect, it } from 'vitest';
import { seedDocs, seedStage, type ChatMessage, type Stage } from '../shared/model.ts';
import { missionsOf, type Facts } from './missions.ts';

const fresh: Facts = { stage: seedStage, chats: {}, docs: { ...seedDocs }, decisions: [], tasks: [] };
const done = (facts: Facts) => missionsOf(facts).filter((mission) => mission.done).map((mission) => mission.id);
const said = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'm', role: 'user', text, at: 1, ...extra });

describe('missions', () => {
  it('a fresh workspace has six missions and none of them done', () => {
    expect(missionsOf(fresh).map((mission) => mission.id)).toEqual(['talk', 'brief', 'wire', 'person', 'act', 'decide']);
    expect(done(fresh)).toEqual([]);
    expect(missionsOf(fresh).every((mission) => mission.tip.length > 20)).toBe(true);
  });

  it('talking counts only when the founder said something, not when a colleague consulted', () => {
    expect(done({ ...fresh, chats: { build: [said('How long?', { from: 'Maya' })] } })).toEqual([]);
    expect(done({ ...fresh, chats: { build: [said('Plan the sprint')] } })).toEqual(['talk']);
  });

  it('the brief counts once it says something the template did not', () => {
    expect(done({ ...fresh, docs: { ...seedDocs, 'company-brief': `${seedDocs['company-brief']} ` } })).toEqual([]);
    expect(done({ ...fresh, docs: { ...seedDocs, 'company-brief': `${seedDocs['company-brief']}\nWe make calm scheduling software for solo founders who are drowning in tools.` } })).toEqual(['brief']);
    // any pinned doc is the brief
    const stage: Stage = { ...seedStage, docs: [{ id: 'mine', title: 'About us', pinned: true, x: 0, y: 0, w: 1, h: 1 }] };
    expect(done({ ...fresh, stage, docs: { mine: 'We make calm scheduling software for solo founders who are drowning in tools, and we charge per seat.' } })).toEqual(['brief']);
  });

  it('does not count the sections and lines the partner writes into the adopted brief', () => {
    const adopted = `${seedDocs['company-brief']}\n## Idea\n\n## Customer\n\n## Numbers\n\n## Decisions\n\n- 2026-09-26 Newsletter first vs marketplace first: Weekly curated newsletter of abandoned projects\n\n## Bets\n\n- Open: Post in r/SaaS. signups to 20 by 2026-10-03 (made 2026-09-26)\n\n## Open questions\n`;
    expect(done({ ...fresh, docs: { ...seedDocs, 'company-brief': adopted } })).toEqual([]);
    expect(done({ ...fresh, docs: { ...seedDocs, 'company-brief': adopted.replace('## Idea\n', '## Idea\n\nA weekly paid list of abandoned side projects under five thousand dollars.\n') } })).toEqual(['brief']);
  });

  it('a wire the founder drew and a person the founder added count; what the stage came with does not', () => {
    expect(done({ ...fresh, stage: { ...seedStage, wires: [...seedStage.wires, { id: 'w', from: 'build', fromHandle: 'r', to: 'company-brief', toHandle: 'l' }] } })).toEqual(['wire']);
    expect(done({ ...fresh, stage: { ...seedStage, rooms: [...seedStage.rooms, { id: 'room-x', name: '', role: '', accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1 }] } })).toEqual([]);
    expect(done({ ...fresh, stage: { ...seedStage, rooms: [...seedStage.rooms, { id: 'room-x', name: 'Rio', role: 'Design', accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1 }] } })).toEqual(['person']);
  });

  it('acting counts when a step the founder approved went through, in a chat or on a task', () => {
    const tool = (name: string, ok: boolean) => ({ id: 't', name, args: {}, ok });
    expect(done({ ...fresh, chats: { marketing: [said('x'), { id: 'a', role: 'assistant', text: '', at: 2, tools: [tool('write_doc', true), tool('send_email', false)] }] } })).toEqual(['talk']);
    expect(done({ ...fresh, chats: { marketing: [said('x'), { id: 'a', role: 'assistant', text: '', at: 2, tools: [tool('run_code', true)] }] } })).toEqual(['talk', 'act']);
    expect(done({ ...fresh, tasks: [{ id: 't', title: 'T', detail: '', column: 'review', createdAt: 1, run: { state: 'done', startedAt: 1, log: [] } }] })).toEqual(['act']);
  });

  it('deciding counts for a decision the founder made, not for a proposal', () => {
    const base = { id: 'd', title: 'T', at: 1, context: '', options: [] };
    expect(done({ ...fresh, decisions: [{ ...base, status: 'proposed' }] })).toEqual([]);
    expect(done({ ...fresh, decisions: [{ ...base, status: 'decided', chosen: 'x' }] })).toEqual(['decide']);
  });
});
