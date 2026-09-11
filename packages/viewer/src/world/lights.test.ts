import { describe, it, expect } from 'vitest';
import { litRooms, roomContaining } from './lights.js';
import type { Anchor } from './map.js';
import type { AgentView } from '../state.js';

const room = (name: string, tx: number, ty: number, tw: number, th: number): Anchor => ({ name, type: 'room', tx, ty, tw, th, props: {} });
const rooms = { dev: room('dev', 26, 29, 12, 8), qa: room('qa', 36, 16, 14, 8) };
const view = (role: string, state: AgentView['state']): AgentView => ({ role, display: role, sprite: role, desk: role, active: true, state, tool: null, job: null, bubble: null, target: null, badge: null, mood: 'neutral', moodUntil: null, emote: null, idleSince: null, division: 'other' });

describe('lamps', () => {
  it('roomContaining finds the room rect around a tile', () => {
    expect(roomContaining(rooms, { tx: 30, ty: 32 })).toBe('dev');
    expect(roomContaining(rooms, { tx: 40, ty: 20 })).toBe('qa');
    expect(roomContaining(rooms, { tx: 2, ty: 2 })).toBeNull();
  });
  it('a room is lit only while someone in it works or talks', () => {
    const agents = { sre: view('sre', 'working'), qa_lead: view('qa_lead', 'idle_at_desk'), coo: view('coo', 'talking') };
    const sprites = { sre: { tx: 31, ty: 34 }, qa_lead: { tx: 42, ty: 20 }, coo: { tx: 33, ty: 31 } };
    expect([...litRooms(agents, sprites, rooms)].sort()).toEqual(['dev']);
    expect(litRooms({ sre: view('sre', 'idle_at_desk') }, sprites, rooms).size).toBe(0);
    expect(litRooms({ qa_lead: view('qa_lead', 'working') }, sprites, rooms).has('qa')).toBe(true);
  });
});
