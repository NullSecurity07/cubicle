import { leadName, type Lead, type LeadStage } from './leads.ts';

// Follow-up nudges on the Leads card. A lead that has gone quiet in a stage where the next move is the founder's gets
// one quiet mark on the card and one line in Needs you. Only the stages where a message is owed count: New and Fit are
// the founder's to work through at their own pace, and a Customer or a Passed lead is settled.
export const CHASE_AFTER: Partial<Record<LeadStage, number>> = { contacted: 5, replied: 3, meeting: 3 };
export const DAY = 86_400_000;

// When a lead last moved or was written about: the later of the moment it entered its stage and its newest note.
export const quietSince = (lead: Pick<Lead, 'notes'>, enteredAt: number) => Math.max(enteredAt, lead.notes.at(-1)?.at ?? 0);
const days = (from: number, now: number) => Math.max(0, Math.floor((now - from) / DAY));

// Whole days a lead has been quiet past its stage's limit, or null when it is not owed a nudge.
export function staleDays(lead: Pick<Lead, 'stage' | 'notes'>, enteredAt: number, now: number): number | null {
  const after = CHASE_AFTER[lead.stage];
  if (after === undefined) return null;
  const quiet = days(quietSince(lead, enteredAt), now);
  return quiet >= after ? quiet : null;
}
// The moment a lead became owed a nudge, which is when its line in Needs you is dated.
export const staleFrom = (lead: Pick<Lead, 'stage' | 'notes'>, enteredAt: number) => quietSince(lead, enteredAt) + (CHASE_AFTER[lead.stage] ?? 0) * DAY;

// One nudge per lead per stage: the id names both, so a lead that is answered and goes quiet again in the same stage is
// not nagged about twice, and one that moves on to a new stage may be nudged there once.
export const nudgeId = (cardId: string, leadId: string, stage: LeadStage) => `lead-stale:${cardId}:${leadId}:${stage}`;
export function readNudgeId(id: string): { cardId: string; leadId: string; stage: LeadStage } | null {
  const [kind, cardId, leadId, stage] = id.split(':');
  return kind === 'lead-stale' && cardId && leadId && stage && stage in CHASE_AFTER ? { cardId, leadId, stage: stage as LeadStage } : null;
}

const ago = (count: number) => (count === 0 ? 'today' : count === 1 ? 'yesterday' : `${count} days ago`);

// The line in Needs you: what happened, when, and the one thing to do about it.
export function nudgeTitle(lead: Pick<Lead, 'person' | 'company' | 'stage'>, enteredAt: number, now: number): string {
  const when = ago(days(enteredAt, now));
  if (lead.stage === 'replied') return `${leadName(lead)} replied ${when}. Draft a reply?`;
  if (lead.stage === 'meeting') return `You met ${leadName(lead)} ${when}. Draft a follow-up?`;
  return `You wrote to ${leadName(lead)} ${when} and heard nothing. Draft a follow-up?`;
}
export const nudgeDetail = (quiet: number) => `Nothing written on this lead for ${quiet} days.`;
// What the mark on the card says when the founder rests on it.
export const markLine = (stage: LeadStage) => (stage === 'replied' ? 'Waiting for your reply' : 'Time to follow up');
// The button's words, by stage.
export const draftWord = (stage: LeadStage) => (stage === 'replied' ? 'Draft a reply' : 'Draft a follow-up');

// What pressing it asks the wired person, through the same road as "Draft first message".
export function nudgeAsk(lead: Pick<Lead, 'person' | 'company' | 'stage'>, enteredAt: number, now: number): string {
  const who = leadName(lead);
  const when = ago(days(enteredAt, now));
  if (lead.stage === 'replied') return `${who} replied ${when} and is still waiting for an answer. Read their notes on the Leads card, then draft a reply using the evidence-outreach skill. I will send it myself.`;
  if (lead.stage === 'meeting') return `I met ${who} ${when}. Read their notes on the Leads card, then draft the follow-up using the evidence-outreach skill: what we agreed and the one next step. I will send it myself.`;
  return `I wrote to ${who} ${when} and have heard nothing. Read their notes on the Leads card, then draft a short follow-up using the evidence-outreach skill: one new piece of evidence and one easy ask. I will send it myself.`;
}
