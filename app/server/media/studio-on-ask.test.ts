import { describe, expect, it } from 'vitest';
import type { Stage } from '../../shared/model.ts';
import { asksForFilm, studioFor } from './studio-on-ask.ts';

const room = { id: 'maya', name: 'Maya', role: 'Marketing', x: 0, y: 0, w: 380, h: 520 };
const bare = (): Stage => ({ rooms: [room] as Stage['rooms'], docs: [], wires: [], cards: [] });

describe('a film asked of somebody with no video studio', () => {
  it('knows a film ask from talk about a film', () => {
    for (const ask of ['make a 20 s explainer about our quote tool', '20 s explainer about our quote tool', 'Can you do a short video for the launch?', 'I need a reel for Instagram', 'add a video studio'])
      expect(asksForFilm(ask), ask).toBe(true);
    for (const said of ['what did you think of that video?', "don't make a video yet", 'write the runway doc', '/tool generate_video {}'])
      expect(asksForFilm(said), said).toBe(false);
  });

  it('adds a studio beside the asker and wires it to them, and says so', () => {
    const stage = bare();
    const plan = studioFor(stage, 'maya', 'make a 20 s explainer about our quote tool')!;
    expect(plan.added.made).toBe(true);
    expect(plan.added.line).toMatch(/added one beside me and wired it to me/);
    plan.edit(stage);
    expect(stage.cards).toEqual([expect.objectContaining({ id: plan.added.id, kind: 'videogen', w: 380, h: 420 })]);
    expect(stage.cards![0].x).toBeGreaterThan(room.x + room.w);
    expect(stage.wires).toEqual([{ id: `maya-${plan.added.id}`, from: 'maya', fromHandle: 'r', to: plan.added.id, toHandle: 'l' }]);
    // Asked again, the studio is already wired: nothing more.
    expect(studioFor(stage, 'maya', 'make another video')).toBeNull();
  });

  it('wires a studio nobody is wired to rather than making a second one', () => {
    const stage = bare();
    stage.cards = [{ id: 'videogen-a', kind: 'videogen', x: 900, y: 0, w: 380, h: 420 }];
    const plan = studioFor(stage, 'maya', 'make a film about us')!;
    expect(plan.added).toMatchObject({ id: 'videogen-a', made: false });
    plan.edit(stage);
    expect(stage.cards).toHaveLength(1);
    expect(stage.wires.map((wire) => wire.to)).toEqual(['videogen-a']);
  });

  it('does nothing when the ask is not for a film', () => {
    expect(studioFor(bare(), 'maya', 'work out our runway')).toBeNull();
  });
});
