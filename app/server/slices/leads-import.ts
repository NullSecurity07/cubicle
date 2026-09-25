import { leadsChannel, type LeadsEvent } from '../../shared/leads.ts';
import { readLeads, type Imported } from '../../shared/leads-import.ts';
import { hub } from '../events.ts';
import type { Slice } from '../install.ts';
import { leadsCardIds, leadsFor, type Leads } from '../leads/store.ts';

// A spreadsheet of contacts, pasted or dropped on a Leads card, becomes leads. Every row goes through the same `add`
// the card's own form uses, so a person already on the card at that company is not added twice, and every row is
// the founder's: nothing here asks a model anything.

export async function importInto(leads: Leads, cardId: string, text: string): Promise<Imported> {
  const read = readLeads(text);
  if (read.problem !== undefined) throw new Error(read.problem || 'Paste a few rows first.');
  let added = 0;
  let already = 0;
  for (const row of read.rows) {
    const { added: fresh } = await leads.add(cardId, {
      name: row.name, company: row.company, email: row.email, linkedin: row.linkedin, title: row.title, site: row.site, size: row.size,
      source: 'founder', ...(row.note ? { note: { by: 'Founder', text: row.note } } : {}),
    });
    if (fresh) added += 1; else already += 1;
  }
  return { added, already, skipped: read.skipped };
}

const PATH = /^\/api\/leads\/([a-z0-9][a-z0-9-]{0,63})\/import$/;

export default {
  name: 'leads-import',
  // After the leads slice, which makes the one store every Leads card shares and says each change on the feed.
  order: 110,
  install(deps) {
    const leads = leadsFor(deps.workspace, (cardId: string, event: LeadsEvent) => hub.say(leadsChannel(cardId), event));
    return {
      async route(req, res, path) {
        const cardId = PATH.exec(path)?.[1];
        if (!cardId || req.method !== 'POST') return false;
        if (!leadsCardIds(await deps.store.loadStage()).includes(cardId)) { deps.json(res, 404, { error: 'there is no Leads card by that name' }); return true; }
        const sent = await deps.body(req).catch(() => null);
        try { deps.json(res, 200, await importInto(leads, cardId, typeof sent?.text === 'string' ? sent.text : '')); }
        catch (error) { deps.json(res, 400, { error: (error as Error).message }); }
        return true;
      },
    };
  },
} satisfies Slice;
