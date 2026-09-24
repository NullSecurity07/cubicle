import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LEAD_STAGES, leadName, sameLead, type Lead, type LeadsEvent, type LeadStage } from '../../shared/leads.ts';

export type Leads = ReturnType<typeof createLeads>;
export type LeadInput = {
  name: string; company: string; title?: string; linkedin?: string; email?: string; site?: string; size?: string;
  source: Lead['source']; note?: { by: string; text: string };
};

const safe = (id: string) => { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`bad id: ${id}`); return id; };
const newId = () => `lead-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const line = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const optional = (value: unknown, max: number) => line(value, max) || undefined;
export const isStage = (value: unknown): value is LeadStage => (LEAD_STAGES as readonly unknown[]).includes(value);

// Leads live beside the stage, one file per leads card, the way a board's tasks do. The server owns them: people and
// the founder's window both only ask for changes, and every change is said to whoever listens.
export function createLeads(dir: string, tell: (cardId: string, event: LeadsEvent) => void = () => {}, now: () => number = Date.now) {
  const path = (cardId: string) => join(dir, 'leads', `${safe(cardId)}.json`);
  const cache = new Map<string, Lead[]>();
  const revs = new Map<string, number>();
  let queue: Promise<unknown> = Promise.resolve();

  async function load(cardId: string): Promise<Lead[]> {
    const known = cache.get(cardId);
    if (known) return known;
    let leads: Lead[] = [];
    try { leads = JSON.parse(await readFile(path(cardId), 'utf8')); } catch { /* a new card */ }
    cache.set(cardId, leads);
    // A list read afresh after a restart is still newer than anything a window heard before it.
    revs.set(cardId, Math.max(revs.get(cardId) ?? 0, now()));
    return leads;
  }
  function save(cardId: string) {
    const leads = cache.get(cardId) ?? [];
    const text = JSON.stringify(leads, null, 2);
    queue = queue.then(async () => { await mkdir(join(dir, 'leads'), { recursive: true }); await writeFile(`${path(cardId)}.tmp`, text); await rename(`${path(cardId)}.tmp`, path(cardId)); }).catch(() => {});
    revs.set(cardId, Math.max((revs.get(cardId) ?? 0) + 1, now()));
    tell(cardId, { leads, rev: revs.get(cardId)! });
  }

  // A lead named the way a person names one: its id, the person's name, or "name at company". Two that match is a
  // question back, never a guess.
  async function find(cardId: string, ref: string): Promise<Lead> {
    const leads = await load(cardId);
    const asked = ref.trim().toLowerCase();
    if (!asked) throw new Error('say which lead');
    const byId = leads.find((lead) => lead.id === ref.trim());
    if (byId) return byId;
    const [name, company] = asked.split(/\s+at\s+/);
    const exact = leads.filter((lead) => (company ? sameLead(lead, name, company) : lead.person.name.toLowerCase() === asked));
    const found = exact.length ? exact : leads.filter((lead) => leadName(lead).toLowerCase().includes(asked));
    if (found.length === 1) return found[0];
    if (!found.length) throw new Error(`no lead called "${ref.trim()}". list_leads shows who is there`);
    throw new Error(`"${ref.trim()}" could be ${found.slice(0, 4).map(leadName).join(', ')}. Say which, as "name at company"`);
  }

  return {
    settled: () => queue,
    list: load,
    // The list with its revision, as the feed says it.
    async read(cardId: string): Promise<LeadsEvent> { const leads = await load(cardId); return { leads, rev: revs.get(cardId)! }; },
    find,
    // A person at a company already on the card is not added twice: the one already there comes back instead.
    async add(cardId: string, input: LeadInput): Promise<{ lead: Lead; added: boolean }> {
      const name = line(input.name, 120);
      const company = line(input.company, 120);
      if (!name) throw new Error('a lead needs a person\'s name');
      if (!company) throw new Error('a lead needs a company');
      const leads = await load(cardId);
      const there = leads.find((lead) => sameLead(lead, name, company));
      if (there) return { lead: there, added: false };
      const at = now();
      const lead: Lead = {
        id: newId(),
        person: { name, ...strip({ title: optional(input.title, 160), linkedin: optional(input.linkedin, 300), email: optional(input.email, 200) }) },
        company: { name: company, ...strip({ site: optional(input.site, 300), size: optional(input.size, 60) }) },
        stage: 'new', notes: input.note && line(input.note.text, 2000) ? [{ at, by: input.note.by, text: line(input.note.text, 2000) }] : [],
        source: input.source, addedAt: at, updatedAt: at,
      };
      leads.push(lead);
      save(cardId);
      return { lead, added: true };
    },
    async move(cardId: string, leadId: string, stage: LeadStage): Promise<Lead> {
      if (!isStage(stage)) throw new Error(`a stage is one of ${LEAD_STAGES.join(', ')}`);
      return change(cardId, leadId, (lead) => { lead.stage = stage; });
    },
    async score(cardId: string, leadId: string, score: number, why: string): Promise<Lead> {
      if (!Number.isFinite(score)) throw new Error('a score is a number from 0 to 10');
      const clean = Math.max(0, Math.min(10, Math.round(score)));
      const reason = line(why, 1000);
      if (!reason) throw new Error('say why, with the evidence');
      // A good score takes a new lead forward; it never takes one back from further along.
      return change(cardId, leadId, (lead) => { lead.fit = { score: clean, why: reason, at: now() }; if (clean >= 7 && lead.stage === 'new') lead.stage = 'fit'; });
    },
    async note(cardId: string, leadId: string, by: string, text: string): Promise<Lead> {
      const words = typeof text === 'string' ? text.trim().slice(0, 2000) : '';
      if (!words) throw new Error('a note needs words');
      return change(cardId, leadId, (lead) => { lead.notes.push({ at: now(), by, text: words }); });
    },
    async remove(cardId: string, leadId: string) {
      const leads = await load(cardId);
      const index = leads.findIndex((lead) => lead.id === leadId);
      if (index < 0) return;
      const [gone] = leads.splice(index, 1);
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
      queue = queue.then(async () => { await mkdir(join(dir, 'trash'), { recursive: true }); await writeFile(join(dir, 'trash', `${stamp}-${gone.id}.json`), JSON.stringify(gone, null, 2)); }).catch(() => {});
      save(cardId);
    },
  };

  async function change(cardId: string, leadId: string, edit: (lead: Lead) => void): Promise<Lead> {
    const lead = (await load(cardId)).find((one) => one.id === leadId);
    if (!lead) throw new Error('that lead is not on the card');
    edit(lead);
    lead.updatedAt = now();
    save(cardId);
    return lead;
  }
}

function strip<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, one]) => one !== undefined)) as Partial<T>;
}
