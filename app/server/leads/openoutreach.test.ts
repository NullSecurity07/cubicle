import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOutreach, csvLeads, FIND_VARS, FIXTURE, NO_UVX, outreachEnv, parseCsv, shortfall, statusProblem, uvxRunner, type Runner } from './openoutreach.ts';

describe('reading what OpenOutreach prints', () => {
  it('parses quoted fields with commas, doubled quotes and line breaks', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi""\nthere"\r\n\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"\nthere']]);
  });

  it('turns every row into a lead, its reason a note and never a made-up score', () => {
    const leads = csvLeads(readFileSync(FIXTURE, 'utf8'));
    expect(leads.map((one) => `${one.name} at ${one.company}`)).toEqual(['Priya Raman at Loomcraft', 'Jonas Berg at Fjordly', 'Ana at Nopal Foods']);
    expect(leads[0]).toMatchObject({ title: 'Head of Operations', site: 'https://loomcraft.example', linkedin: 'https://www.linkedin.com/in/priya-raman-example', source: 'openoutreach' });
    expect(leads[0].email).toBeUndefined();
    expect(leads[1].email).toBe('jonas@fjordly.example');
    expect(leads[0].note).toEqual({ by: 'OpenOutreach', text: 'Why it picked them: Runs ops for a 40-person textile brand; posted last week that "spreadsheets, again" are how they plan production.' });
    expect(leads[2].note?.text).toContain('regional grocer\nacross three states');
    expect(leads[2].title).toBe('Buyer, Private Label');
    expect(csvLeads('')).toEqual([]);
  });

  it('keeps the rows of a run that stopped short, and says why', () => {
    expect(shortfall({ code: 0, out: '', err: '' })).toBeNull();
    expect(shortfall({ code: 1, out: '', err: 'found 2\nerror: goal_unreached: the index ran dry\n' })).toBe('goal_unreached: the index ran dry');
  });
});

describe('whether finding can work', () => {
  const status = (doc: unknown, where: 'out' | 'err' = 'out') => ({ code: 0, out: where === 'out' ? JSON.stringify(doc, null, 2) : '', err: where === 'err' ? JSON.stringify(doc) : '' });

  it('names the settings a machine that never ran it still needs', () => {
    const said = statusProblem(status({ error: { type: 'not_initialized', message: 'no pipeline yet' } }, 'err'), { OPENOUTFIND_AI_MODEL: 'groq/x' });
    expect(said).toMatch(/^OpenOutreach is not set up: put OPENOUTFIND_ACCEPT_LEGAL_NOTICE, /);
    expect(said).toContain('in .env at the repository root.');
    expect(said).not.toContain('OPENOUTFIND_AI_MODEL');
    for (const name of FIND_VARS.filter((one) => one !== 'OPENOUTFIND_AI_MODEL')) expect(said).toContain(name);
  });

  it('reads the gaps an installed one reports, and only the finding half', () => {
    const said = statusProblem(status({ config: { complete: false, missing: { llm: ['OPENOUTFIND_LLM_API_KEY'] } }, next_action: { variables: ['OPENOUTFIND_LLM_API_KEY', 'OUTSEND_MAILBOX_ADDRESS'] } }), {});
    expect(said).toBe('OpenOutreach is not set up: put OPENOUTFIND_LLM_API_KEY in .env at the repository root.');
    expect(statusProblem(status({ config: { complete: true }, blocked: [] }), {})).toBeNull();
    expect(statusProblem({ code: 1, out: '', err: 'Traceback\nboom' }, {})).toBe('OpenOutreach did not answer: boom.');
  });

  it('answers at once from what it last heard, and looks again when that is old', async () => {
    let clock = 0;
    let asked = 0;
    const run: Runner = async () => { asked++; return { code: 0, out: JSON.stringify({ config: { complete: true } }), err: '' }; };
    const outreach = createOutreach({ run, env: () => ({}), now: () => clock });
    expect(outreach.ready()).toMatch(/being checked/);
    await outreach.check();
    expect(outreach.ready()).toBeNull();
    clock = 30_000;
    outreach.ready();
    clock = 120_000;
    outreach.ready();
    await new Promise((settle) => setTimeout(settle, 0));
    expect(asked).toBe(2);
  });

  it('says so when uvx is not here', async () => {
    const outreach = createOutreach({ run: uvxRunner(() => null), env: () => ({}) });
    expect(await outreach.check()).toBe(NO_UVX);
  });

  it('runs only status and find, and asks find for emails only when told to', async () => {
    await expect(uvxRunner(() => '/bin/true')(['export'], { env: {}, limit: 1000 })).rejects.toThrow('the app does not run "openoutreach export"');
    const seen: string[][] = [];
    const run: Runner = async (args) => { seen.push(args); return { code: 0, out: '', err: '' }; };
    const outreach = createOutreach({ run, env: () => ({}) });
    await outreach.find(10, false);
    await outreach.find(3, true);
    expect(seen).toEqual([['find', '10', '--new'], ['find', '3', '--new', 'emails']]);
  });

  it('never has a sending verb in it', () => {
    const code = readFileSync(join(import.meta.dirname, 'openoutreach.ts'), 'utf8');
    expect(code).not.toMatch(/['"`](send|run)['"`]/);
  });
});

describe('what the child is handed', () => {
  it('passes the OpenOutreach settings, from the .env as it is now, and none of the founder\'s other keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'outreach-env-'));
    await writeFile(join(root, '.env'), 'OPENOUTFIND_BETTERCONTACT_API_KEY=bc-key\nGROQ_API_KEY=gsk-secret\n');
    const env = outreachEnv({ PATH: '/usr/bin', HOME: '/home/x', OPENOUTFIND_LLM_API_KEY: 'llm-key', GEMINI_API_KEY: 'g-secret' }, root);
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/x', OPENOUTFIND_LLM_API_KEY: 'llm-key', OPENOUTFIND_BETTERCONTACT_API_KEY: 'bc-key' });
    expect(JSON.stringify(env)).not.toContain('secret');
  });
});
