// The founder's leads: the people they might sell to, where each one stands, and what is known about them. The shape
// is Twenty's (a person, their company, notes and a stage) without Twenty: one file per card, no service to run.
export const LEAD_STAGES = ['new', 'fit', 'contacted', 'replied', 'meeting', 'customer', 'passed'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
export const STAGE_NAMES: Record<LeadStage, string> = { new: 'New', fit: 'Fit', contacted: 'Contacted', replied: 'Replied', meeting: 'Meeting', customer: 'Customer', passed: 'Passed' };

export type LeadNote = { at: number; by: string; text: string };
// `fit` is a score out of ten with the reason for it, written by a person with the icp-fit skill.
export type Lead = {
  id: string;
  person: { name: string; title?: string; linkedin?: string; email?: string };
  company: { name: string; site?: string; size?: string };
  stage: LeadStage; fit?: { score: number; why: string; at: number }; notes: LeadNote[];
  source: 'founder' | 'person' | 'openoutreach' | 'twenty'; addedAt: number; updatedAt: number;
  // Where this lead lives in the founder's Twenty, when they connected one. Only the mirror reads it; the card never
  // shows it. `noteIds` maps a note's key here (see `noteKey`) to that note in Twenty, so each note goes over once.
  // `remoteAt` is the person's updatedAt as Twenty last said it, so the mirror knows its own writes when it reads back.
  twenty?: { personId: string; companyId?: string; noteIds: Record<string, string>; syncedAt: number; remoteAt?: string };
  // What happened between the founder and this person, oldest first: see `leads-thread.ts`, which owns the moves.
  thread?: ThreadEvent[];
};

// One thing in a lead's thread. `drafted`: a person drafted an email to them (`draft` is its Needs you id). `sent`: an
// email the founder said yes to went out from `room`'s mailbox (`via` agentmail) or the founder's Gmail. `opened`: the
// founder opened a drafted email in Gmail. `replied`: they wrote back (`text`, and `mail`, the message id, when the
// inbox poll found it). `meeting`: one is set for `day` (YYYY-MM-DD), `taskId` on `boardId` holds it. `notes`: what the
// founder wrote after it, with the `reading` it proposes for the Metrics card and the founder's answer to it.
// `closed`: the founder waved away the ask named by `of`.
export type ThreadKind = 'drafted' | 'sent' | 'opened' | 'replied' | 'meeting' | 'notes' | 'closed';
// `working`: how the paying people were counted from the notes, when more than one ("Anna + two colleagues = 3").
// `unit`: what the paying count counts, as the Metrics card names it ("paying cafés"); `people`: when that is a place
// and not a person, how many people the notes say paid there (journey 20: "the owner and two volunteers paid").
export type ThreadReading = { conversations: number; paying: number; working?: string; unit?: string; people?: number; answer?: 'logged' | 'declined' };
export type ThreadEvent = {
  at: number; kind: ThreadKind; text?: string; subject?: string; draft?: string; room?: string; via?: 'agentmail' | 'gmail';
  // `time`: a meeting's start, "HH:MM" where the founder is, when they gave one.
  mail?: string; day?: string; time?: string; boardId?: string; taskId?: string; reading?: ThreadReading; of?: 'replied' | 'notes';
};
// A note's key for the mirror: notes are only ever added, so where it sits and when it was written never change.
export const noteKey = (note: LeadNote, index: number) => `${index}:${note.at}`;

// What the card says under its name when the founder connected Twenty. `problem` is set only while it is failing.
export type TwentyStatus = { connected: boolean; url: string; lastSync: number | null; pushed: number; pulled: number; problem?: string; since?: number };
export const TWENTY_CHANNEL = 'twenty';
// What a leads card hears on the one live feed: the whole list after every change. `rev` only ever grows, so a card
// that reads its list while news is on the way keeps whichever is newer rather than whichever came last.
export type LeadsEvent = { leads: Lead[]; rev: number };
export const leadsChannel = (cardId: string) => `leads:${cardId}`;

const fold = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
// One person at one company is one lead, however it was typed.
export const sameLead = (lead: Pick<Lead, 'person' | 'company'>, name: string, company: string) => fold(lead.person.name) === fold(name) && fold(lead.company.name) === fold(company);
export const leadName = (lead: Pick<Lead, 'person' | 'company'>) => `${lead.person.name} at ${lead.company.name}`;

// What is on record about a lead, as text: their row, the notes on it and what they wrote back. A first message may
// say about them only what this (or a read) gives (server/opener.ts).
export function leadRecord(lead: Pick<Lead, 'person' | 'company' | 'notes'> & Partial<Pick<Lead, 'fit' | 'thread'>>): string {
  const row = [lead.person.name, lead.person.title, lead.company.name, lead.company.site, lead.company.size].filter(Boolean).join(', ');
  const notes = lead.notes.map((note) => note.text);
  const said = (lead.thread ?? []).filter((event) => (event.kind === 'replied' || event.kind === 'notes') && event.text).map((event) => event.text!);
  return [row, ...(lead.fit?.why ? [lead.fit.why] : []), ...notes, ...said].join('\n');
}

// What the founder's "Draft first message" puts into a person's room. Journey 18: with nothing on record, Lea opened
// with "I saw your comment on Reddit"; the ask now says what is on record about them, or that nothing is.
export const draftAsk = (lead: Lead) => {
  const notes = lead.notes.map((note) => note.text.trim()).filter(Boolean);
  const known = notes.length
    ? ` On record about them (their notes on the Leads card): ${notes.join(' | ')}. Say about them only what these notes or a page you read now say.`
    : ' Nothing is on record about them beyond their name and company: say nothing about what they did, wrote or posted unless you read it now, and open with what we do, from the Company brief.';
  // Journey 21: Lea wrote the message in chat and made no draft until asked. With an address on record, it is an email
  // draft at once (server/firstdraft.ts makes it from the words when the model does not).
  const to = lead.person.email ? ` Their address: ${lead.person.email}. Write it with draft_email to that address, so it is a draft the founder opens in Gmail now, not only words in chat.` : '';
  return `Draft a first message to ${lead.person.name} at ${lead.company.name} using the evidence-outreach skill.${known}${to}`;
};

// The list as a spreadsheet: one row a lead, its notes joined, so it opens anywhere and imports into a sender as it is.
const COLUMNS = ['name', 'title', 'company', 'website', 'size', 'linkedin_url', 'email', 'stage', 'fit', 'fit_why', 'source', 'added', 'notes'];
const cell = (value: unknown) => {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
export function leadsCsv(leads: Lead[]): string {
  const rows = leads.map((lead) => [
    lead.person.name, lead.person.title, lead.company.name, lead.company.site, lead.company.size, lead.person.linkedin, lead.person.email,
    lead.stage, lead.fit?.score, lead.fit?.why, lead.source, day(lead.addedAt), lead.notes.map((note) => `${day(note.at)} ${note.by}: ${note.text}`).join(' | '),
  ]);
  return `${[COLUMNS, ...rows].map((row) => row.map(cell).join(',')).join('\n')}\n`;
}
