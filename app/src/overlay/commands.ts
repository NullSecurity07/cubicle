import { setDockPlace } from '../dockPlace';
import { sliceCommands } from '../slices';

// What the command bar can do, as plain data: the bar shows suggestions, the window carries the chosen action out.
// `run` is the one a UI slice brings: the bar closes and calls it, without knowing what it does.
export type Action =
  | { do: 'add'; kind: 'room' | 'doc' | 'note' | 'link' | 'image' | 'imagegen' | 'voicegen' | 'videogen' | 'browser' | 'project' | 'board' | 'leads' | 'source' | 'metrics' | 'runway' | 'deck' | 'site' | 'competitor' | 'interview' | 'survey'; data?: Record<string, string> }
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
  [/^((trusted )?(source|web ?site)s?( website)?)$/, 'source', 'Add a source website', 'add a source'],
  // The cards that came on 2026-09-25, each by the words a founder reaches for. "site" alone is the Site studio now,
  // so a source website is asked for as "source" or "website".
  [/^(metrics?|numbers|north star|kpis?|dashboard numbers)$/, 'metrics', 'Add a metrics card', 'add metrics'],
  [/^(runway|burn( rate)?|cash|finances?|money)$/, 'runway', 'Add a runway card', 'add runway'],
  [/^((pitch |seed |sales )?deck|slides|presentation|pitch)$/, 'deck', 'Add a deck', 'add a deck'],
  [/^(site studio|landing page|(one[- ]page )?(web)?site builder|site)$/, 'site', 'Add a site studio', 'add a site studio'],
  [/^((a )?competitor|rival|competition)$/, 'competitor', 'Add a competitor', 'add a competitor'],
  [/^((customer |user )?interview|customer call|call notes)$/, 'interview', 'Add an interview', 'add an interview'],
  [/^((pmf |nps )?survey|questionnaire|poll)$/, 'survey', 'Add a survey', 'add a survey'],
];
// A note from the library is picked in Notes, the way the dock's own button does it: the card is only which note.
const LIBRARY_NOTE = /^((a )?note from (the |my )?library|library( note)?)$/;
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const NOT_NAMES = /^(who|for|to|that|with|in|on|and|as|from|at|of)$/i;
const ROLE_WORD = /^(?:\w+(?:er|or|ist|ing|ant|ent)|sales|seo|ops|hr|cto|ceo|cfo|coo|cmo|pm|ux|ui|qa|legal|finance|growth|support|design|product|research)$/i;
// The name in "add a person called Lena Ortiz" or "add a person Lena", as typed; nothing when the words are a role.
function personName(typed: string): string | undefined {
  const after = /\b(?:person|someone|teammate|colleague)\s+(.+)$/i.exec(typed)?.[1].trim();
  if (!after) return undefined;
  const called = /^(?:called|named)\s+(.+)$/i.exec(after)?.[1].trim();
  if (called) return sentence(called).slice(0, 40);
  // One word: a name when written with a capital ("Vincent"); in lower case, unless it reads as a job ("designer").
  if (!/^\p{L}[\p{L}'-]*$/u.test(after) || NOT_NAMES.test(after) || (!/^\p{Lu}/u.test(after) && ROLE_WORD.test(after))) return undefined;
  return sentence(after);
}
// The bar's own commands. `words` is what, typed in full, asks for one outright; `say` is how the cheatsheet shows it.
// `quiet` ones wait to be asked: they are not listed on an empty bar, where they would only crowd the views.
type Starter = Suggestion & { words?: RegExp; say?: string[]; quiet?: true };
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
  // Where the dock sits. A narrow window keeps it along the bottom whatever is chosen here.
  { section: 'Do', label: 'Dock on the right', hint: 'The buttons in a column on the right edge', action: { do: 'run', run: () => setDockPlace('right') }, words: /^(move (the )?)?dock (on |to )?(the )?right( side| edge)?$/, say: ['dock right'], quiet: true },
  { section: 'Do', label: 'Dock on the left', hint: 'The buttons in a column on the left edge', action: { do: 'run', run: () => setDockPlace('left') }, words: /^(move (the )?)?dock (on |to )?(the )?left( side| edge)?$/, say: ['dock left'], quiet: true },
  { section: 'Do', label: 'Dock on the bottom', hint: 'The buttons in a row along the bottom', action: { do: 'run', run: () => setDockPlace('bottom') }, words: /^(move (the )?)?dock (on |to |at )?(the )?bottom( edge)?$/, say: ['dock bottom'], quiet: true },
];
const offer = ({ words: _words, say: _say, quiet: _quiet, ...suggestion }: Starter): Suggestion => suggestion;

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
    { say: ['add a note from the library'], does: 'Open your notes, to pick one to put on the stage' },
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
  if (!typed) return [...STARTERS.filter((one) => !one.quiet).map(offer), ...extra.filter((one) => !one.when)];
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
    // "add a runway card" asks for the same thing as "add runway": the word card is the founder's, never the kind's.
    const card = CARD_WORDS.find(([pattern]) => pattern.test(what) || pattern.test(what.replace(/\s+card$/, '')));
    const doc = /^(?:doc|document|page)(?:\s+(?:called\s+|named\s+)?(.+))?$/.exec(what);
    if (card) found.push({ section: 'Do', label: card[2], action: { do: 'add', kind: card[1] } });
    else if (LIBRARY_NOTE.test(what)) found.push({ section: 'Do', label: 'Add a note from your library', hint: 'Pick one in Notes', action: { do: 'panel', name: 'library' } });
    else if (doc) found.push({ section: 'Do', label: doc[1] ? `Add a doc called "${sentence(typed.slice(typed.length - doc[1].length))}"` : 'Add a doc', action: { do: 'add', kind: 'doc', ...(doc[1] ? { data: { title: sentence(typed.slice(typed.length - doc[1].length)) } } : {}) } });
    else if (/^(person|someone|teammate|colleague)$/.test(what)) found.push({ section: 'Do', label: 'Add a person', action: { do: 'add', kind: 'room' } });
    // "add a person called Lena", or one capitalised word after it ("add a person Lena"): a person with that name.
    // Anything else ("someone who does SEO", "a teammate for marketing") is the role, as before.
    else if (personName(typed)) {
      const name = personName(typed)!;
      found.push({ section: 'Do', label: `Add ${name}`, hint: 'A person; you write their role and brief', action: { do: 'add', kind: 'room', data: { name } } });
    }
    // Words a slice answers to ("add partner") are that slice's to carry out, not a person to hire by that role.
    else if (!extra.some((one) => one.when?.(low))) found.push({ section: 'Do', label: `Add a person: ${sentence(what)}`, hint: 'You name them and write their brief', action: { do: 'add', kind: 'room', data: { role: sentence(what) } } });
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
