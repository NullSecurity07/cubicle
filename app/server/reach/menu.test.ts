import { describe, expect, it } from 'vitest';
import type { Room } from '../../shared/model.ts';
import { OWN, commandsFor, menuSignature, roomForWord, wordFor } from './menu.ts';

const room = (id: string, name: string, role = ''): Room => ({ id, name, role, accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1 });

describe('the / menu, filled from the stage', () => {
  it('gives everybody a command of their own, with what they do beside it', () => {
    const menu = commandsFor([room('marketing', 'Maya', 'Marketing'), room('build', 'Dev', 'Engineering')]);
    expect(menu.slice(0, 2)).toEqual([
      { command: 'maya', description: 'Maya · Marketing' },
      { command: 'dev', description: 'Dev · Engineering' },
    ]);
    expect(menu.slice(2)).toEqual(OWN);
  });

  it('reduces a name to what Telegram will take, and numbers two that come out the same', () => {
    expect(wordFor('Ana-María Ruiz')).toBe('ana_mar_a_ruiz');
    expect(wordFor('☕')).toBe('person');
    const menu = commandsFor([room('a', 'Sam'), room('b', 'Sam'), room('c', 'Sam')]);
    expect(menu.slice(0, 3).map((one) => one.command)).toEqual(['sam', 'sam2', 'sam3']);
  });

  it('never gives a person a command the bot itself answers', () => {
    const menu = commandsFor([room('a', 'People'), room('b', 'Help')]);
    expect(menu.slice(0, 2).map((one) => one.command)).toEqual(['people2', 'help2']);
  });

  it('reads a command back to exactly the person the menu offered', () => {
    const rooms = [room('a', 'Sam'), room('b', 'Sam'), room('marketing', 'Maya')];
    expect(roomForWord(rooms, 'sam2')?.id).toBe('b');
    expect(roomForWord(rooms, 'MAYA')?.id).toBe('marketing');
    // One of its own is never a person, and neither is a name nobody has.
    expect(roomForWord(rooms, 'digest')).toBeUndefined();
    expect(roomForWord(rooms, 'nobody')).toBeUndefined();
  });

  it('changes only when the stage does, so a company standing still costs Telegram nothing', () => {
    const before = menuSignature(commandsFor([room('marketing', 'Maya', 'Marketing')]));
    expect(menuSignature(commandsFor([room('marketing', 'Maya', 'Marketing')]))).toBe(before);
    expect(menuSignature(commandsFor([room('marketing', 'Maya', 'Growth')]))).not.toBe(before);
  });
});
