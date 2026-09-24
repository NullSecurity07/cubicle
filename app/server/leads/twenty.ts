import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LEAD_STAGES, leadName, noteKey, STAGE_NAMES, type Lead, type LeadStage, type TwentyStatus } from '../../shared/leads.ts';
import type { Leads } from './store.ts';

// The founder's own Twenty, kept level with the Leads cards. The app never runs Twenty: the founder does, and says
// where it is with TWENTY_URL and TWENTY_API_KEY. Written against Twenty v2.42's REST API (`/rest/...`, a bearer key
// from Settings → APIs & Webhooks) and its metadata API (`/rest/metadata/...`).

export type TwentyConfig = { url: string; key: string };
export function twentyConfig(env: NodeJS.ProcessEnv): TwentyConfig | null {
  const url = env.TWENTY_URL?.trim().replace(/\/+$/, '');
  const key = env.TWENTY_API_KEY?.trim();
  return url && key ? { url, key } : null;
}

// Twenty's answer when it said no. `status` 0 means it did not answer at all.
export class TwentyError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
const unreachable = (error: unknown) => error instanceof TwentyError && (error.status === 0 || error.status >= 500);

export const GAP = 200; // at most five requests a second
export const PULL_EVERY = 2 * 60_000;
const WAIT = 15_000;
const PAGES = 5; // 300 people a pull at most; the rest come on the next one

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export function createTwentyClient(config: TwentyConfig, http: typeof fetch = fetch, pause: (ms: number) => Promise<void> = sleep, now: () => number = Date.now) {
  let next = 0;
  let line: Promise<unknown> = Promise.resolve();
  // One at a time, a fifth of a second apart, whoever asks.
  function turn(): Promise<void> {
    const mine = line.then(async () => { const wait = next - now(); if (wait > 0) await pause(wait); next = now() + GAP; });
    line = mine.catch(() => {});
    return mine;
  }
  async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    await turn();
    let response: Response;
    try {
      response = await http(`${config.url}${path}`, {
        method, signal: AbortSignal.timeout(WAIT),
        headers: { authorization: `Bearer ${config.key}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) { throw new TwentyError(`${method} ${path.split('?')[0]} did not answer: ${(error as Error).message}`, 0); }
    const text = await response.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json: said below */ }
    if (!response.ok) {
      const said = json?.messages?.join?.('; ') ?? json?.message ?? json?.error ?? text.slice(0, 200);
      throw new TwentyError(`${method} ${path.split('?')[0]} answered ${response.status}: ${String(said).slice(0, 300)}`, response.status);
    }
    return json as T;
  }
  return { call, config };
}
export type TwentyClient = ReturnType<typeof createTwentyClient>;

// A stage as a Twenty select option: its API name is written in capitals.
export const STAGE_FIELD = 'cubicleStage';
export const stageValue = (stage: LeadStage) => stage.toUpperCase();
export const stageOf = (value: unknown): LeadStage | undefined => LEAD_STAGES.find((stage) => stageValue(stage) === value);
const COLORS: Record<LeadStage, string> = { new: 'gray', fit: 'blue', contacted: 'sky', replied: 'turquoise', meeting: 'purple', customer: 'green', passed: 'red' };

// The Twenty person a lead becomes. Twenty keeps a name in two parts; the first word is the first name.
export function personBody(lead: Lead, companyId: string | undefined, field: boolean) {
  const [firstName, ...rest] = lead.person.name.trim().split(/\s+/);
  return {
    name: { firstName, lastName: rest.join(' ') },
    jobTitle: lead.person.title ?? '',
    emails: { primaryEmail: lead.person.email ?? '' },
    linkedinLink: { primaryLinkUrl: lead.person.linkedin ?? '' },
    ...(companyId ? { companyId } : {}),
    ...(field ? { [STAGE_FIELD]: stageValue(lead.stage) } : {}),
  };
}
type Person = {
  id: string; updatedAt: string; deletedAt?: string | null;
  name?: { firstName?: string; lastName?: string }; jobTitle?: string;
  emails?: { primaryEmail?: string }; linkedinLink?: { primaryLinkUrl?: string };
  companyId?: string | null; company?: { id: string; name?: string; domainName?: { primaryLinkUrl?: string } } | null;
  [STAGE_FIELD]?: string | null;
};
const fullName = (person: Person) => [person.name?.firstName, person.name?.lastName].map((one) => one?.trim()).filter(Boolean).join(' ');
const fold = (text: string | undefined) => (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const day = (at: number) => new Date(at).toISOString().slice(0, 10);

type State = { cursor?: string; lastSync: number | null; pushed: number; pulled: number; lastPull: number };

export type MirrorDeps = {
  client: TwentyClient; leads: Leads;
  cards: () => Promise<string[]>;
  statePath: string;
  now?: () => number;
  log?: (line: string) => void;
  onStatus?: (status: TwentyStatus) => void;
};

export function createMirror(deps: MirrorDeps) {
  const { client, leads, cards, statePath } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  let state: State = { lastSync: null, pushed: 0, pulled: 0, lastPull: 0 };
  let loaded = false;
  let problem: { text: string; since: number } | undefined;
  // 'field': the stage travels as the cubicleStage select. 'notes': the key may not add fields, so a stage change
  // is written as a note instead, and a stage set in Twenty cannot come back.
  let mode: 'field' | 'notes' | undefined;
  let running = false;

  const status = (): TwentyStatus => ({
    connected: true, url: client.config.url, lastSync: state.lastSync, pushed: state.pushed, pulled: state.pulled,
    ...(problem ? { problem: problem.text, since: problem.since } : {}),
  });
  async function load() {
    if (loaded) return;
    loaded = true;
    try { state = { ...state, ...JSON.parse(await readFile(statePath, 'utf8')) }; } catch { /* the first sync */ }
  }
  async function keep() {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2));
    await rename(`${statePath}.tmp`, statePath);
  }

  // The stage field, made once. A key that may not change the data model gets the notes instead, and says so once.
  async function ensureField() {
    if (mode) return;
    // v2.42 answers with the objects as `data` itself, each with its fields; older ones put them under `data.objects`.
    const answer = (await client.call('GET', '/rest/metadata/objects'))?.data;
    const objects: any[] = Array.isArray(answer) ? answer : answer?.objects ?? [];
    const person = objects.find((one: any) => one.nameSingular === 'person');
    if (!person) throw new TwentyError('Twenty has no person object', 500);
    const fields: any[] = person.fields ?? [];
    if (fields.some((one) => one.name === STAGE_FIELD)) { mode = 'field'; return; }
    try {
      await client.call('POST', '/rest/metadata/fields', {
        objectMetadataId: person.id, type: 'SELECT', name: STAGE_FIELD, label: 'Cubicle stage', icon: 'IconProgressCheck',
        description: 'Where this lead stands on the founder\'s Leads card. Change it here and the card follows.', isNullable: true,
        options: LEAD_STAGES.map((stage, position) => ({ value: stageValue(stage), label: STAGE_NAMES[stage], position, color: COLORS[stage] })),
      });
      mode = 'field';
      log('Twenty: made the Cubicle stage field on People.');
    } catch (error) {
      if (!(error instanceof TwentyError) || unreachable(error)) throw error;
      mode = 'notes';
      log(`Twenty: could not add the Cubicle stage field (${error.message}), so a stage change goes over as a note.`);
    }
  }

  async function everyLead() {
    const all: { cardId: string; lead: Lead }[] = [];
    for (const cardId of await cards()) for (const lead of await leads.list(cardId)) all.push({ cardId, lead });
    return all;
  }

  // ----- pull: what the founder changed in Twenty comes to the card.
  async function pull(force = false) {
    if (mode !== 'field') return;
    if (!force && now() - state.lastPull < PULL_EVERY) return;
    const byPerson = new Map<string, { cardId: string; lead: Lead }>();
    const all = await everyLead();
    for (const one of all) if (one.lead.twenty) byPerson.set(one.lead.twenty.personId, one);
    const first = (await cards())[0];
    let after: string | undefined;
    let cursor = state.cursor;
    for (let page = 0; page < PAGES; page++) {
      const query = new URLSearchParams({ limit: '60', depth: '1', order_by: 'updatedAt[AscNullsFirst]' });
      if (state.cursor) query.set('filter', `updatedAt[gt]:${state.cursor}`);
      if (after) query.set('starting_after', after);
      const answer = await client.call('GET', `/rest/people?${query}`);
      const people: Person[] = answer?.data?.people ?? [];
      for (const person of people) {
        if (!cursor || person.updatedAt > cursor) cursor = person.updatedAt;
        const known = byPerson.get(person.id);
        if (known) await pullOne(known.cardId, known.lead, person);
        else if (first && stageOf(person[STAGE_FIELD])) await importOne(first, person);
      }
      if (!answer?.pageInfo?.hasNextPage || !people.length) break;
      after = answer.pageInfo.endCursor;
    }
    state.cursor = cursor;
    state.lastPull = now();
  }

  // Last write wins, by the clock: a lead changed here after Twenty's change keeps its own and sends it over.
  async function pullOne(cardId: string, lead: Lead, person: Person, conflict = false) {
    const link = lead.twenty!;
    if (person.updatedAt === link.remoteAt) return;
    const changedHere = lead.updatedAt > link.syncedAt;
    if (changedHere && Date.parse(person.updatedAt) <= lead.updatedAt) {
      log(`Twenty: ${leadName(lead)} changed in both; the card's change is later, so it goes to Twenty.`);
      return;
    }
    const patch: { stage?: LeadStage; title?: string; email?: string; linkedin?: string } = {};
    const stage = stageOf(person[STAGE_FIELD]);
    if (stage && stage !== lead.stage) patch.stage = stage;
    const title = person.jobTitle ?? '';
    if (title.trim() !== (lead.person.title ?? '')) patch.title = title;
    const email = person.emails?.primaryEmail ?? '';
    if (email.trim() !== (lead.person.email ?? '')) patch.email = email;
    const linkedin = person.linkedinLink?.primaryLinkUrl ?? '';
    if (linkedin.trim() !== (lead.person.linkedin ?? '')) patch.linkedin = linkedin;
    const said = Object.keys(patch);
    if (!said.length) { await leads.link(cardId, lead.id, { ...link, remoteAt: person.updatedAt }); return; }
    await leads.pulled(cardId, lead.id, patch, person.updatedAt, patch.stage ? `Stage set in Twenty: ${STAGE_NAMES[patch.stage]}.` : undefined);
    state.pulled++;
    log(`Twenty: ${leadName(lead)}: ${said.map((key) => key === 'stage' ? `stage now ${STAGE_NAMES[patch.stage!]}` : `${key} changed`).join(', ')}, from Twenty${conflict || changedHere ? ' (changed in both; Twenty\'s is later)' : ''}.`);
  }

  // Somebody the founder put in Twenty and gave a Cubicle stage comes onto the first Leads card.
  async function importOne(cardId: string, person: Person) {
    const name = fullName(person);
    if (!name) return;
    const { lead, added } = await leads.add(cardId, {
      name, company: person.company?.name?.trim() || 'Unknown company', source: 'twenty',
      title: person.jobTitle, email: person.emails?.primaryEmail, linkedin: person.linkedinLink?.primaryLinkUrl, site: person.company?.domainName?.primaryLinkUrl,
    });
    if (lead.twenty) return;
    await leads.link(cardId, lead.id, { personId: person.id, ...(person.company?.id || person.companyId ? { companyId: person.company?.id ?? person.companyId! } : {}), noteIds: {}, syncedAt: 0 });
    const stage = stageOf(person[STAGE_FIELD])!;
    await leads.pulled(cardId, lead.id, stage === lead.stage ? {} : { stage }, person.updatedAt);
    state.pulled++;
    log(`Twenty: ${leadName(lead)} ${added ? 'added in Twenty, now on the card' : 'was already on the card, now linked to Twenty'}, in ${STAGE_NAMES[stage]}.`);
  }

  // ----- push: every lead goes to Twenty, and every note once.
  const companies = new Map<string, string>();
  async function companyFor(lead: Lead): Promise<string | undefined> {
    if (lead.twenty?.companyId) return lead.twenty.companyId;
    const name = lead.company.name;
    const known = companies.get(fold(name));
    if (known) return known;
    const query = new URLSearchParams({ limit: '1', filter: `name[eq]:"${name.replace(/"/g, '\\"')}"` });
    const found = (await client.call('GET', `/rest/companies?${query}`))?.data?.companies?.[0]?.id as string | undefined;
    const id = found ?? (await client.call('POST', '/rest/companies', { name, ...(lead.company.site ? { domainName: { primaryLinkUrl: lead.company.site } } : {}) }))?.data?.createCompany?.id;
    if (id) companies.set(fold(name), id);
    return id;
  }
  async function pushOne(cardId: string, lead: Lead): Promise<boolean> {
    const link = lead.twenty;
    const dirty = !link || lead.updatedAt > link.syncedAt;
    const unsent = lead.notes.map((note, index) => ({ note, key: noteKey(note, index) })).filter(({ key }) => !link?.noteIds[key]);
    if (!dirty && !unsent.length) return false;
    const started = now();
    const companyId = await companyFor(lead);
    let personId = link?.personId;
    let remoteAt = link?.remoteAt;
    let sent = false;
    if (personId && dirty) {
      let there: Person | null = null;
      try { there = (await client.call('GET', `/rest/people/${personId}`))?.data?.person ?? null; }
      catch (error) { if (!(error instanceof TwentyError) || error.status !== 404) throw error; }
      if (!there || there.deletedAt) {
        log(`Twenty: ${leadName(lead)} was deleted in Twenty. The card keeps its leads, so it is put back there.`);
        personId = undefined;
      } else if (there.updatedAt !== link!.remoteAt && Date.parse(there.updatedAt) > lead.updatedAt) {
        // Twenty's change came later: it wins, and nothing is sent over it.
        await pullOne(cardId, lead, there, true);
        return true;
      } else {
        if (there.updatedAt !== link!.remoteAt) log(`Twenty: ${leadName(lead)} changed in both; the card's change is later, so it goes to Twenty.`);
        remoteAt = (await client.call('PATCH', `/rest/people/${personId}`, personBody(lead, companyId, mode === 'field')))?.data?.updatePerson?.updatedAt;
        sent = true;
      }
    }
    if (!personId) {
      const made = (await client.call('POST', '/rest/people', personBody(lead, companyId, mode === 'field')))?.data?.createPerson;
      personId = made?.id as string;
      remoteAt = made?.updatedAt;
      sent = true;
    }
    const noteIds = { ...(personId === link?.personId ? link?.noteIds : {}) };
    const target = async (title: string, markdown: string) => {
      const noteId = (await client.call('POST', '/rest/notes', { title, bodyV2: { markdown } }))?.data?.createNote?.id as string;
      await client.call('POST', '/rest/noteTargets', { noteId, targetPersonId: personId });
      return noteId;
    };
    for (const { note, key } of lead.notes.map((note, index) => ({ note, key: noteKey(note, index) }))) {
      if (noteIds[key]) continue;
      noteIds[key] = await target(`${note.by} · ${day(note.at)}`, note.text);
    }
    // Without the field, a stage change still reaches Twenty, as a note of its own.
    if (mode === 'notes' && noteIds.stage?.split(':')[0] !== lead.stage) {
      noteIds.stage = `${lead.stage}:${await target(`Stage: ${STAGE_NAMES[lead.stage]}`, `Moved to ${STAGE_NAMES[lead.stage]} on the Leads card.`)}`;
    }
    await leads.link(cardId, lead.id, { personId: personId!, ...(companyId ? { companyId } : {}), noteIds, syncedAt: started, ...(remoteAt ? { remoteAt } : {}) });
    return sent || unsent.length > 0;
  }
  async function push() {
    let count = 0;
    for (const { cardId, lead } of await everyLead()) {
      try { if (await pushOne(cardId, lead)) count++; }
      catch (error) {
        // Twenty down stops the round; one lead it will not take is said and skipped.
        if (!(error instanceof TwentyError) || unreachable(error) || error.status === 401) throw error;
        log(`Twenty: ${leadName(lead)} was not taken: ${error.message}`);
      }
    }
    state.pushed += count;
    return count;
  }

  function say() { deps.onStatus?.(status()); }
  return {
    status,
    // One round: the field, what came back, what goes over. A round never overlaps the one before it.
    async sync(options: { forcePull?: boolean } = {}) {
      if (running) return;
      running = true;
      try {
        await load();
        const before = state.pulled;
        await ensureField();
        await pull(options.forcePull);
        const sent = await push();
        state.lastSync = now();
        await keep();
        if (sent || state.pulled > before) log(`Twenty: sent ${sent}, brought back ${state.pulled - before}.`);
        if (problem) { log(`Twenty: reachable again at ${client.config.url}.`); problem = undefined; }
        say();
      } catch (error) {
        const text = error instanceof TwentyError && error.status === 401 ? 'the API key was refused' : unreachable(error) ? 'not reachable' : (error as Error).message;
        if (!problem || problem.text !== text) { log(`Twenty: ${text} (${(error as Error).message}).`); problem = { text, since: problem?.since ?? now() }; say(); }
      } finally { running = false; }
    },
    mode: () => mode,
  };
}
export type Mirror = ReturnType<typeof createMirror>;
