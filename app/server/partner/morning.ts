import { createHash } from 'node:crypto';
import type { Lead } from '../../shared/leads.ts';
import type { ChatMessage, Decision, Stage, Task } from '../../shared/model.ts';
import { bare, morningText, readMorning, type Bet, type Morning, type MorningNote } from '../../shared/partner.ts';
import { localDay, weekDay } from '../clock.ts';
import type { ModelMessage } from '../prompt.ts';
import { sectionBody, filled, verdictOf, verdictState } from '../tools/verdict.ts';
import { checkReply, FLAG_LINE, stripFlagged, turnSources } from '../truth.ts';
import { gatherMonth } from '../slices/month.ts';
import { cardOf } from './bets.ts';
import { learnedSection, sectionText } from './company.ts';
import { breakEvenFix, breakEvenLine, economicsOf, figuresFix, type EconomicsState } from './economics.ts';
import { runwayFix } from './keep.ts';
import type { FounderPromise } from './promises.ts';
import { ruledOutBy, ruledOutLine, saidNoFor, type SaidNoEntry } from './saidno.ts';
import { gatherSince, sinceText, type SinceInput } from './since.ts';
import type { PartnerState } from './state.ts';
import { guardMove, guardUnasked, guardView, leftOutLine } from './unasked.ts';

// The partner's morning: once a day, unasked, they read the Company document (it is in their prompt), what changed
// since yesterday and the bets on record, and write three things that matter today, one risk and one question.
// Every fact they are handed is read out of the stores here; the model only chooses what matters.

const DAY = 86_400_000;
// Not before this hour: a note written at a quarter past midnight is yesterday's evening, not the founder's morning.
export const MORNING_HOUR = 6;
// A day's tries, and the wait between them, when the model is out or will not keep the shape.
export const MOST_TRIES = 3;
export const RETRY_AFTER = 30 * 60_000;
const CHAT_LINES = 4;
const CHAT_CHARS = 220;
const CHAT_MOST = 3000;

// Whether this moment should bring the morning note: a new day, late enough, and tries left.
export function morningDue(state: Pick<PartnerState, 'morning' | 'tries' | 'partnerSince'>, now: number): boolean {
  const today = localDay(now);
  if (state.morning?.day === today) return false;
  // Not on the day the partner arrived: the founder has done nothing yet for them to look at. The first note is the
  // next morning's, or whenever the founder asks for one.
  if (!state.partnerSince || state.partnerSince >= today) return false;
  if (new Date(now).getHours() < MORNING_HOUR) return false;
  const tries = state.tries?.day === today ? state.tries : null;
  return !tries || (tries.count < MOST_TRIES && now - tries.last >= RETRY_AFTER);
}

export const MORNING_ASK = 'Nobody asked you for this. It is your own daily look at the company, and the founder reads it first thing. '
  + 'Below is what changed since yesterday, the team verdicts, the figures the truth net flagged, the Company numbers, the board and the bets on record; the Company document is above. '
  + 'Think across the rooms: set the plan against the verdicts, the flags and each person\'s numbers before you choose. '
  + 'Give three moves for today: what to do, and why, each a concrete step the founder or a person can start today. '
  + 'A move that repeats a plan step or a board task word for word is no move, unless it says why it is today\'s. '
  + 'Do not restate the Company document or the brief: the founder wrote it and knows it. '
  + 'Use only these facts: name the number or the line each move rests on, and never invent one. '
  + 'When a move rests on what a closed bet taught, cite its What we learned line. '
  + 'The risk is the biggest contradiction or risk across the rooms today (a verdict against the plan, a flagged figure, two numbers that disagree), '
  + 'and it names the room, the document or the number it rests on. '
  + 'Reply in exactly this shape and nothing else, each line under thirty words, with no "My call" line here:\n'
  + 'Three moves for today:\n1. …\n2. …\n3. …\nRisk: the biggest contradiction or risk, and where it is\nQuestion: one question for the founder';

// Everything the note is read from, as one short key: decisions, bets, the Company document and what the founder or a
// person said last in each room. The partner's own messages are left out, since the note itself is one of them.
export function morningInputs(input: { stage: Stage; partnerId: string; decisions: Decision[]; bets: Bet[]; company: string; chats: Record<string, ChatMessage[]> }): string {
  const talk = input.stage.rooms.map((room) => {
    // A turn that failed changes nothing the note reads.
    const said = (input.chats[room.id] ?? []).filter((message) => !message.failed && (message.role === 'user' || room.id !== input.partnerId));
    return `${room.id}:${said.at(-1)?.at ?? 0}`;
  });
  const text = JSON.stringify([input.decisions.map((one) => [one.id, one.status, one.decidedAt ?? 0]), input.bets.map((one) => [one.id, one.status, one.result?.at ?? 0]), input.company, talk]);
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

// A risk the founder can check names where it is: a person, a document or a number. "Execution could slip" names
// nothing and could be said of any company on any day.
export function namesAPlace(risk: string, stage: Stage): boolean {
  if (/\d/.test(risk)) return true;
  const said = risk.toLowerCase();
  const names = [...stage.rooms.flatMap((room) => [room.name, room.role]), ...stage.docs.map((doc) => doc.title), 'Company document']
    .map((name) => name?.trim().toLowerCase()).filter((name): name is string => !!name && name.length > 1);
  return names.some((name) => new RegExp(`(?<![a-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`).test(said));
}

// A note whose three moves are all lines of the Company document tells the founder what they wrote, not what to do.
const flat = (text: string) => text.toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').replace(/[.;:!]+$/, '').trim();
export const restates = (things: string[], company: string) => !!company.trim() && things.every((thing) => flat(company).includes(flat(thing)));

// What goes to the model with the ask, from the stores themselves.
export type MorningSources = {
  workspace: string; stage: Stage; partnerId: string; now: number;
  decisions: () => Promise<Decision[]>; boards: (boardId: string) => Promise<Task[]>; leads: (cardId: string) => Promise<Lead[]>;
  chat: (roomId: string) => Promise<ChatMessage[]>; bets: () => Promise<Bet[]>;
  // The Company document's text, to tell a note that only restates it from one that moves the company.
  company?: string;
  // A document's text by id: the team verdicts are read out of their own documents.
  doc?: (docId: string) => Promise<string>;
  // The founder's promises and a Metrics card's numbers, for what changed since yesterday at the head of the note.
  promises?: () => Promise<FounderPromise[]>;
  metrics?: (cardId: string) => Promise<SinceInput['metrics']>;
  // The one picture of the numbers (economics.ts), with the founder's corrections and readings in it.
  economics?: () => Promise<EconomicsState | null>;
};

const VERDICT_CHARS = 400;
// The Company document's Numbers section, the one place a person's figure should agree with.
const numbersOf = (company: string) => filled(sectionBody(company, 'Numbers')).join('\n');

export const betLine = (bet: Bet) => (bet.status === 'open'
  ? `- Open: ${bare(bet.what)}. Bet: ${bare(bet.hypothesis) || 'unsaid'}. Measured by "${bet.metric}" on ${cardOf(bet.metric)}: ${bet.target} by ${bet.checkDate}.`
  : `- Closed ${bet.checkDate}: ${bare(bet.what)}. ${bet.result?.verdict === 'worked' ? 'Worked' : 'Did not work'}; "${bet.metric}" was ${bet.result?.value ?? 'unread'} against ${bet.target}.${bet.result?.note ? ` ${bet.result.note}` : ''}`);

// What the partner reads across the rooms, gathered once from the stores: the morning note is written from all of
// it, and every partner turn carries the standing part of it (server/partner/standing.ts).
export type CompanyGather = {
  yesterday: string; changed: string; chats: string; planned: string[]; verdicts: string[];
  // The truth net's lines since yesterday, grouped by room with the room's name first, and how many each room had.
  flagged: string[]; flagCounts: { room: string; count: number }[];
  numbers: string; open: Bet[]; closed: Bet[];
};

export async function gatherCompany(from: MorningSources, options: { verdictChars?: number } = {}): Promise<CompanyGather> {
  const yesterday = localDay(from.now - DAY);
  const start = new Date(`${yesterday}T00:00:00`).getTime();
  // The partner holds the whole company, so every card is read as if it were wired to them.
  const cards = (from.stage.cards ?? []).map((card) => card.id);
  const seen: Stage = { ...from.stage, wires: [...from.stage.wires, ...cards.map((id) => ({ id: `morning-${id}`, from: from.partnerId, fromHandle: 'r', to: id, toHandle: 'l' }))] };
  const changed = (await gatherMonth({ workspace: from.workspace, stage: seen, roomId: from.partnerId, decisions: from.decisions, boards: from.boards, leads: from.leads, now: from.now }, yesterday))
    .split('\n').map((line) => line.replace(/^Not wired to you: (.+)\. Say so in the update rather than guessing\.$/, 'Not on the stage: $1.')).join('\n');

  const talk: string[] = [];
  const flagged: string[] = [];
  const flagCounts: { room: string; count: number }[] = [];
  for (const room of from.stage.rooms) {
    const all = await from.chat(room.id).catch(() => [] as ChatMessage[]);
    const said = all.filter((message) => !message.failed && message.at >= start && message.text.trim()).slice(-CHAT_LINES);
    if (said.length) talk.push(`${room.name} (${room.role}):`, ...said.map((message) => `  ${message.role === 'assistant' ? room.name : message.from ?? 'Founder'}: ${stripFlagged(message.text).replace(/\s+/g, ' ').trim().slice(0, CHAT_CHARS)}`));
    // What the truth net flagged since yesterday, each flag on a line of its own: the model reads it, and the net
    // itself still treats the figure it names as unsourced when the note repeats it.
    const lines = all.filter((message) => message.role === 'assistant' && message.at >= start).flatMap((message) => message.text.match(FLAG_LINE) ?? []);
    if (lines.length) { flagged.push(`${room.name} (${room.role}):`, ...[...new Set(lines)].slice(-4)); flagCounts.push({ room: `${room.name} (${room.role})`, count: lines.length }); }
  }
  let chats = talk.join('\n');
  if (chats.length > CHAT_MOST) chats = `${chats.slice(0, CHAT_MOST)}\n  …(more was said)`;

  // What the plan put on today, or left from earlier days: the moves most likely to be due.
  const today = localDay(from.now);
  const planned: string[] = [];
  for (const card of (from.stage.cards ?? []).filter((one) => one.kind === 'board')) {
    for (const task of await from.boards(card.id).catch(() => [] as Task[])) if (task.due && task.due <= today && task.column !== 'done') planned.push(`- ${task.due < today ? `left from ${task.due}: ` : ''}${task.title}`);
  }

  // Every team's verdict and score, as its own document has it: a WEAK beside a plan is the first thing to weigh.
  const verdicts: string[] = [];
  const most = options.verdictChars ?? VERDICT_CHARS;
  for (const doc of from.stage.docs.filter((one) => one.rules)) {
    const rules = doc.rules!;
    const body = sectionBody(from.doc ? await from.doc(doc.id).catch(() => '') : '', rules.verdict.heading);
    const lines = filled(body);
    const state = verdictState(body);
    if (state) { verdicts.push(`- ${doc.title}, ${rules.verdict.heading}: ${state}.`); continue; }
    const { word, score } = verdictOf(body ?? '', rules.outcomes ?? []);
    const read = [word, score !== undefined ? `score ${score}/10` : ''].filter(Boolean).join(', ');
    verdicts.push(`- ${doc.title}, ${rules.verdict.heading}: ${read ? `${read}. ` : ''}${lines.join(' ').replace(/\s+/g, ' ').slice(0, most)}`);
  }

  const bets = (await from.bets().catch(() => [] as Bet[])).filter((bet) => bet.status !== 'proposed');
  return {
    yesterday, changed, chats, planned, verdicts, flagged, flagCounts, numbers: numbersOf(from.company ?? ''),
    open: bets.filter((bet) => bet.status === 'open'), closed: bets.filter((bet) => bet.status === 'closed').slice(-5),
  };
}

export async function gatherMorning(from: MorningSources, since?: string[]): Promise<string> {
  const got = await gatherCompany(from);
  return [
    // Worked out in code: the note leads with these, and a move that answers one says which.
    ...(since ? [`Since yesterday (worked out from the stores; the note shows these above your moves):`, ...(since.length ? since.map((line) => `- ${line}`) : ['- nothing changed'])] : []),
    got.changed,
    `Said since ${got.yesterday}:`, got.chats || '- nothing',
    ...(got.verdicts.length ? ['Team verdicts:', ...got.verdicts] : []),
    ...(got.flagged.length ? [`Flagged by the truth net since ${got.yesterday} (figures nothing backed):`, ...got.flagged] : []),
    `Company Numbers:\n${got.numbers || '- none written'}`,
    // The one runway and break-even: worked with calc here, never a figure a person or the partner said in a room.
    ...(await working(from)).flatMap((lines, index, all) => (index === 0 && all.length ? ['Worked with calc from the Company Numbers (the only runway and break-even to use; a figure said in a room is not one):'] : []).concat(lines)),
    'On the board for today:', ...(got.planned.length ? got.planned.slice(0, 12) : ['- nothing dated today']),
    'Bets:', ...(got.open.length || got.closed.length ? [...got.open, ...got.closed].map(betLine) : ['- none on record']),
    ...(got.closed.length ? ['What we learned (closed bets):', ...learnedSection(got.closed)] : []),
  ].join('\n');
}

// The working, from the one state when the slice gives it (the founder's corrections and readings in it), with where
// the count stands against break-even said in code, never by the model.
const working = async (from: MorningSources): Promise<string[]> => {
  const state = await from.economics?.().catch(() => null);
  const lines = state ? state.explain() : (economicsOf(sectionText(from.company ?? '', 'Numbers'))?.working ?? []).map((one) => one.line);
  const side = breakEvenLine(state);
  return [...lines, ...(side ? [side] : [])].map((line) => `- ${line}`);
};

// Journey 14's note: "the confirmed 4.4-month runway calculated by Ops". Ops had worked out 4.99; 4.4 was the partner's
// own wrong sum, and nothing read confirmed it. "Confirmed" (or verified, validated) stands only beside figures a read
// gives: the Company Numbers, the calc working, the metrics and what changed since yesterday. Else the word goes: "the
// confirmed X" is "the X", and "Ops confirmed X" is "Ops said X".
const CONFIRMED = /\b(the|a|an|our|your|its|their)\s+(?:confirmed|verified|validated)\s+|\b(?:confirmed|verified|validated)\b/gi;
const FIGURES = /\d[\d,]*(?:\.\d+)?/g;
export function confirmedFix(line: string, read: string[]): string {
  if (!/\b(?:confirmed|verified|validated)\b/i.test(line)) return line;
  const held = read.join('\n').replace(/(?<=\d),(?=\d{3}\b)/g, '');
  const figures = (line.replace(/(?<=\d),(?=\d{3}\b)/g, '').match(FIGURES) ?? []).map((one) => one.replace(/[.,]+$/, ''));
  const backed = figures.length > 0 && figures.every((one) => new RegExp(`(?<![\\d.])${one.replace('.', '\\.')}(?![\\d]|\\.\\d)`).test(held));
  if (backed) return line;
  return line.replace(CONFIRMED, (_whole, article?: string) => (article ? `${article} ` : 'said')).replace(/\s{2,}/g, ' ');
}

// Journey 17, day 2: "Risk: Otto's Runway doc listed unsourced figures (€2,556.67)". €2,556.67 was the partner's own,
// from its day-1 reply; Otto never wrote it. A figure said beside a colleague's name is theirs only when it is in what
// that colleague wrote: their replies, their tool results (a calc among them) and the docs their turns wrote. Else a
// figure of the brief says "(from the brief)" and one the one state works out says "(calc)"; a figure nobody of that
// name gave and nothing on record holds takes its sentence out, since it says a colleague did what they did not.
export type Colleague = { name: string; text: string };
const FIGURE_SAID = /(?<![\d.,-])([$€£]\s?)?-?\d[\d,]*(?:\.\d+)?(?![\d-])/g;
const flatNumber = (text: string) => text.replace(/[$€£\s]/g, '').replace(/,/g, '').replace(/^-/, '');
const numbersIn = (text: string) => new Set([...text.replace(/(?<=\d),(?=\d{3}\b)/g, '').matchAll(/\d+(?:\.\d+)?/g)].map((hit) => hit[0]));
export function attributed(line: string, people: Colleague[], own: { brief: string; worked: number[] }): { text: string; left: string[] } {
  const left: string[] = [];
  const briefNumbers = numbersIn(own.brief);
  const sentences = line.split(/(?<=[.!?])\s+/).flatMap((sentence) => {
    const named = people.filter((one) => one.name.trim().length > 1 && new RegExp(`(?<![\\p{L}])${one.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'u').test(sentence));
    if (!named.length) return [sentence];
    const theirs = new Set(named.flatMap((one) => [...numbersIn(one.text)]));
    let out = '';
    let last = 0;
    for (const hit of sentence.matchAll(FIGURE_SAID)) {
      const at = hit.index ?? 0;
      const rest = sentence.slice(at + hit[0].length);
      if (/^\s*(?:\(calc\)|\(from the brief\))/.test(rest) || /^-\d{2}-\d{2}/.test(rest)) continue;
      const bare = flatNumber(hit[0]);
      if (!hit[1] && !bare.includes('.') && Number(bare) >= 1900 && Number(bare) <= 2099) continue;
      if (theirs.has(bare)) continue;
      const decimals = bare.split('.')[1]?.length ?? 0;
      const value = Number(bare);
      const tag = briefNumbers.has(bare) ? ' (from the brief)' : own.worked.some((one) => Math.abs(Math.abs(one) - value) <= 0.5 * 10 ** -decimals + 1e-9) ? ' (calc)' : null;
      if (!tag) { left.push(`${hit[0].trim()}, which ${named.map((one) => one.name).join(' or ')} never gave`); return []; }
      out += sentence.slice(last, at + hit[0].length) + tag;
      last = at + hit[0].length;
    }
    return [out + sentence.slice(last)];
  });
  return { text: sentences.join(' ').trim(), left };
}

// What each colleague wrote, for attributed(): their replies, their tool results and the docs their turns wrote.
async function colleaguesOf(sources: MorningSources): Promise<Colleague[]> {
  const out: Colleague[] = [];
  for (const room of sources.stage.rooms.filter((one) => one.id !== sources.partnerId && !one.partner)) {
    const said = (await sources.chat(room.id).catch(() => [] as ChatMessage[])).filter((message) => message.role === 'assistant' && !message.failed && !message.from);
    const docIds = new Set(said.flatMap((message) => (message.tools ?? []).flatMap((tool) => { const id = (tool.effect as { id?: unknown } | undefined)?.id; return tool.ok !== false && typeof id === 'string' && /^doc-/.test(tool.effect?.kind ?? '') ? [id] : []; })));
    const docs = sources.doc ? await Promise.all([...docIds].map((id) => sources.doc!(id).catch(() => ''))) : [];
    out.push({ name: room.name, text: [...said.flatMap((message) => [message.text, ...(message.tools ?? []).map((tool) => tool.result ?? '')]), ...docs].join('\n').slice(-60_000) });
  }
  return out;
}

// The facts without the truth net's flagged block, which runs from its heading to the Company numbers.
const FLAGGED_BLOCK = /^Flagged by the truth net since [^\n]*\n(?:(?!Company Numbers:)[^\n]*\n)*/m;
const withoutFlagged = (facts: string) => facts.replace(FLAGGED_BLOCK, '');

// One morning turn: the partner's own prompt, the ask and the facts, and the reply held to its shape. Gives back the
// note, or null when the reply lost the shape (nothing is posted then; the next try comes later).
// Why a note that kept its shape still is not one the founder can use, or null when it is.
export function shapeFault(read: Morning, company: string, stage: Stage): string | null {
  if (restates(read.things, company)) return 'The three moves only restate the Company document: give moves the founder can start today.';
  if (!namesAPlace(read.risk, stage)) return 'The risk names no room, document or number: name where the contradiction or risk is.';
  return null;
}
const LOST_SHAPE = 'The reply lost the shape: three numbered moves, then one Risk line and one Question line.';

// `last` is the day's last try, or one the founder asked for: a note that is still at fault after it is asked again
// is posted with a line saying so, rather than leaving the founder with nothing today.
export async function writeMorning(input: {
  sources: MorningSources; name: string; last?: boolean;
  promptFor: (stage: Stage, roomId: string) => Promise<ModelMessage[]>;
  // The reply's words, and which model wrote them when the asker knows.
  ask: (messages: ModelMessage[]) => Promise<string | { text: string; provider?: string; model?: string }>;
}): Promise<MorningNote | null> {
  const { sources } = input;
  const since = await gatherSince(sources);
  const facts = await gatherMorning(sources, since);
  // What the founder ruled out stands against every move here, held in code (journey 15: "no cold outreach" at day 3,
  // and the day-4 note said "Reach out to 10 more makers").
  const nos = await saidNoFor(sources.workspace).list().catch(() => [] as SaidNoEntry[]);
  const against = (move: string) => ruledOutBy(nos, move, sources.now);
  const messages: ModelMessage[] = [...await input.promptFor(sources.stage, sources.partnerId), { role: 'user', content: `${MORNING_ASK}\n\n${facts}` }];
  const once = async (these: ModelMessage[]) => {
    const answered = await input.ask(these);
    const said = typeof answered === 'string' ? { text: answered } as { text: string; provider?: string; model?: string } : answered;
    const read = readMorning(said.text);
    const ruled = read?.things.map(against).find(Boolean);
    return { ...said, read, fault: read ? shapeFault(read, sources.company ?? '', sources.stage) : LOST_SHAPE, ruled };
  };
  let reply = await once(messages);
  // At fault: asked once more in the same try, with the reason in front of it, not the same prompt half an hour on.
  // A move against the founder's no is asked again the same way; still there after, it is dropped below.
  const again = reply.fault ?? (reply.ruled ? `${ruledOutLine(reply.ruled)}, and a move proposes it: give a move that does not.` : null);
  if (again) reply = await once([...messages, { role: 'assistant', content: reply.text }, { role: 'user', content: `${again} Write the note again, in exactly the same shape.` }]);
  const { provider, model, fault } = reply;
  if (!reply.read || (fault && !input.last)) return null;
  // Runway is never rounded toward the better side, in the note either.
  const numbers = `${sectionText(sources.company ?? '', 'Numbers')}`;
  // Runway and break-even as the calc working gives them, never as a room said them; "confirmed" only beside a read.
  const state = await sources.economics?.().catch(() => null) ?? null;
  const economics = state ? state.economics() : economicsOf(numbers);
  const reads = [numbers, ...(economics?.working ?? []).map((one) => one.result), ...since];
  // "Further below break-even" at 9.5 paying with break-even 8 (journey 16): the side is the numbers', not the model's.
  const fix = (line: string) => breakEvenFix(confirmedFix(runwayFix(figuresFix(line, economics), numbers), reads), state);
  // A move still set against a no after the second ask is dropped, and the note says which no it kept to.
  const dropped = [...new Set(reply.read.things.map(against).filter((one): one is SaidNoEntry => !!one))];
  const things = reply.read.things.filter((thing) => !against(thing));
  // Nobody asked for the note, so a line that promises, counts or quotes what the facts and the brief do not say is
  // taken out, and the note says what was left out (server/partner/unasked.ts).
  // A move is a plan and the risk is the partner's view: neither is taken out (guardMove, guardView); a figure said
  // as a colleague's that the colleague never gave is (attributed).
  const record = [withoutFlagged(facts), sources.company ?? ''];
  const left: string[] = [];
  const people = await colleaguesOf(sources).catch(() => [] as Colleague[]);
  const own = { brief: numbers, worked: [...(economics?.working ?? []).flatMap((one) => [...one.result.replace(/(?<=\d),(?=\d{3}\b)/g, '').matchAll(/-?\d+(?:\.\d+)?/g)].map((hit) => Number(hit[0]))), ...(state ? state.explain().flatMap((one) => [...one.replace(/(?<=\d),(?=\d{3}\b)/g, '').matchAll(/=\s*(-?\d+(?:\.\d+)?)/g)].map((hit) => Number(hit[1]))) : [])] };
  const owned = (line: string) => { const held = attributed(line, people, own); left.push(...held.left); return held.text; };
  const kept = things.map(fix).map((thing) => guardMove(owned(thing), record, numbers)).filter((thing) => thing.trim());
  const risk = guardView(owned(fix(reply.read.risk)), record);
  const question = owned(fix(reply.read.question));
  const held = guardUnasked(question, record);
  left.push(...held.left);
  const read: Morning = { things: kept, risk, question: held.text };
  // The truth net, as every turn has it: a figure in the note that nothing it was given holds is flagged under it,
  // and the note is posted all the same, so the founder sees both.
  // Checked as posted: the reshaped note, not the raw reply, so the flags name only what the founder reads.
  // Read like a turn's reply: the partner's own brief, stance and rules are not facts, only the documents, the facts
  // below and what was said.
  // The flagged block is left out: its figures are the ones nothing backed, and stripping them from the one message
  // that holds every fact would take the founder's own words about the same figures with them.
  const checked = messages.map((message, index) => (index === messages.length - 1 ? { ...message, content: `${MORNING_ASK}\n\n${withoutFlagged(facts)}` } : message));
  const flags = checkReply({ reply: morningText(read), receipts: [], sources: turnSources(checked) });
  if (fault) flags.push(`Note check: ${fault.split(':')[0].replace(/^The /, 'the ')}, even when asked again.`);
  for (const one of dropped) flags.push(`${ruledOutLine(one)}, so a move that proposed it was dropped.`);
  if (left.length) flags.push(leftOutLine([...new Set(left)]));
  return { ...read, since, day: localDay(sources.now), at: sources.now, roomId: sources.partnerId, who: input.name, ...(flags.length ? { flags } : {}), ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
}

// How the note reads in the partner's own conversation.
// What changed since yesterday comes first, then the day's moves; a note written before that was kept has no head.
export const morningMessage = (note: MorningNote) => [`**Morning, ${weekDay(note.at)}**`, ...(note.since ? [sinceText(note.since)] : []), morningText(note), ...(note.flags ?? [])].join('\n\n');

// The fake model's morning, for a run with no model at all: the same shape, said plainly.
export const FAKE_MORNING = 'Three moves for today:\n1. Fill the empty sections of the Company document, so every answer rests on it.\n2. Decide what waits in Needs you, so nobody works on a guess.\n3. Check the bets that are due against their numbers.\nRisk: the Company document is thin, so every choice rests on guesses.\nQuestion: What is the one number this week should move?';
