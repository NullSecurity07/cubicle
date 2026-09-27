// The partner, as both sides see it: the one Company document that is the shared record, the bets on record, the
// morning note and a plan's steps read as tasks. Everything here is plain and pure, so the window and the server say
// the same words and a test can hold them to it.

// ---------------------------------------------------------------- the Company document

export const COMPANY_TITLE = 'Company';
export const COMPANY_SECTIONS = ['Idea', 'Customer', 'Numbers', 'Decisions', 'Bets', 'Open questions'] as const;
// What the partner slice says to the window: the app wrote into the Company document.
export const PARTNER_CHANNEL = 'partner';
export type PartnerEvent = { docChanged: string };
// The one line every person's prompt carries while the document is on the stage.
// It names the document by its title as it is now, so a renamed one is still called what the founder called it.
export const SHARED_RECORD = 'document is the shared record';
export const companyLine = (title = COMPANY_TITLE) => `The "${title.trim() || COMPANY_TITLE}" ${SHARED_RECORD}; when the chat and it disagree, say so.`;
export const COMPANY_LINE = companyLine();
// The seeded stage already pins "Company brief": that is the company's document, adopted rather than doubled.
export const isCompanyTitle = (title: string) => /^company( brief)?$/.test(title.trim().toLowerCase());
// The one company document on a stage: the one recorded by id while it is there, else the first pinned one that is
// called so. Never a second one.
export function findCompanyDoc<D extends { id: string; title: string; pinned?: boolean }>(docs: D[], id?: string): D | undefined {
  if (id) return docs.find((doc) => doc.id === id);
  return docs.find((doc) => doc.pinned && isCompanyTitle(doc.title));
}

export const companyTemplate = () => `# ${COMPANY_TITLE}\n\nThe shared record of the company. Every person reads it; your partner keeps it true.\n\n`
  + COMPANY_SECTIONS.map((name) => `## ${name}`).join('\n\n') + '\n';

// ---------------------------------------------------------------- the partner

export const PARTNER_ROLE = 'Partner';
export const PARTNER_NAME = 'Partner';
export const PARTNER_BRIEF = 'You are the founder\'s partner. You hold the whole company in one picture: what it is, who it is for, '
  + 'the numbers, what was decided and what is being bet on. The Company document is yours to keep true.';

// ---------------------------------------------------------------- bets

// A bet is something the company did or will do, with what it should move and by when. `metric` names what is read
// in code on the check day: a number on a Metrics card (its key or name), "leads" or "leads:<stage>", or "survey".
export type BetVerdict = 'worked' | 'did-not';
export type BetResult = { at: number; verdict: BetVerdict; value: number | null; note: string; by: string };
export type Bet = {
  id: string; made: string; what: string; hypothesis: string; metric: string; target: number; checkDate: string;
  status: 'proposed' | 'open' | 'closed'; at: number; proposedBy?: string; roomId?: string; result?: BetResult;
};
// A bet's words as they go between full stops: whatever stop the writer ended on is dropped, so a line never reads "product..".
export const bare = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
export const VERDICT_WORDS: Record<BetVerdict, string> = { worked: 'worked', 'did-not': 'did not work' };

// ---------------------------------------------------------------- the morning note

export type Morning = { things: string[]; risk: string; question: string };
// `inputs` is what the note was read from, as a key: asked again with nothing changed, the same note stands.
// `flags` are the truth net's lines on it: a figure nothing the note was given holds.
export type MorningNote = Morning & { day: string; at: number; roomId: string; who: string; inputs?: string; flags?: string[] };

const plain = (text: string) => text.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
// A numbered or bulleted line, the number or bullet bold or not: "1. a", "**1.** a", "- a".
const LIST = /^\s*(?:\*\*|__)?(?:\d+[.)]|[-*+•])(?:\*\*|__)?\s+(.*)$/;
// A risk or question label, however it is dressed: "Risk:", "- Risk:", "**Biggest risk:**", "## One question",
// "Question for you:". A label that says nothing after it must stand alone; one with words after it needs its colon
// or dash, so a thing like "- Risk of churn rises" is not read as a label.
const HEAD = /^\s*(?:[-*+•]\s+)?(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:[a-z]+\s+){0,2}?(risk|question)s?(?:\s+for\s+(?:you|the founder))?\s*(?:\*\*|__)?\s*(?:([:\-–—])\s*(?:\*\*|__)?\s*(.*))?$/i;
const MY_CALL = /^\s*(?:[-*+•]\s+)?(?:\*\*|__)?\s*my call\b/i;

// Two or three things, one risk and one question out of whatever the model wrote, or null when the shape is not
// there: a reply that has lost the shape is not posted, because the founder reads it first thing and trusts its form.
// A "My call:" line (the partner ends every substantive reply with one) is not part of the note and is left out.
export function readMorning(reply: string): Morning | null {
  const lines = reply.split('\n');
  const things: string[] = [];
  const found: Record<'risk' | 'question', string[]> = { risk: [], question: [] };
  let into: 'things' | 'risk' | 'question' = 'things';
  for (const line of lines) {
    if (MY_CALL.test(line)) continue;
    const head = HEAD.exec(line);
    if (head && (head[2] || !head[3]?.trim())) { into = head[1].toLowerCase() as 'risk' | 'question'; if (head[3]?.trim()) found[into].push(head[3]); continue; }
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (into === 'things') { const item = LIST.exec(line); if (item && things.length < 3) things.push(plain(item[1])); continue; }
    found[into].push(line.replace(LIST, '$1'));
  }
  const risk = plain(found.risk.join(' '));
  const question = plain(found.question.join(' '));
  if (things.length < 2 || !risk || !question) return null;
  return { things, risk, question };
}

export const morningText = (note: Morning) => ['Three moves for today:', ...note.things.map((thing, index) => `${index + 1}. ${thing}`), '', `Risk: ${note.risk}`, '', `Question: ${note.question}`].join('\n');

// ---------------------------------------------------------------- a plan read as steps

export type PlanStep = { day?: string; text: string };
export type PlanProposal = { id: string; at: number; who: string; roomId: string; title: string; steps: PlanStep[]; docId?: string };
export const MOST_STEPS = 40;

const WEEKDAY = '(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?';
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
// What makes a heading or a label a day of the plan: "Day 3", "Week 2", a weekday, "28 Sep", "Sep 28", or 2026-09-28.
const DAYISH = new RegExp(`\\b(?:day|week|phase)\\s*\\d+\\b|\\b${WEEKDAY}\\b|\\b\\d{1,2}\\s+${MONTH}\\b|\\b${MONTH}\\s+\\d{1,2}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`, 'i');
// One day as a plan writes it: "Day 3", "Week 2", "Mon", "Mon 28 Sep", "28 Sep", "Sep 28", 2026-09-28, each with an
// optional "(28–29 Sep)" after it. A label is one day or a range of two ("Mon–Tue (28–29 Sep)", "Mon 28 Sep – Tue 29 Sep").
const ONE_DAY = `(?:(?:day|week|phase)\\s*\\d+|${WEEKDAY}(?:\\s+\\d{1,2}(?:\\s+${MONTH})?)?|\\d{1,2}\\s+${MONTH}|${MONTH}\\s+\\d{1,2}|\\d{4}-\\d{2}-\\d{2})(?:\\s*\\([^)]{1,40}\\))?`;
const LABEL = `${ONE_DAY}(?:\\s*(?:[–—-]|to)\\s*${ONE_DAY})?`;
// A day written at the front of a line, then a colon, or a dash with space after it: "Day 1: …", "Day 2 – …",
// "**Mon–Tue (28–29 Sep):** …", "Mon 28 Sep – Tue 29 Sep: …".
const LEADING = new RegExp(`^\\**\\s*(${LABEL})\\s*\\**\\s*(?::|[–—-](?=\\s))\\s*\\**\\s*(.+)$`, 'i');
const HEADING = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/;
const BOLD_LINE = /^\s*\*\*(.+?)\*\*:?\s*$/;
const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/;

const cleanStep = (text: string) => plain(text).replace(/[:.;]$/, '').slice(0, 160).trim();
const cleanDay = (text: string) => plain(text).replace(/[:\-–—]\s*$/, '').trim();

// The steps of a plan, each with the day it sits under. Bullets under a heading that names no day (KPIs, kill
// criteria, a goal) are not steps; a nested bullet belongs to the step above it and is left out; a table counts when
// its first column is a day. At most MOST_STEPS, in the order written.
export function parsePlan(text: string): PlanStep[] {
  const steps: PlanStep[] = [];
  let day: string | null = null;
  let bulletDay: string | null = null;
  // Models write narrow and no-break spaces between a weekday and its date: they are spaces.
  for (const line of text.replace(/[\u00a0\u2007\u202f]/g, ' ').split('\n')) {
    if (steps.length >= MOST_STEPS) break;
    const heading = HEADING.exec(line) ?? BOLD_LINE.exec(line);
    if (heading) { day = DAYISH.test(heading[1]) ? cleanDay(heading[1]) : null; bulletDay = null; continue; }
    const cells = /^\s*\|(.+)\|\s*$/.exec(line)?.[1].split('|').map((cell) => cell.trim());
    if (cells) {
      if (cells.length >= 2 && DAYISH.test(cells[0]) && !/^:?-+:?$/.test(cells[1])) {
        const rest = cells.slice(1).filter(Boolean).map(cleanStep).join(' — ');
        if (rest) steps.push({ day: cleanDay(cells[0]), text: rest });
      }
      continue;
    }
    const bullet = BULLET.exec(line);
    const body = bullet ? bullet[2] : line.trim();
    // A nested bullet belongs to the step above it, unless that bullet was only a day ("- **Day 1**").
    if (bullet && bullet[1].length >= 2) { const step = bulletDay ? cleanStep(body) : ''; if (step) steps.push({ day: bulletDay!, text: step }); continue; }
    bulletDay = null;
    const label = bullet ? BOLD_LINE.exec(body) : null;
    if (label && DAYISH.test(label[1])) { bulletDay = cleanDay(label[1]); continue; }
    const leading = LEADING.exec(body);
    if (leading) { const step = cleanStep(leading[2]); if (step) steps.push({ day: cleanDay(leading[1]), text: step }); continue; }
    if (bullet && day) { const step = cleanStep(body); if (step) steps.push({ day, text: step }); }
  }
  return steps;
}

// The step without its own day at the front: a step that already starts with its day is not given it twice.
export const stepText = (step: PlanStep) => (step.day && step.text.toLowerCase().startsWith(step.day.toLowerCase()) ? step.text.slice(step.day.length).replace(/^\s*[:\-–—]\s*/, '') : step.text);
// The day once, then the step, as the founder is asked about it and as a plan's steps are told apart.
export const planStepLine = (step: PlanStep) => { const text = stepText(step); return (step.day ? `${step.day}: ${text}` : text).slice(0, 160); };
export const TITLE_MOST = 80;
// A task's title on the board. A label that names a calendar day goes, since the card shows its due date; one that
// names none ("Day 3", "Mon") stays, since nothing else says it. A long step is cut at a word, never mid-word.
export const planTaskTitle = (step: PlanStep) => {
  const text = stepText(step);
  const whole = step.day && !dueOf(step.day, '2026-01-01') ? `${step.day}: ${text}` : text;
  return cutAtWord(whole, TITLE_MOST);
};
export const cutAtWord = (text: string, most: number) => {
  if (text.length <= most) return text;
  // Up to the last space that leaves room for the ellipsis; one long word is cut where it has to be.
  const space = text.slice(0, most).lastIndexOf(' ');
  return `${(space > most / 2 ? text.slice(0, space) : text.slice(0, most - 1)).replace(/[\s,;:.\-–—]+$/, '')}\u2026`;
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (value: number) => String(value).padStart(2, '0');
// The first calendar day a label names, as YYYY-MM-DD, or undefined when it names none ("Day 3", "Mon"). The year is
// the one that puts the day nearest `today`, so a plan written in late December for "4 Jan" lands in the new year.
export function dueOf(label: string, today: string): string | undefined {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(label);
  if (iso) return iso[0];
  const dayMonth = /\b(\d{1,2})(?:\s*[–—-]\s*\d{1,2})?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.exec(label);
  const monthDay = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/i.exec(label);
  // Whichever form comes first names the day: "Sep 28 – 2 Oct" is Sep 28, "28–29 Sep" the 28th.
  const useMonthDay = !!monthDay && (!dayMonth || monthDay.index < dayMonth.index);
  const [day, month] = useMonthDay ? [Number(monthDay![2]), MONTHS.indexOf(monthDay![1].toLowerCase())] : dayMonth ? [Number(dayMonth[1]), MONTHS.indexOf(dayMonth[2].toLowerCase())] : [0, -1];
  if (month < 0 || day < 1 || day > 31) return undefined;
  const now = new Date(`${today}T12:00:00`);
  const options = [-1, 0, 1].map((shift) => new Date(now.getFullYear() + shift, month, day, 12));
  const best = options.filter((one) => one.getDate() === day).sort((a, b) => Math.abs(a.getTime() - now.getTime()) - Math.abs(b.getTime() - now.getTime()))[0];
  return best ? `${best.getFullYear()}-${pad(best.getMonth() + 1)}-${pad(best.getDate())}` : undefined;
}
// A doc is a plan when its title or its first heading says so.
export const isPlanDoc = (title: string, text: string) => /\bplan(?:s|ning)?\b/i.test(title) || /\bplan(?:s|ning)?\b/i.test(HEADING.exec(text.split('\n').find((line) => HEADING.test(line)) ?? '')?.[1] ?? '');
