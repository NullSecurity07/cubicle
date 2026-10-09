// Journey 21: "Draft first message" on Ines left Lea's message in chat, signed "[Founder]", with no email draft and no
// Gmail link until the founder asked for one. A first message drafted for a lead with an address on record is an
// email draft at once: when the turn the founder's ask set off wrote the email in words and never called draft_email,
// the turn calls it with what was written, through the same checks as any draft, so the chip and the Open in Gmail
// button are there when the reply is.

// What `draftAsk` (shared/leads.ts) puts into the person's room, with the lead's address when they have one.
const ASK = /^Draft a first message to (.+?) at (.+?) using the evidence-outreach skill\./;
const ADDRESS = /\bTheir address: ([^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,})\b/i;
const GREETING = /^\s*(?:\*\*)?(?:hi|hello|dear|hey|good (?:morning|afternoon|evening))\b/i;
const CLOSING = /^\s*(?:best|kind regards|warm regards|best regards|regards|thanks|thank you|cheers|sincerely|all the best|many thanks)\b[\p{L}\s]*[,.!]?\s*$/iu;
const SUBJECT = /^\s*(?:\*\*)?subject(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+?)\s*(?:\*\*)?\s*$/im;

export type Owed = { to: string; subject: string; body: string };

// The email a reply wrote out, from its greeting to its sign-off and the name lines under it, or null.
export function emailIn(text: string): { subject: string | null; body: string } | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => GREETING.test(line));
  if (start < 0) return null;
  const close = lines.findLastIndex((line, index) => index > start && CLOSING.test(line.replace(/[*_]/g, '')));
  if (close < 0) return null;
  let end = close + 1;
  // Up to two short lines of names under the sign-off: "Sam", "FixSlot", "[Founder]".
  while (end < lines.length && end - close <= 2 && lines[end].trim() && lines[end].trim().split(/\s+/).length <= 4 && !/[.?!:]$/.test(lines[end].trim())) end += 1;
  const body = lines.slice(start, end).map((line) => line.replace(/^\s*>\s?/, '').replace(/\*\*/g, '')).join('\n').trim();
  if (body.split('\n').filter((line) => line.trim()).length < 3) return null;
  return { subject: SUBJECT.exec(lines.slice(0, start).join('\n'))?.[1] ?? null, body };
}

// The draft a first-message turn owes, or null when it owes none: not that ask, no address on record, a draft_email
// already worked, or no email written out.
export function owedFirstDraft(query: string, reply: string, done: { name: string; ok?: boolean }[]): Owed | null {
  const ask = ASK.exec(query);
  const to = ADDRESS.exec(query)?.[1];
  if (!ask || !to || done.some((event) => event.name === 'draft_email' && event.ok)) return null;
  const email = emailIn(reply);
  if (!email) return null;
  return { to, subject: email.subject ?? `For ${ask[2].trim()}`, body: email.body };
}

// A name placeholder never reaches the founder: "[Founder]", "[Your Name]" on a line of their own go, and inside a
// line they go too. Journey 21's first message in chat was signed "[Founder]".
const NAME_SLOT = /\[(?:(?:your|the|founder'?s?|my|sender'?s?)\s+)?(?:full\s+)?(?:name|founder)\]/gi;
const HAS_SLOT = new RegExp(NAME_SLOT.source, 'i');
export function withoutPlaceholders(text: string): string {
  if (!HAS_SLOT.test(text)) return text;
  return text.split('\n').filter((line) => line.replace(NAME_SLOT, '').trim() || !HAS_SLOT.test(line))
    .map((line) => line.replace(NAME_SLOT, '').replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trimEnd()).join('\n');
}
