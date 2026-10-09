import type { Receipt } from './truth.ts';

// An email the turn did not draft is not drafted. Journey 15: draft_email was refused (the founder had said no) and the
// colleague still wrote "Drafted the reply to Mira explaining pickup options"; the partner, after the same refusal,
// pasted a draft into chat and said "Send the draft directly in Gmail" with no draft to open. The claim net let both
// through ("drafted" is no verb it knows, and "in Gmail" claims nothing). Here, in code: a refused draft says so at
// the head of its result, a reply claiming a draft the turn did not make says the refusal instead, and words that send
// the founder to Gmail stand only beside a draft they can open from this same message.
//
// Journey 16: the same for every tool that makes or sends something. After a refused propose_decision the partner said
// "I have proposed the decision ... and it now waits in your list"; nothing was in the list. A refused or failed
// propose_*, create_*, send_* or draft_* call cannot be reported as done: the claim becomes the refusal.

const MAIL = /^(?:draft_email|send_email)$/;
// The tools whose work is a thing made or sent, and the word for it done.
const MAKES = /^(propose|create|send|draft)_(\w+)$/;
const DONE_WORD: Record<string, string> = { propose: 'proposed', create: 'created', send: 'sent', draft: 'drafted' };
const madeOf = (tool: string) => {
  const hit = MAKES.exec(tool);
  return hit ? { done: DONE_WORD[hit[1]], what: hit[2].replace(/_/g, ' ') } : null;
};
// What a refused draft's result starts with, so the person reading it cannot take it for a draft; the same for any
// tool that makes or sends something.
export const notDone = (tool: string, refusal: string) => {
  const made = madeOf(tool);
  return made && !/^NOT \w+:/.test(refusal) ? `NOT ${made.done}: ${refusal}` : refusal;
};
export const NO_DRAFT = '(no draft was made)';

// "Drafted the reply", "I've drafted it", "the email is ready", "I have written the reply", "I sent it".
const CLAIMS = /\bdrafted\b|\b(?:I|we)(?:'ve| have)?\s+(?:just\s+|now\s+|already\s+)?(?:written|wrote|prepared|sent)\s+(?:the|an|a|your|her|his|their|it)\b|\b(?:draft|email|e-mail|reply|message)\s+(?:is|was)\s+(?:now\s+)?(?:ready|done|prepared|sent|written)\b/i;
const DENIED = /\b(?:not|n't|no|never|nothing|refused|declined|could not|cannot)\b/i;
// Words that send the founder to Gmail to open or send something: "Open in Gmail", "send it directly in Gmail".
const TO_GMAIL = /\b(?:open|send|review|find|check)(?:\s+(?:it|this|that|the\s+(?:draft|email|reply|message)|them))?(?:\s+(?:directly|now|yourself|from\s+there))?\s+(?:in|from|via)\s+(?:your\s+)?Gmail\b/gi;

// "I have proposed the decision", "it now waits in your list", "the task is on your board", "I created the doc".
const MADE_CLAIMS = /\b(?:I|we)(?:'ve| have)?\s+(?:just\s+|now\s+|already\s+)?(?:proposed|created|added|put|raised|logged|recorded|queued|made|set up|sent|posted|scheduled|submitted|filed|put forward|lodged|tabled)\b|\b(?:it|this|that|they|the\s+[\w-]+(?:\s+[\w-]+)?)\s+(?:now\s+)?(?:waits?|is waiting|are waiting|sits?|is now|are now|is|are)\s+(?:now\s+)?(?:waiting\s+)?(?:in|on)\s+(?:your|the)\s+(?:list|needs you|board|decisions?|queue|stage|today)\b|\b(?:has|have) been\s+(?:proposed|created|added|raised|queued|logged|sent|posted)\b|\bis\s+(?:now\s+)?(?:proposed|created|queued|logged|posted)\b/i;
const WAITS = /\b(?:waits?|waiting|sits?)\b[^.!?]*\b(?:list|needs you|board|queue)\b/i;
const refusalWords = (result: string) => {
  const said = result.replace(/^NOT \w+:\s*/, '').replace(/^Already declined:\s*/i, '').split(/(?<=[.!?])\s/)[0].trim().replace(/[.!?]$/, '');
  return said.replace(/\bthe founder\b/gi, 'you').replace(/\btheir\b/g, 'your').replace(/\bthem\b/g, 'you');
};

export function holdDraftClaims(reply: string, receipts: Receipt[]): string {
  const drafted = receipts.some((one) => one.name === 'draft_email' && one.ok);
  const sent = receipts.some((one) => one.name === 'send_email' && one.ok);
  let text = reply;
  const refused = receipts.find((one) => MAIL.test(one.name) && one.ok === false);
  if (refused && !drafted && !sent) {
    const line = `The email was not ${refused.name === 'send_email' ? 'sent' : 'drafted'}: ${refusalWords(refused.result ?? 'it was refused')}.`;
    let said = false;
    // Sentence by sentence, keeping what ends each one: the first claim becomes the refusal, any later one goes.
    text = text.replace(/[^.!?\n]+[.!?]*/g, (sentence) => {
      if (!CLAIMS.test(sentence) || DENIED.test(sentence)) return sentence;
      const lead = /^\s*/.exec(sentence)![0];
      if (said) return '';
      said = true;
      return `${lead}${line}`;
    }).replace(/[ \t]{2,}/g, ' ');
  }
  if (!drafted) text = text.replace(TO_GMAIL, NO_DRAFT);
  return holdMadeClaims(text, receipts);
}

// Any other tool that makes or sends something and was refused or failed, with nothing of the same name done: a
// sentence that claims it is done says the refusal instead (once per tool), and a sentence after it that only says
// where the thing now waits goes.
function holdMadeClaims(reply: string, receipts: Receipt[]): string {
  const failed = receipts.filter((one) => one.ok === false && !MAIL.test(one.name) && madeOf(one.name)
    && !receipts.some((other) => other.name === one.name && other.ok));
  if (!failed.length) return holdDenials(reply, receipts);
  const said = new Set<string>();
  // Journey 18: "I have submitted the proposal. The decision was not proposed: you said no to this." A reply that
  // already says the refusal has it said: a claim beside it goes, never a second refusal line.
  for (const tool of failed) {
    const made = madeOf(tool.name)!;
    const noun = new RegExp(`\\b${made.what.split(' ').at(-1)}s?\\b`, 'i');
    const act = new RegExp(`\\b${made.done.slice(0, 5)}`, 'i');
    if (reply.split(/(?<=[.!?])\s+|\n/).some((sentence) => DENIED.test(sentence) && noun.test(sentence) && act.test(sentence))) said.add(tool.name);
  }
  let last = '';
  return reply.replace(/[^.!?\n]+[.!?]*/g, (sentence) => {
    if (!MADE_CLAIMS.test(sentence) || DENIED.test(sentence)) { last = ''; return sentence; }
    const tool = failed.find((one) => { const made = madeOf(one.name)!; return new RegExp(`\\b${made.what.split(' ').at(-1)}s?\\b|\\b${made.done}\\b|\\b${made.done.slice(0, 5)}\\w*`, 'i').test(sentence); })
      ?? (last ? failed.find((one) => one.name === last) : undefined)
      ?? (failed.length === 1 && WAITS.test(sentence) ? failed[0] : undefined);
    if (!tool) { last = ''; return sentence; }
    last = tool.name;
    const lead = /^\s*/.exec(sentence)![0];
    if (said.has(tool.name)) return '';
    said.add(tool.name);
    const made = madeOf(tool.name)!;
    return `${lead}The ${made.what} was not ${made.done}: ${refusalWords(tool.result ?? 'it was refused')}.`;
  }).replace(/[ \t]{2,}/g, ' ');
}

// The other way round: a tool that worked, and a reply that says it did not ("The decision was not proposed") while
// nothing of that name failed. The receipt is the truth: the denial says what was done instead.
function holdDenials(reply: string, receipts: Receipt[]): string {
  const worked = receipts.filter((one) => one.ok && madeOf(one.name) && !receipts.some((other) => other.name === one.name && other.ok === false));
  if (!worked.length) return reply;
  const said = new Set<string>();
  return reply.replace(/[^.!?\n]+[.!?]*/g, (sentence) => {
    const tool = worked.find((one) => {
      const made = madeOf(one.name)!;
      return new RegExp(`\\b(?:the|your|my|this|that)\\s+${made.what.split(' ').at(-1)}\\s+(?:was|were|is|has)\\s+not\\s+(?:been\\s+)?${made.done}\\b`, 'i').test(sentence);
    });
    if (!tool) return sentence;
    const lead = /^\s*/.exec(sentence)![0];
    if (said.has(tool.name)) return '';
    said.add(tool.name);
    const made = madeOf(tool.name)!;
    return `${lead}The ${made.what} was ${made.done}.`;
  }).replace(/[ \t]{2,}/g, ' ');
}

// Journey 16: "I updated the Company document with the corrected paying subscriber count of 11", with no write this
// turn. A claim to have written a document stands only beside a write that worked this turn (write_doc,
// replace_section, append_doc, create_doc) or one the app made for the turn (`wrote`): else the first such sentence says
// nothing was written, and any later one goes.
const DOC_WRITES = /^(?:write_doc|replace_section|append_doc|create_doc|edit_doc)$/;
const FIRST_PERSON_WRITE = /^\s*(?:[-*]\s+)?(?:(?:I|we)(?:'ve| have)?\s+(?:just\s+|now\s+|also\s+|already\s+)?|(?:I|we)\s+)?(?:updated|wrote|written|added|changed|edited|corrected|recorded|saved|put|amended)\b/i;
const DOC_WORDS = /\b(?:document|doc|brief|numbers section|section)\b/i;
export function holdDocClaims(reply: string, receipts: Receipt[], given: { title: string; wrote?: boolean }): string {
  if (given.wrote || receipts.some((one) => DOC_WRITES.test(one.name) && one.ok !== false)) return reply;
  let said = false;
  return reply.replace(/[^.!?\n]+[.!?]*/g, (sentence) => {
    if (!FIRST_PERSON_WRITE.test(sentence) || !DOC_WORDS.test(sentence) || DENIED.test(sentence)) return sentence;
    const lead = /^\s*/.exec(sentence)![0];
    if (said) return '';
    said = true;
    return `${lead}Nothing was written to the ${given.title} this turn.`;
  }).replace(/[ \t]{2,}/g, ' ');
}

// Journey 17: a colleague's reply opened with "![chart](/api/files/chart.png)"; no chart was made and the picture
// 404'd. A link into the shared files stands only when a tool that worked this turn named the file, or the file is
// there; else the link goes and the words say no file was made.
export const NO_FILE = '(no file was made)';
const FILE_LINK = /(!?)\[([^\]\n]*)\]\(\/api\/files\/([^\s)]+)\)/g;
export async function holdFileLinks(reply: string, receipts: Receipt[], exists: (path: string) => Promise<boolean>): Promise<string> {
  const links = [...reply.matchAll(FILE_LINK)];
  if (!links.length) return reply;
  const made = receipts.filter((one) => one.ok !== false).map((one) => one.result ?? '').join('\n');
  const real = new Map<string, boolean>();
  for (const [, , , link] of links) {
    if (real.has(link)) continue;
    let path = link;
    try { path = decodeURIComponent(link); } catch { /* kept as written */ }
    real.set(link, made.includes(path) || made.includes(link) || await exists(path).catch(() => false));
  }
  return reply.replace(FILE_LINK, (whole, bang: string, label: string, link: string) => {
    if (real.get(link)) return whole;
    const said = label.trim();
    return bang || !said ? NO_FILE : `${said} ${NO_FILE}`;
  }).replace(/[ \t]{2,}/g, ' ');
}
