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
// `say` is what the cheatsheet lists for it, when its own label is not the thing to type.
export type Command = Suggestion & { when?: (typed: string) => boolean; say?: string[] };

// Each card the bar can add: the words that ask for it, what it says, and an example of the words for the cheatsheet.
const CARD_WORDS: [RegExp, Extract<Action, { do: 'add' }>['kind'], string, string][] = [
  [/^(sticky( note)?|note)$/, 'note', 'Add a sticky note', 'add a note'], [/^(link|web ?page|url)$/, 'link', 'Add a link', 'add a link'],
  [/^(picture|image|photo)$/, 'image', 'Add a picture', 'add a picture'],
  [/^((image|picture) studio|generate (an? )?(image|picture)s?|image ?gen)$/, 'imagegen', 'Add an image studio', 'add an image studio'],
  [/^(voice studio|generate (a )?voices?|voice ?gen|say (something )?out loud|text to speech|voice ?over)$/, 'voicegen', 'Add a voice studio', 'add a voice studio'],
  [/^(video studio|generate (a )?videos?|video ?gen|film|movie|clip)$/, 'videogen', 'Add a video studio', 'add a video studio'],
  [/^browser$/, 'browser', 'Add a browser', 'add a browser'], [/^(coder|opencode|project( folder)?|code|repo)$/, 'project', 'Add a coder', 'add a coder'],
  [/^((task )?board|tasks|kanban)$/, 'board', 'Add a task board', 'add a board'],
  [/^(leads?|crm|prospects?|pipeline)$/, 'leads', 'Add a leads card', 'add leads'],
];
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
// The bar's own commands. `words` is what, typed in full, asks for one outright; `say` is how the cheatsheet shows it.
type Starter = Suggestion & { words?: RegExp; say?: string[] };
const STARTERS: Starter[] = [
  { section: 'Do', label: 'Needs you', hint: 'What waits for you', action: { do: 'panel', name: 'needs' }, words: /^(needs?( you| me)?|what needs me|inbox|approvals?|waiting)$/, say: ['needs', 'inbox', 'approvals'] },
  { section: 'Do', label: 'Messages', hint: 'Every conversation', action: { do: 'panel', name: 'messages' }, words: /^(messages?|conversations?|chats?|threads?)$/, say: ['messages', 'chats'] },
  { section: 'Do', label: 'Decisions', hint: 'What you decided, and why', action: { do: 'panel', name: 'decisions' }, words: /^decisions?( log)?$/, say: ['decisions'] },
  { section: 'Do', label: 'Playbook', hint: 'What the people learned', action: { do: 'panel', name: 'playbook' }, words: /^(playbook|skills?|what (we|they|the people) learned|how we work)$/, say: ['playbook', 'skills'] },
  { section: 'Do', label: 'Notes', hint: 'What you learned', action: { do: 'panel', name: 'library' }, words: /^(notes?|library|my notes|what i learned)$/, say: ['notes', 'library'] },
  { section: 'Do', label: 'Add a person', action: { do: 'add', kind: 'room' } },
  { section: 'Do', label: 'Add a doc', action: { do: 'add', kind: 'doc' } },
  { section: 'Do', label: 'Record a decision', action: { do: 'new-decision' }, words: /^(record|log|new|add)( a)? decision$/, say: ['record a decision'] },
  { section: 'Do', label: 'Who is idle?', action: { do: 'idle' }, words: /^who('s| is)? (idle|free|busy|working)$/, say: ['who is idle?', 'who is busy?'] },
  { section: 'Do', label: 'Show everything', hint: 'Fit the stage in the window', action: { do: 'fit' }, words: /^(show (everything|all)|fit|zoom out|overview)$/, say: ['show everything', 'zoom out'] },
  { section: 'Do', label: 'Keyboard shortcuts', action: { do: 'keys' }, words: /^(shortcuts?|keys|keyboard( shortcuts)?|help)$/, say: ['shortcuts', 'keys', 'help'] },
  { section: 'Do', label: 'Dashboard', hint: 'Your day, your tokens, your teams, what was made', action: { do: 'panel', name: 'dashboard' }, words: /^(dashboard|home|today|my day)$/, say: ['dashboard', 'home', 'today'] },
];
const offer = ({ words: _words, say: _say, ...suggestion }: Starter): Suggestion => suggestion;

// Every word the bar knows, as the cheatsheet lists it: made from the same tables `suggest` reads, so it can never
// say something the bar does not do. `say` is typed as shown; "…" is where the founder's own words go.
export type Word = { say: string[]; does: string };
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const described = (one: Suggestion) => (one.hint ? `${one.label}: ${lower(one.hint)}` : one.label);
// A slice may offer one command twice (on an empty bar, and for its own words): it is listed once, by its label unless
// the slice says which words to type.
function fromSlices(extra: Command[]): Word[] {
  const rows = new Map<string, Word>();
  for (const one of extra) {
    const row = rows.get(one.label) ?? { say: [], does: described(one) };
    row.say.push(...(one.say ?? []).filter((say) => !row.say.includes(say)));
    rows.set(one.label, row);
  }
  return [...rows].map(([label, row]) => (row.say.length ? row : { ...row, say: [lower(label)] }));
}
export function commandWords(extra: Command[] = sliceCommands()): Word[] {
  return [
    { say: ['ask Maya to …', 'Maya: …', '@Maya …'], does: 'Put a question in that person’s ask box and bring them forward' },
    { say: ['hire a designer', 'add a person'], does: 'Add a person; with a role, the role is filled in' },
    { say: ['add a doc called …'], does: 'Add a doc, named if you name it' },
    { say: CARD_WORDS.map(([, , , say]) => say), does: 'Add that card to the stage' },
    { say: ['open …', 'focus …'], does: 'Bring a card forward by its name or role' },
    ...STARTERS.filter((one) => one.say).map((one) => ({ say: one.say!, does: described(one) })),
    ...fromSlices(extra),
    { say: ['a few words you remember'], does: 'Search the workspace and your notes; anything else is offered to your people as a question' },
  ];
}

// Patterns first, then names on the stage. Text that matches neither is never interpreted: it is offered to each
// person as a question, and the workspace search (added by the bar itself) shows where those words were said.
export function suggest(input: string, known: Known, extra: Command[] = sliceCommands()): Suggestion[] {
  const typed = input.trim().replace(/\s+/g, ' ');
  if (!typed) return [...STARTERS.map(offer), ...extra.filter((one) => !one.when)];
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

  for (const starter of STARTERS) if (starter.words?.test(low)) found.push(offer(starter));

  if (!opening && !target) for (const card of named(low).slice(0, 5)) found.push({ section: 'On the stage', label: card.label, hint: card.role ?? card.type, action: { do: 'jump', id: card.id } });
  // A few letters of a starter ("dec", "mess") find it too.
  if (low.length >= 3) for (const starter of STARTERS) if (starter.label.toLowerCase().startsWith(low) && !found.some((one) => one.label === starter.label)) found.push(offer(starter));

  // What the slices brought, on their own terms; a command without a `when` answers to a few letters of its label.
  for (const one of extra) if (one.when ? one.when(low) : low.length >= 3 && one.label.toLowerCase().startsWith(low)) found.push(one);

  if (!found.length) for (const one of people.slice(0, 5)) found.push({ section: 'Ask', label: `Ask ${one.label}`, hint: typed, action: { do: 'ask', roomId: one.id, text: typed }, fallback: true });
  return found;
}
