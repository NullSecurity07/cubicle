import { describe, expect, it } from 'vitest';
import { popLayer, pushLayer, type Layer } from './store';

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

  it('opening a panel that is already open brings it to the top instead of doubling it', () => {
    const stack = pushLayer(pushLayer(pushLayer([], panel('needs')), panel('messages')), panel('needs'));
    expect(stack).toEqual([panel('messages'), panel('needs')]);
  });
});
