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

// What the founder's "Draft first message" puts into a person's room.
export const draftAsk = (lead: Lead) => `Draft a first message to ${lead.person.name} at ${lead.company.name} using the evidence-outreach skill.`;

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
