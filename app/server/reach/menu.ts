import type { Room } from '../../shared/model.ts';
import type { Command } from './telegram.ts';

// The founder said they would not remember everybody's name. So they do not have to: the `/` menu on their phone is
// the stage, and it is filled from the stage — a person each, then the handful of things the bot itself can do.
// Telegram is strict about what a command may be called: lower case letters, digits and underscores, 32 at most.
const WORD = 32;
// Telegram takes a hundred; the last few are ours, so a very full stage loses its tail rather than the menu.
const MANY = 100;

export const OWN: Command[] = [
  { command: 'people', description: 'Everyone, and who is working' },
  { command: 'who', description: 'Who you are talking to' },
  { command: 'digest', description: 'How today is going' },
  { command: 'voice', description: 'Answer me out loud, or stop' },
  { command: 'quiet', description: 'Stop the updates, or start them' },
  { command: 'help', description: 'What I can do' },
];
const RESERVED = new Set([...OWN.map((one) => one.command), 'start', 'pair']);

// "Maya" is `/maya`; "Ana-Maria Ruiz" is `/ana_maria_ruiz`; a name with nothing Telegram will take is `/person`.
// Two people who come out the same are numbered, because a founder typing `/sam` must reach exactly one Sam.
export const wordFor = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, WORD) || 'person';

// The people the menu has room for, which is every one of them until a stage grows past what Telegram will hold.
const listed = (rooms: Room[]) => rooms.slice(0, MANY - OWN.length);

export function commandsFor(rooms: Room[]): Command[] {
  const taken = new Set(RESERVED);
  const people: Command[] = [];
  for (const room of listed(rooms)) {
    const wanted = wordFor(room.name);
    let word = wanted;
    for (let next = 2; taken.has(word); next += 1) word = `${wanted.slice(0, WORD - String(next).length)}${next}`;
    taken.add(word);
    people.push({ command: word, description: `${room.name}${room.role ? ` · ${room.role}` : ''}`.slice(0, 256) });
  }
  return [...people, ...OWN];
}

// Which room a `/word` means, worked out the same way the menu was, so the two can never drift apart.
export function roomForWord(rooms: Room[], word: string): Room | undefined {
  const people = listed(rooms);
  const at = commandsFor(rooms).findIndex((one) => one.command === word.toLowerCase());
  return at >= 0 && at < people.length ? people[at] : undefined;
}

// Telegram keeps the last menu it was given, so it is only worth telling when the stage has actually changed.
export const menuSignature = (commands: Command[]) => commands.map((one) => `${one.command}:${one.description}`).join('\n');
