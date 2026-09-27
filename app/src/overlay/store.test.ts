import { describe, expect, it } from 'vitest';
import { onSide, popLayer, pushLayer, type Layer } from './store';

const focus = (id: string): Layer => ({ kind: 'focus', id });
const panel = (name: string): Layer => ({ kind: 'panel', name });

describe('overlay layers', () => {
  it('holds one focused card at a time: focusing another replaces it', () => {
    expect(pushLayer(pushLayer([], focus('maya')), focus('dev'))).toEqual([focus('dev')]);
  });

  it('stacks a panel over a focused card, and Escape goes back exactly one level', () => {
    const stack = pushLayer(pushLayer([], focus('maya')), panel('needs'));
    expect(stack).toEqual([focus('maya'), panel('needs')]);
    expect(popLayer(stack)).toEqual([focus('maya')]);
    expect(popLayer(popLayer(stack))).toEqual([]);
    expect(popLayer([])).toEqual([]);
  });

  it('shows one sheet at a time: a sheet opened from another sheet takes its place, so Escape leaves nothing behind', () => {
    const stack = pushLayer(pushLayer([], panel('needs')), panel('decisions'));
    expect(stack).toEqual([panel('decisions')]);
    expect(popLayer(stack)).toEqual([]);
    expect(pushLayer(pushLayer(pushLayer([], panel('needs')), panel('messages')), panel('needs'))).toEqual([panel('needs')]);
  });

  it('keeps the focused card under a sheet that replaces another sheet', () => {
    const stack = pushLayer(pushLayer(pushLayer([], focus('maya')), panel('needs')), panel('decisions'));
    expect(stack).toEqual([focus('maya'), panel('decisions')]);
    expect(popLayer(stack)).toEqual([focus('maya')]);
  });

  it('slides the overview in from the side, over a canvas it leaves undimmed, only while it is the view on top', () => {
    expect(onSide([panel('dashboard')])).toBe(true);
    expect(onSide([focus('maya'), panel('dashboard')])).toBe(true);
    expect(onSide([panel('dashboard'), panel('needs')])).toBe(false);
    expect(onSide([panel('needs')])).toBe(false);
    expect(onSide([focus('maya')])).toBe(false);
    expect(onSide([])).toBe(false);
  });
});
