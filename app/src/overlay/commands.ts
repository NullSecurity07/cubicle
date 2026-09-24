import { sliceCommands } from '../slices';

// What the command bar can do, as plain data: the bar shows suggestions, the window carries the chosen action out.
// `run` is the one a UI slice brings: the bar closes and calls it, without knowing what it does.
export type Action =
  | { do: 'add'; kind: 'room' | 'doc' | 'note' | 'link' | 'image' | 'imagegen' | 'voicegen' | 'videogen' | 'browser' | 'project' | 'board' | 'leads'; data?: Record<string, string> }
  | { do: 'focus' | 'jump'; id: string } | { do: 'panel'; name: 'needs' | 'messages' | 'decisions' | 'playbook' | 'library' | 'dashboard' }
  // One note out of the founder's library, opened to be read.
  | { do: 'note'; id: string }
  | { do: 'ask'; roomId: string; text: string } | { do: 'thread' | 'decision'; id: string } | { do: 'file'; path: string }
  | { do: 'new-decision' } | { do: 'idle' } | { do: 'fit' } | { do: 'keys' } | { do: 'run'; run: () => void };
// `fallback`: nothing matched, so the text is only offered to people. What was found in the workspace ranks above these,
// and below everything the founder asked for outright.
export type Suggestion = { section: 'Do' | 'On the stage' | 'Notes' | 'In the workspace' | 'Ask'; label: string; hint?: string; action: Action; fallback?: true };
export type Known = { cards: { id: string; type: string; label: string; role?: string }[] };
// What a UI slice adds to the bar: the suggestion the bar already knows how to show, and when to show it. `when` is
// asked with what was typed, tidied and in lower case; a command without one is offered only on an empty bar.
export type Command = Suggestion & { when?: (typed: string) => boolean };

const CARD_WORDS: [RegExp, Extract<Action, { do: 'add' }>['kind'], string][] = [
  [/^(sticky( note)?|note)$/, 'note', 'Add a sticky note'], [/^(link|web ?page|url)$/, 'link', 'Add a link'], [/^(picture|image|photo)$/, 'image', 'Add a picture'],
  [/^((image|picture) studio|generate (an? )?(image|picture)s?|image ?gen)$/, 'imagegen', 'Add an image studio'],
  [/^(voice studio|generate (a )?voices?|voice ?gen|say (something )?out loud|text to speech|voice ?over)$/, 'voicegen', 'Add a voice studio'],
  [/^(video studio|generate (a )?videos?|video ?gen|film|movie|clip)$/, 'videogen', 'Add a video studio'],
  [/^browser$/, 'browser', 'Add a browser'], [/^(coder|opencode|project( folder)?|code|repo)$/, 'project', 'Add a coder'], [/^((task )?board|tasks|kanban)$/, 'board', 'Add a task board'],
  [/^(leads?|crm|prospects?|pipeline)$/, 'leads', 'Add a leads card'],
];
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const STARTERS: Suggestion[] = [
  { section: 'Do', label: 'Needs you', hint: 'What waits for you', action: { do: 'panel', name: 'needs' } },
  { section: 'Do', label: 'Messages', hint: 'Every conversation', action: { do: 'panel', name: 'messages' } },
  { section: 'Do', label: 'Decisions', hint: 'What you decided, and why', action: { do: 'panel', name: 'decisions' } },
  { section: 'Do', label: 'Playbook', hint: 'What the people learned', action: { do: 'panel', name: 'playbook' } },
  { section: 'Do', label: 'Notes', hint: 'What you learned', action: { do: 'panel', name: 'library' } },
  { section: 'Do', label: 'Add a person', action: { do: 'add', kind: 'room' } },
  { section: 'Do', label: 'Add a doc', action: { do: 'add', kind: 'doc' } },
  { section: 'Do', label: 'Record a decision', action: { do: 'new-decision' } },
  { section: 'Do', label: 'Who is idle?', action: { do: 'idle' } },
  { section: 'Do', label: 'Show everything', hint: 'Fit the stage in the window', action: { do: 'fit' } },
  { section: 'Do', label: 'Keyboard shortcuts', action: { do: 'keys' } },
  { section: 'Do', label: 'Dashboard', hint: 'Your day, your tokens, your teams, what was made', action: { do: 'panel', name: 'dashboard' } },
];

// Patterns first, then names on the stage. Text that matches neither is never interpreted: it is offered to each
// person as a question, and the workspace search (added by the bar itself) shows where those words were said.
export function suggest(input: string, known: Known, extra: Command[] = sliceCommands()): Suggestion[] {
  const typed = input.trim().replace(/\s+/g, ' ');
  if (!typed) return [...STARTERS, ...extra.filter((one) => !one.when)];
  const low = typed.toLowerCase().replace(/[?.!]+$/, '');
  const people = known.cards.filter((card) => card.type === 'room' && card.label);
  const person = (name: string) => people.find((one) => one.label.toLowerCase() === name.toLowerCase());
  const found: Suggestion[] = [];

  // "ask maya …", "tell dev to …", "maya: …", "@maya …"
  const said = /^(?:ask|tell)\s+(\S+?),?\s+(?:to\s+)?(.+)$/i.exec(typed) ?? /^@?([^\s:@]+):\s*(.+)$/.exec(typed) ?? /^@(\S+)\s+(.+)$/.exec(typed);
  const target = said && person(said[1]);
  if (target) found.push({ section: 'Ask', label: `Ask ${target.label}`, hint: said![2], action: { do: 'ask', roomId: target.id, text: said![2] } });

  const adding = /^(?:add|new|create|hire)\s+(?:an?\s+|the\s+)?(.+)$/.exec(low);
  if (adding) {
    const what = adding[1];
    const card = CARD_WORDS.find(([pattern]) => pattern.test(what));
    const doc = /^(?:doc|document|page)(?:\s+(?:called\s+|named\s+)?(.+))?$/.exec(what);
    if (card) found.push({ section: 'Do', label: card[2], action: { do: 'add', kind: card[1] } });
    else if (doc) found.push({ section: 'Do', label: doc[1] ? `Add a doc called "${sentence(typed.slice(typed.length - doc[1].length))}"` : 'Add a doc', action: { do: 'add', kind: 'doc', ...(doc[1] ? { data: { title: sentence(typed.slice(typed.length - doc[1].length)) } } : {}) } });
    else if (/^(person|someone|teammate|colleague)$/.test(what)) found.push({ section: 'Do', label: 'Add a person', action: { do: 'add', kind: 'room' } });
    else found.push({ section: 'Do', label: `Add a person: ${sentence(what)}`, hint: 'You name them and write their brief', action: { do: 'add', kind: 'room', data: { role: sentence(what) } } });
  }

  const opening = /^(?:focus|open|show|go to)\s+(?:on\s+)?(.+)$/.exec(low);
  const named = (text: string) => known.cards.filter((card) => card.label.toLowerCase().includes(text) || card.role?.toLowerCase().includes(text));
  if (opening) for (const card of named(opening[1]).slice(0, 3)) found.push({ section: 'On the stage', label: `Focus ${card.label}`, action: { do: 'focus', id: card.id } });

  if (/^(needs?( you| me)?|what needs me|inbox|approvals?|waiting)$/.test(low)) found.push(STARTERS[0]);
  if (/^(messages?|conversations?|chats?|threads?)$/.test(low)) found.push(STARTERS[1]);
  if (/^(record|log|new|add)( a)? decision$/.test(low)) found.push(STARTERS[7]);
  else if (/^decisions?( log)?$/.test(low)) found.push(STARTERS[2]);
  if (/^(playbook|skills?|what (we|they|the people) learned|how we work)$/.test(low)) found.push(STARTERS[3]);
  if (/^(notes?|library|my notes|what i learned)$/.test(low)) found.push(STARTERS[4]);
  if (/^who('s| is)? (idle|free|busy|working)$/.test(low)) found.push(STARTERS[8]);
  if (/^(show (everything|all)|fit|zoom out|overview)$/.test(low)) found.push(STARTERS[9]);
  if (/^(shortcuts?|keys|keyboard( shortcuts)?|help)$/.test(low)) found.push(STARTERS[10]);
  if (/^(dashboard|home|today|my day)$/.test(low)) found.push(STARTERS[11]);

  if (!opening && !target) for (const card of named(low).slice(0, 5)) found.push({ section: 'On the stage', label: card.label, hint: card.role ?? card.type, action: { do: 'jump', id: card.id } });
  // A few letters of a starter ("dec", "mess") find it too.
  if (low.length >= 3) for (const starter of STARTERS) if (starter.label.toLowerCase().startsWith(low) && !found.includes(starter)) found.push(starter);

  // What the slices brought, on their own terms; a command without a `when` answers to a few letters of its label.
  for (const one of extra) if (one.when ? one.when(low) : low.length >= 3 && one.label.toLowerCase().startsWith(low)) found.push(one);

  if (!found.length) for (const one of people.slice(0, 5)) found.push({ section: 'Ask', label: `Ask ${one.label}`, hint: typed, action: { do: 'ask', roomId: one.id, text: typed }, fallback: true });
  return found;
}

// One table for the handler and for the sheet that explains it.
export const KEYS: { keys: string; what: string }[] = [
  { keys: 'Ctrl K', what: 'Command bar: find anything, do anything' }, { keys: '/', what: 'Command bar' },
  { keys: 'F', what: 'Focus the selected card' }, { keys: 'N', what: 'Needs you' }, { keys: 'M', what: 'Messages' }, { keys: 'D', what: 'Decisions' }, { keys: 'Ctrl D', what: 'Dashboard' },
  { keys: 'Esc', what: 'Back one level' }, { keys: '?', what: 'This sheet' },
];
