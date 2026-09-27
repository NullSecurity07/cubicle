import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Framework } from '../../shared/frameworks.ts';
import type { Box, DocRules, Stage } from '../../shared/model.ts';
import { readableDocIds, wiredDocIds } from '../prompt.ts';
import { addedTwice, replaceSection, rewriteLoss } from './sections.ts';
import { text, type Tool, type ToolContext } from './registry.ts';
import { shortDay } from '../clock.ts';
import { figureCheck, HELD_BACK } from '../truth.ts';
import { findCompanyDoc } from '../../shared/partner.ts';
import { filled, guardWrite, sectionBody, unmarked, WHOLE } from './verdict.ts';

// A new doc card's size, and the gap kept round it: the same the window uses when it places one.
const [WIDTH, HEIGHT, GAP] = [340, 300, 40];

// Where a doc made by a person lands: beside them, in the nearest place nothing else is standing.
function besideRoom(stage: Stage, room: Box): { x: number; y: number } {
  const boxes: Box[] = [...stage.rooms, ...stage.docs, ...(stage.cards ?? [])];
  const hits = (x: number, y: number) => boxes.some((one) => x < one.x + one.w + GAP && x + WIDTH + GAP > one.x && y < one.y + one.h + GAP && y + HEIGHT + GAP > one.y);
  const start = { x: room.x + (room.w || 380) + 80, y: room.y };
  for (let ring = 0; ring <= 6; ring += 1) {
    for (let row = -ring; row <= ring; row += 1) {
      for (let column = -ring; column <= ring; column += 1) {
        if (Math.max(Math.abs(row), Math.abs(column)) !== ring) continue;
        const [x, y] = [start.x + column * (WIDTH + GAP), start.y + row * (HEIGHT + GAP)];
        if (!hits(x, y)) return { x, y };
      }
    }
  }
  return start;
}

// The doc's card and its wire to the person who made it, put on the stage here rather than by whichever window
// happens to be open: a doc made from the phone, in a board run or by a colleague asked to do it has no window
// watching, and without this it had no card, no wire, and nobody could reach it again. The wire has the name the
// window gives it too, so a window that does hear of it adds nothing twice.
const docOnStage = (roomId: string, id: string, title: string) => (stage: Stage) => {
  const room = stage.rooms.find((one) => one.id === roomId);
  if (!room || stage.docs.some((one) => one.id === id)) return;
  stage.docs.push({ id, title, ...besideRoom(stage, room), w: WIDTH, h: HEIGHT });
  stage.wires.push({ id: `${roomId}-${id}`, from: roomId, fromHandle: 'r', to: id, toHandle: 'l' });
};

// Docs this person may touch, by title: the wired ones plus any made during this turn. Reading also reaches every
// pinned doc, because the prompt tells each person those are company documents they all read; a read_doc that
// refused one made a person say the brief it had in front of it did not exist. Writing a pinned doc still needs a wire.
function reachable(context: ToolContext, reading: boolean) {
  const docs = new Map<string, string>();
  const ids = reading ? readableDocIds(context.stage, context.roomId) : wiredDocIds(context.stage, context.roomId);
  for (const id of ids) docs.set(id, context.stage.docs.find((doc) => doc.id === id)!.title);
  for (const [id, title] of context.granted) docs.set(id, title);
  return docs;
}

function find(context: ToolContext, wanted: string, reading = false) {
  const docs = reachable(context, reading);
  const key = wanted.trim().toLowerCase();
  const hits = [...docs].filter(([id, title]) => id === key || title.trim().toLowerCase() === key);
  if (hits.length === 1) return hits[0][0];
  const pinned = !reading && context.stage.docs.find((one) => one.pinned && (one.id === key || one.title.trim().toLowerCase() === key));
  if (!hits.length && pinned) throw new Error(`"${pinned.title}" is a pinned company document: you can read it, but writing to it needs a wire from the founder.`);
  const titles = [...docs.values()].map((title) => `"${title}"`).join(', ') || 'none';
  throw new Error(hits.length ? `more than one connected document is called "${wanted}"` : `no connected document is called "${wanted}". Connected: ${titles}. Ask the founder to draw a wire to it.`);
}

// A team placed before its doc carried rules still has people who say which team they came from. The rules are
// taken from that team as it ships, by the doc's title, each time and never saved: a miss is a doc with no rules, as
// before. Read once per team.
const SHIPPED = resolve(import.meta.dirname, '../../frameworks');
const shipped = new Map<string, Promise<Framework | null>>();
const shippedTeam = (id: string) => {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return Promise.resolve(null);
  if (!shipped.has(id)) shipped.set(id, readFile(join(SHIPPED, id, 'framework.json'), 'utf8').then((raw) => JSON.parse(raw) as Framework).catch(() => null));
  return shipped.get(id)!;
};

export async function rulesOf(stage: Stage, id: string): Promise<DocRules | undefined> {
  const doc = stage.docs.find((one) => one.id === id);
  if (!doc || doc.rules) return doc?.rules;
  const teams = new Set(stage.rooms.filter((room) => room.framework && wiredDocIds(stage, room.id).includes(id)).map((room) => room.framework!.id));
  for (const team of teams) {
    const spec = (await shippedTeam(team))?.docs.find((one) => one.title.trim().toLowerCase() === doc.title.trim().toLowerCase());
    if (spec?.rules?.framework === team) return spec.rules;
  }
  return undefined;
}

// Every write goes through here. A team's shared doc carries rules for whose each section is and when its verdict may
// stand, so what is saved may be the writer's words with a stale mark or a "not assessed" verdict put in.
// Figures a write adds that nothing this turn read gives, and are not already marked "(unsourced)" after them: what the
// truth net would flag under the reply. A live person's accountant costs, flagged in chat, went into the doc plain.
// The doc's own text counts as read. Outside a turn there is nothing to check against.
const MARK = ' (unsourced)';
const at = (label: string) => new RegExp(`(?<![\\d.,])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d])(?!\\s*\\(unsourced\\))`, 'g');
function unsourcedIn(context: ToolContext, before: string, after: string): string[] {
  if (!context.sources) return [];
  return figureCheck(after, [...context.sources(), before]).unsourced.filter((label) => at(label).test(after));
}

// The Company brief's Numbers section, which a cap on no conversations reads for paying users.
async function numbersOf(context: Pick<ToolContext, 'stage' | 'store'>): Promise<string> {
  const company = findCompanyDoc(context.stage.docs);
  return company ? sectionBody(await context.store.readDoc(company.id).catch(() => ''), 'Numbers') ?? '' : '';
}

async function save(context: ToolContext, id: string, before: string, written: string, done: string, touches?: string | typeof WHOLE) {
  const rules = await rulesOf(context.stage, id);
  // A team doc with rules is held to its evidence, so an unsourced figure is refused there; anywhere else it is marked.
  const unsourced = unsourcedIn(context, before, written);
  if (unsourced.length && rules) {
    throw new Error(`not written: ${unsourced.join(', ')} ${unsourced.length > 1 ? 'are' : 'is'} not in anything this turn read. Search or read for them first, take them out, or write "(unsourced)" right after each.`);
  }
  const after = unsourced.reduce((text, label) => text.replace(at(label), `${label}${MARK}`), written);
  if (unsourced.length) done = `${done} Marked as unsourced, since nothing this turn read gives them: ${unsourced.join(', ')}.`;
  // Only a team doc's own sections are kept to one copy, where a second would slip past the checks; a plain doc such
  // as a running log repeats "## Monday" on purpose.
  const twice = rules ? addedTwice(before, after, [...rules.sections, rules.verdict].map((one) => one.heading)) : null;
  if (twice) throw new Error(`not written: "${twice}" is already a section of this document; change it with replace_section instead of adding it again.`);
  const guarded = rules ? guardWrite({ rules, stage: context.stage, docId: id, writerId: context.roomId, before, after, now: Date.now(), touches, numbers: await numbersOf(context) }) : { text: after };
  await context.store.replaceDoc(id, guarded.text);
  const said = guarded.held ? guarded.note! : [done, guarded.note].filter(Boolean).join(' ');
  return { text: said, effect: { kind: 'doc-changed' as const, id } };
}

// Whether a question is about a section: it names the section's words ("founder-market fit") or its number
// ("section 4"), read past case, hyphens and the heading's own "4." in front.
function asksAbout(question: string, heading: string): boolean {
  const flat = (words: string) => words.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const number = /^(\d+)[.)]\s/.exec(heading)?.[1];
  const words = flat(heading.replace(/^\d+[.)]\s*/, '').replace(/\([^)]*\)/g, ''));
  return (!!words && flat(question).includes(words)) || (!!number && new RegExp(`\\bsection\\s+${number}\\b`, 'i').test(question));
}

const HEDGE = /\b(not sure|unsure|don'?t know|do not know|haven'?t|have not|no idea|no clue|unclear|unknown|hard to say|need to ask|ask (?:the )?founder|tbd|n\/a|pending|not yet|can'?t say)\b/i;
// An answer that is itself a question for the founder: a live colleague asked for his section wrote back "please answer
// the question below so I can complete Section 4" and a list of choices, and it went in as the section.
// "Could you tell me" and "what is your" count only as a sentence of their own that ends in a question mark: an answer
// that quotes "what is your edge?" inside itself is still an answer. Bold round the question does not hide it.
// A pick-one menu that ends "Please provide the applicable reason(s) so I can complete Section 4." is one too.
// The emphasis is taken off first, so "ask_founder" is read as "askfounder".
// "Which of these" and "which of the following" ask only as a whole sentence, the first or after a lead-in ("Section 4
// needs your input. Which of these applies to you:"): "she tested which of these channels reach consultants" is an
// answer that happens to use the words.
const ASKS = /\b(?:ask (?:the )?founder|please answer|answer the question|ask_?founder|please provide|please tell me|pick one|let me know (?:which|what|how|whether)|so I can complete)\b/i;
const QUESTION = /^(?:could you tell me|what is your)\b.*\?$/i;
const PICK = /^which of (?:these|the following)\b.*[?:]$/i;
// Sentences, each bare of the quote marks, bullets and emphasis round it; a sentence ends at its mark even when bold
// closes after it ("**What is your edge?** Then I can write it.").
const sentencesOf = (answer: string) => answer.split(/\n|(?<=[.!?][*_]*)\s+/).map((sentence) => sentence.replace(/^[\s>*_#-]+/, '').replace(/[\s*_]+$/, '').trim()).filter(Boolean);
const asksBack = (answer: string) => ASKS.test(answer.replace(/[*_`]/g, '').replace(/[\u00a0\u202f]/g, ' '))
  || sentencesOf(answer).some((sentence) => QUESTION.test(sentence)) || sentencesOf(answer).some((sentence) => PICK.test(sentence));
const hedges = (answer: string) => /\?\s*$/.test(answer.trim()) || HEDGE.test(answer.replace(/[’‘]/g, "'")) || asksBack(answer);

// The words an answer says beyond its section's name: three letters or more, and not a bare yes or no. None left
// ("No." to "have you written section 4 yet?", or "Founder-market fit.") says nothing that could be the section.
const AFFIRM = new Set(['yes', 'yeah', 'yep', 'nope', 'okay', 'sure']);
function saying(text: string, heading: string): string[] {
  const words = (said: string) => said.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2);
  const named = new Set(words(heading));
  return words(text).filter((word) => !named.has(word) && !AFFIRM.has(word));
}

// An answer most of whose words are the question's own: the question said back, maybe as dictated to them. The
// section's own words are left out on both sides, so "Founder-market fit: lived it." is an answer.
function echoes(answer: string, question: string, heading: string): boolean {
  const asked = new Set(saying(question, heading));
  const said = saying(answer, heading);
  return said.filter((word) => asked.has(word)).length / said.length >= 0.7;
}

// A colleague answering in chat wraps their section in chat talk: a live one opened "✅ **Section 4 – Founder-market
// fit** in the Evaluation doc is now completed:" and closed "You can now proceed to write the verdict.", and both went
// into the doc. A leading heading or status line (one that names the section or a doc and says it is done) and a
// closing "you can now ..." sentence are taken off; the rest is the section. An answer with nothing left is kept whole.
const STATUS = /\b(?:completed?|done|written|updated|filled(?: in)?|finished|ready|here is|here's|below)\b/i;
const CLOSE = /^(?:you can now|you may now|now you can|you(?:'re| are) (?:now )?(?:ready|free|good) to|feel free|let me know|next,? you can)\b/i;
export function substance(answer: string, heading: string): string {
  // A line that only says the section's own heading again, bold or as a heading: it doubled the heading inside the
  // section on a live run, and as a heading line it would start a second copy of the section.
  const same = (line: string) => line.replace(/[*_`#>]/g, '').replace(/[‐‑–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
  const lines = answer.trim().split('\n').filter((line) => !line.trim() || same(line) !== same(heading));
  while (lines.length && !lines[0].trim()) lines.shift();
  const plain = (line: string) => line.replace(/[*_`#>]/g, '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  const names = (line: string) => /\b(?:section|doc|document)\b/i.test(line) || plain(line).toLowerCase().includes(heading.replace(/^\d+[.)]\s*/, '').toLowerCase().replace(/-/g, ' ').slice(0, 12));
  const first = lines[0] ?? '';
  if (/^#{1,6}\s/.test(first.trim())) lines.shift();
  // A status line only: one that ends in a colon, opens with a mark or bold, or says the section is done after naming it.
  // "Lived it: I filed VAT by hand, all done in a spreadsheet doc." is the answer itself.
  else if (STATUS.test(plain(first)) && names(plain(first).replace(/[‐‑–—-]/g, ' '))
    && (/:\s*$/.test(first.trim()) || /^(?:[^\p{L}\p{N}\s]|\*\*)/u.test(first.trim()) || /\bsection\b[^:]*\b(?:is|are)\s+(?:now\s+)?(?:completed?|done|written|filled|finished|ready)\b/i.test(first))) {
    const colon = first.search(new RegExp(`${STATUS.source}[^:]*:`, 'i'));
    const rest = colon >= 0 ? first.slice(first.indexOf(':', colon) + 1).trim() : '';
    if (colon >= 0 || /[:.!]\s*$/.test(first.trim())) { if (rest) lines[0] = rest; else lines.shift(); }
  }
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  const last = lines.at(-1) ?? '';
  if (CLOSE.test(plain(last))) lines.pop();
  else {
    const sentences = last.split(/(?<=[.!?])\s+/);
    if (sentences.length > 1 && CLOSE.test(plain(sentences.at(-1)!))) lines[lines.length - 1] = sentences.slice(0, -1).join(' ');
  }
  const kept = lines.join('\n').trim();
  return filled(kept).length ? kept : answer.trim();
}

// What a colleague answering in chat had in front of them: what the asker's turn read (the question's words with it),
// what the founder said in the colleague's own room, and the documents the colleague reads. Their memory is not here,
// so a figure only it holds reads as unsourced.
async function colleagueRead(context: ToolContext, targetId: string, question: string): Promise<string[]> {
  const chat = await context.store.readChat(targetId).catch(() => []);
  const docs = await Promise.all(readableDocIds(context.stage, targetId).map((id) => context.store.readDoc(id).catch(() => '')));
  return [...(context.sources?.() ?? []), question, ...chat.filter((message) => message.role === 'user').map((message) => message.text), ...docs];
}

// The figures in a colleague's answer that nothing they read gives, in the order said: money, shares and counts with a
// unit as the truth net reads them, and a bare count over ten ("~200 solo-consultant peers") that no number they read
// matches. Years and figures already marked "(unsourced)" are left alone.
function inventedIn(answer: string, sources: string[]): string[] {
  const found = figureCheck(answer, sources).unsourced.filter((label) => at(label).test(answer)).map((label) => ({ label, index: answer.search(at(label)) }));
  const read = new Set(sources.flatMap((source) => [...source.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((match) => Number(match[0].replace(/,/g, '')))));
  for (const match of answer.matchAll(/(?<![\d.,/$€£])((?:~|≈|about |around |over |some )?)(\d{1,3}(?:,\d{3})+|\d+)(?![\d.,]?\d|\s*%|\s*\/|\s*\(unsourced)/gi)) {
    const value = Number(match[2].replace(/,/g, ''));
    if (value <= 10 || (value >= 1900 && value <= 2099) || read.has(value)) continue;
    if (found.some((one) => one.label.includes(match[2]))) continue;
    found.push({ label: `${match[1].trim() === '~' || match[1].trim() === '≈' ? match[1].trim() : ''}${match[2]}`, index: match.index });
  }
  return found.sort((a, b) => a.index - b.index).map((one) => one.label);
}

// A colleague asked with ask_person answers in words, without tools, so their answer never reached their own section of
// a team doc, and a verdict waiting on it waited until the founder answered in the Needs you box. When the asker and
// the colleague share such a doc, the colleague's section there is empty and the question is about it, the answer is
// written into it as the colleague's own write, marked as from chat. Returns what to tell the asker, or null.
export async function answerIntoSection(context: ToolContext, targetId: string, question: string, said: string): Promise<string | null> {
  // A marker the colleague wrote themselves is dropped: the only one is the one put in below.
  const answer = unmarked(said).trim();
  const { stage } = context;
  const asker = stage.rooms.find((room) => room.id === context.roomId);
  const target = stage.rooms.find((room) => room.id === targetId);
  if (!asker || !target) return null;
  const shared = wiredDocIds(stage, targetId).filter((id) => wiredDocIds(stage, context.roomId).includes(id));
  const waiting: string[] = [];
  for (const id of shared) {
    const rules = await rulesOf(stage, id);
    const key = target.framework?.id === rules?.framework ? target.framework?.key : undefined;
    if (!rules || !key) continue;
    const before = await context.store.readDoc(id);
    const empty = rules.sections.filter(({ heading, by }) => by === key && sectionBody(before, heading) !== null && !filled(sectionBody(before, heading)).length);
    const asked = empty.filter(({ heading }) => asksAbout(question, heading));
    waiting.push(...empty.filter((one) => !asked.includes(one)).map(({ heading }) => heading));
    // One section at a time: an answer to a question naming two is not split between them.
    if (asked.length !== 1 || !filled(answer).length || answer.trim() === HELD_BACK) continue;
    const [{ heading }] = asked;
    // A colleague answering without tools does not know their reply becomes their section, so they hedge or ask back;
    // written in, a hedge counted as the section and let a verdict stand on it. Nor is the question said back an answer.
    if (!saying(answer, heading).length) return `${target.name} answered but did not fill "${heading}"; it stays empty. Ask ${target.name} what goes in it.`;
    if (hedges(answer) || echoes(answer, question, heading)) return `${target.name} answered but did not fill "${heading}"; it stays empty.`;
    const asking = question.replace(/\s+/g, ' ').trim();
    const body = `${substance(answer, heading)}\n\n(From chat: ${target.name} answered ${asker.name} on ${shortDay(Date.now())}, asked "${asking.length > 200 ? `${asking.slice(0, 199)}…` : asking}".)`;
    // A figure the colleague could not have read anywhere is not written in as theirs: a live one, asked about the
    // founder's fit, gave "~200 solo-consultant peers" the founder never said, and it went into the doc unflagged.
    const invented = inventedIn(substance(answer, heading), [...await colleagueRead(context, targetId, question), before]);
    if (invented.length) return `Not written into "${heading}": ${target.name}'s answer gives ${invented.join(', ')} that nothing ${target.name} read gives. The section stays empty until ${target.name} writes it with a source, or the founder gives the figure.`;
    const next = replaceSection(before, heading, body);
    if ('error' in next) continue;
    // The section's own checks hold as for any write of theirs; one that fails is said, and the answer still stands.
    let guarded;
    try { guarded = guardWrite({ rules, stage, docId: id, writerId: targetId, before, after: next.text, now: Date.now(), fromChat: true, numbers: await numbersOf(context) }); } catch (error) {
      // The guard speaks to the writer ("Write it again", "Ask Priya with ask_person"); the asker gets only the reason.
      const why = (error as Error).message.replace(/^not written:\s*/, '').replace(/\s+(?:Write it again|Ask \S+ with ask_person)[\s\S]*$/, '');
      return `Not written into "${heading}": ${why} The section stays empty until ${target.name} writes it within the section's rules.`;
    }
    await context.store.replaceDoc(id, guarded.text);
    context.report?.({ kind: 'doc-changed', id });
    return `Written into "${heading}" as ${target.name}'s answer, from chat.`;
  }
  return waiting.length ? `${target.name} has not written ${waiting.map((heading) => `"${heading}"`).join(', ')} yet; ask them about it by name and their answer is written there.` : null;
}

const doc = { type: 'string', description: 'Title of a document connected to your room' };

export const docTools: Tool[] = [
  {
    name: 'read_doc',
    description: 'Read the current text of a connected or pinned document. Its text is already in your context; use this only to check it again after a change.',
    parameters: { type: 'object', properties: { doc }, required: ['doc'] },
    run: async (args, context) => ({ text: (await context.store.readDoc(find(context, text(args, 'doc'), true))) || '(empty)' }),
  },
  {
    name: 'write_doc',
    description: 'Replace the whole text of a connected document. The old version is kept in the trash. To change one section, use replace_section; to add, use append_doc.',
    parameters: {
      type: 'object',
      properties: {
        doc, text: { type: 'string', description: 'The full new markdown text' },
        replace: { type: 'boolean', description: 'True only when the founder asked for the whole document to be rewritten' },
      },
      required: ['doc', 'text'],
    },
    async run(args, context) {
      const id = find(context, text(args, 'doc'));
      const body = text(args, 'text');
      const before = await context.store.readDoc(id);
      // A rewrite that would lose most of what is there is refused, because a person asked to change one section
      // has been seen to write back only that section. A document they made in this turn is theirs to rewrite.
      if (args.replace !== true && !context.granted.has(id)) {
        const loss = rewriteLoss(before, body);
        if (loss) throw new Error(`not written: this would replace the whole document, and ${loss}. Change one section with replace_section, or add with append_doc; the rest is a colleague's or the founder's work.`);
      }
      return save(context, id, before, body, `Wrote ${body.length} characters.`, WHOLE);
    },
  },
  {
    name: 'replace_section',
    description: 'Replace the text under one markdown heading of a connected document, up to the next heading of the same or higher level. Every other section stays as it is.',
    parameters: {
      type: 'object',
      properties: {
        doc,
        heading: { type: 'string', description: 'The heading of the section, as written in the document, without the #' },
        text: { type: 'string', description: 'The new markdown under that heading, without the heading itself' },
      },
      required: ['doc', 'heading', 'text'],
    },
    async run(args, context) {
      const id = find(context, text(args, 'doc'));
      const heading = text(args, 'heading', 200);
      const before = await context.store.readDoc(id);
      const swapped = replaceSection(before, heading, text(args, 'text'));
      if ('error' in swapped) throw new Error(swapped.error);
      return save(context, id, before, swapped.text, `Replaced the section "${heading.replace(/^#+\s*/, '').trim()}".`, heading);
    },
  },
  {
    name: 'append_doc',
    description: 'Add text to the end of a connected document.',
    parameters: { type: 'object', properties: { doc, text: { type: 'string', description: 'Markdown to add at the end' } }, required: ['doc', 'text'] },
    async run(args, context) {
      const id = find(context, text(args, 'doc'));
      const before = await context.store.readDoc(id);
      const added = text(args, 'text');
      return save(context, id, before, `${before.replace(/\s+$/, '')}${before.trim() ? '\n\n' : ''}${added}\n`, `Added ${added.length} characters.`);
    },
  },
  {
    name: 'create_doc',
    description: 'Create a new document card next to your room, already connected to you.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string', description: 'The markdown text' } }, required: ['title', 'text'] },
    async run(args, context) {
      const title = text(args, 'title', 80).trim();
      const id = `doc-${Math.random().toString(36).slice(2, 8)}`;
      await context.store.writeDoc(id, text(args, 'text'));
      context.granted.set(id, title);
      // A stage that cannot be saved just now still leaves a doc the person can write to this turn.
      await Promise.resolve().then(() => context.store.patchStage(docOnStage(context.roomId, id, title))).catch(() => {});
      return { text: `Created "${title}".`, effect: { kind: 'doc-created', id, title } };
    },
  },
];
