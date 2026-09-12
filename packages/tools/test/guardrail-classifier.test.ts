/**
 * The constitution guardrail's `banned_tactics` classifier: the one check in the tool layer that leaves the
 * process. B1 (2026-09-13) found it unbounded (it inherited the provider's 300 s `timeout_ms`), silent (no
 * event for the whole of its await, so a working company and a hung one looked identical), failing **open**
 * (a flat local model switched the constitution's strictest rule off), and pinned to `privacy: 'local'` (so
 * `CUBICLE_DISABLE_PROVIDERS=ollama` could not reach it and a wedged local model was the only candidate).
 *
 * This file holds one case per property.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob, openMemoryDb, EventLog, HOUSE } from '@cubicle/core';
import { Router, QuotaTracker, parseProvidersConfig, allowProviderBaseUrl, type RoutedChatResult, type RouteRequest } from '@cubicle/router';
import { parseToolsConfig, constitutionGuardrail, classifyBannedTactic, isClassifierUnavailable, CLASSIFIER_TIMEOUT_MS, CLASSIFIER_WHERE, type ToolContext } from '../src/index.js';

let dir: string; let vault: Vault;
const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-classifier-'));
  vault = (await scaffoldVault(dir)).vault;
});
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

function role(id: string) { return RoleFrontmatter.parse(parseNote(vault.readText(`Roles/${id}.md`)).data); }
/**
 * Some role the scaffolded vault actually has. Read from `Roles/` rather than spelled out: the guardrail does
 * not care which role is sending, and a test that pins a role id breaks the moment the roster is re-staffed.
 */
function someRole(): string {
  const rel = vault.list('Roles', { ext: '.md' }).filter((r) => !r.includes('/archive/'))[0];
  return path.basename(rel, '.md');
}
function ctxFor(roleId: string, jobId: string | null): ToolContext {
  return { vault, events: vault.events, roleId, role: role(roleId), jobId, config: cfg, env: {}, workspace: 'x', now: () => new Date(), scheduler: { enqueue: (j) => createJob(vault, j, roleId) } };
}

/** A router whose one chat call does whatever `fn` says, and remembers how it was asked to route. */
function router(fn: (req: RouteRequest) => Promise<Partial<RoutedChatResult>>): Router & { seen: RouteRequest[] } {
  const seen: RouteRequest[] = [];
  const r = {
    seen,
    async chat(req: RouteRequest): Promise<RoutedChatResult> {
      seen.push(req);
      const out = await fn(req);
      return { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'cheap', downgraded: false, parsedToolCalls: [], ...out } as RoutedChatResult;
    },
  };
  return r as unknown as Router & { seen: RouteRequest[] };
}

const says = (json: string) => router(async () => ({ content: json }));
/** Distinct copy per case: a verdict is memoised per (text, tactics), so a repeat would never be asked. */
let n = 0;
const freshText = (): string => `An ordinary note about the roadmap, number ${++n}-${Date.now()}`;

describe('the banned_tactics classifier is bounded by its own clock', () => {
  it('gives up after CLASSIFIER_TIMEOUT_MS rather than inheriting the provider timeout, and refuses the call', async () => {
    // Never settles — the wedged local model of the B1 report, whose provider bound is 300 000 ms.
    const wedged = router(() => new Promise<Partial<RoutedChatResult>>(() => undefined));
    const warnings: string[] = [];
    const t0 = Date.now();
    const res = await classifyBannedTactic(wedged, freshText(), ['fake urgency'], { warn: (m) => warnings.push(m) });
    const elapsed = Date.now() - t0;

    expect(res.verdict).toBe('unavailable');
    expect(CLASSIFIER_TIMEOUT_MS).toBe(20_000);
    // The clock the docblock claims, not merely "eventually": it waits the full bound and then gives up
    // inside two seconds of it. `< 2 × bound` would have passed a 39-second timeout (review round 1).
    expect(elapsed).toBeGreaterThanOrEqual(CLASSIFIER_TIMEOUT_MS);
    expect(elapsed).toBeLessThan(CLASSIFIER_TIMEOUT_MS + 2_000);
    // Fails CLOSED: a reason, naming the guardrail and the cause, not a null that would let the copy out.
    expect(res.reason).toContain('constitution guardrail');
    expect(res.reason).toContain('banned_tactics classifier');
    expect(res.reason).toContain(`no answer in ${CLASSIFIER_TIMEOUT_MS} ms`);
    expect(isClassifierUnavailable(res.reason)).toBe(true);
    expect(warnings.length).toBe(1);
  }, 60_000);

  it('fails closed on a transport error and on a reply with no verdict, and never throws', async () => {
    const broken = router(async () => { throw new Error('ollama down'); });
    const rambling = says('I think that is probably fine?');
    const warnings: string[] = [];

    const a = await classifyBannedTactic(broken, freshText(), ['fake urgency'], { warn: (m) => warnings.push(m) });
    expect(a.verdict).toBe('unavailable');
    expect(a.reason).toContain('ollama down');

    const b = await classifyBannedTactic(rambling, freshText(), ['fake urgency'], { warn: (m) => warnings.push(m) });
    expect(b.verdict).toBe('unavailable');
    expect(b.reason).toContain('answered with no verdict');

    expect(warnings.length).toBe(2);
    for (const w of warnings) expect(w).toContain('refusing the call rather than sending it unchecked');
  });

  it('still says yes and no when the model answers, and remembers the answer', async () => {
    const clear = says('{"violates": false, "tactic": ""}');
    const text = freshText();
    expect((await classifyBannedTactic(clear, text, ['fake urgency'])).verdict).toBe('clear');
    expect((await classifyBannedTactic(clear, text, ['fake urgency'])).memoised).toBe(true);
    expect(clear.seen.length).toBe(1);

    const caught = says('{"violates": true, "tactic": "fake urgency"}');
    const hit = await classifyBannedTactic(caught, freshText(), ['fake urgency']);
    expect(hit.verdict).toBe('violation');
    expect(hit.reason).toContain('fake urgency');
    expect(isClassifierUnavailable(hit.reason)).toBe(false);   // a rule was broken; that answer stands
  });

  it('forgets a refusal the moment a model answers again, so the office is not told to wait on an outage that ended', async () => {
    const broken = router(async () => { throw new Error('ollama down'); });
    const text = freshText();
    expect((await classifyBannedTactic(broken, text, ['fake urgency'])).verdict).toBe('unavailable');
    // Within the memo's TTL, so without the era check the next ask would be served the stale refusal —
    // silently, since a memo hit emits no `checking`, no `checked` and no warning.
    expect((await classifyBannedTactic(broken, text, ['fake urgency'])).memoised).toBe(true);
    expect(broken.seen.length).toBe(1);

    // Any successful classification, of any text, ends the outage.
    await classifyBannedTactic(says('{"violates": false, "tactic": ""}'), freshText(), ['fake urgency']);

    const back = says('{"violates": false, "tactic": ""}');
    const again = await classifyBannedTactic(back, text, ['fake urgency']);
    expect(again.memoised).toBe(false);   // asked again rather than refused from memory
    expect(again.verdict).toBe('clear');
    expect(back.seen.length).toBe(1);
  });

  it('a verdict a model actually gave is still remembered across an outage — it is a fact about the text', async () => {
    const clear = says('{"violates": false, "tactic": ""}');
    const text = freshText();
    expect((await classifyBannedTactic(clear, text, ['fake urgency'])).verdict).toBe('clear');
    await classifyBannedTactic(router(async () => { throw new Error('ollama down'); }), freshText(), ['fake urgency']);
    expect((await classifyBannedTactic(clear, text, ['fake urgency'])).memoised).toBe(true);
    expect(clear.seen.length).toBe(1);
  });
});

describe('the classifier routes like every other call', () => {
  it('asks the cheap tier through the ordinary cascade, with no privacy pin, charged to the house', async () => {
    const r = says('{"violates": false}');
    await classifyBannedTactic(r, freshText(), ['fake urgency']);
    const req = r.seen[0];
    expect(req.tier).toBe('cheap');
    // No `privacy: 'local'`: a disabled or wedged local provider is then simply not a candidate, and
    // CUBICLE_DISABLE_PROVIDERS (which the router honours at config load) can switch it off like any other.
    expect(req.privacy).toBeUndefined();
    expect(req.budgetDivision).toBe(HOUSE);
    expect(req.needsTools).toBe(false);
  });
});

describe('a timeout costs exactly one call', () => {
  it('does not walk the rest of the cascade with a dead signal: one warning, no quota rows, no cooling', async () => {
    // Four models behind one stub that never answers — the shape of the shipped cascade, in miniature. The
    // classifier aborts at its own deadline; before review round 1 that abort was handed to every remaining
    // candidate, each failing instantly as a `ProviderError` and leaving a `daemon.warning` the brief reads
    // as an outage plus a spent quota slot, for a call nobody ever made.
    const server = http.createServer((req) => { req.resume(); /* never responds */ });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const undo = allowProviderBaseUrl(base);
    const db = openMemoryDb();
    const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-cascade-'));
    const events = new EventLog(db, dir);
    try {
      const cfg = parseProvidersConfig(`
cascade: [p]
providers:
  - id: p
    base_url: ${base}
    timeout_ms: 300000
    models:
      - { id: m1, tier: cheap, tools: json, limits: { rpm: 100 } }
      - { id: m2, tier: cheap, tools: json, limits: { rpm: 100 } }
      - { id: m3, tier: cheap, tools: json, limits: { rpm: 100 } }
      - { id: m4, tier: cheap, tools: json, limits: { rpm: 100 } }
`);
      const real = new Router(cfg, new QuotaTracker(db), { env: {}, events });
      const warnings: string[] = [];
      const res = await classifyBannedTactic(real, freshText(), ['fake urgency'], { warn: (m) => warnings.push(m) });

      expect(res.verdict).toBe('unavailable');
      expect(warnings.length).toBe(1);                                   // the classifier's own, and only that
      expect(events.count('daemon.warning')).toBe(0);                    // no phantom provider outage
      expect(events.count('quota.updated')).toBe(0);                     // nothing marked cooling
      expect((db.prepare('SELECT COUNT(*) c FROM quota_calls').get() as { c: number }).c).toBe(0);
      expect(events.count('router.call')).toBe(0);
    } finally {
      undo(); db.close(); server.close(); rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('the wait is visible in the event log', () => {
  it('says guardrail.checking before the call and guardrail.checked after, and warns once when it fails', async () => {
    const c = vault.constitution();
    expect(c.banned_tactics.length).toBeGreaterThan(0);   // the scaffolded constitution still has a list to check
    const roleId = someRole();
    const ctx = ctxFor(roleId, 'job_vis');

    const before = { checking: vault.events.count('guardrail.checking'), checked: vault.events.count('guardrail.checked') };
    const g = constitutionGuardrail(says('{"violates": false, "tactic": ""}'));
    expect(await g.check('mock.outbound', { body: freshText() }, ctx)).toBeNull();

    expect(vault.events.count('guardrail.checking')).toBe(before.checking + 1);
    expect(vault.events.count('guardrail.checked')).toBe(before.checked + 1);
    const start = vault.events.last('guardrail.checking')!;
    expect(start.payload.tool).toBe('mock.outbound');
    expect(start.payload.role).toBe(roleId);
    expect(start.payload.job).toBe('job_vis');
    expect(start.agent).toBe(roleId);
    const end = vault.events.last('guardrail.checked')!;
    expect(end.payload.verdict).toBe('clear');
    expect(typeof end.payload.elapsed_ms).toBe('number');

    // A failed check: one `daemon.warning` at `guardrail.classifier`, a `checked` saying `unavailable`, and a
    // refusal that names the guardrail — the outbound copy does not leave.
    const broken = constitutionGuardrail(router(async () => { throw new Error('ollama down'); }));
    const refusal = await broken.check('mock.outbound', { body: freshText() }, ctx);
    expect(refusal).toContain('constitution guardrail');
    expect(vault.events.last('guardrail.checked')!.payload.verdict).toBe('unavailable');
    const warn = vault.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === CLASSIFIER_WHERE);
    expect(warn.length).toBe(1);
  });

  it('says nothing at all when there is nothing to wait for: a memo hit, or no router', async () => {
    const ctx = ctxFor(someRole(), 'job_quiet');
    const r = says('{"violates": false, "tactic": ""}');
    const g = constitutionGuardrail(r);
    const body = freshText();
    await g.check('mock.outbound', { body }, ctx);
    const after = vault.events.count('guardrail.checking');

    // The same call is checked twice in the live system (harness pre-check, then the MCP wrapper). The second
    // never leaves the process, so there is no wait to announce and the office must not flicker.
    await g.check('mock.outbound', { body }, ctx);
    expect(vault.events.count('guardrail.checking')).toBe(after);
    expect(r.seen.length).toBe(1);

    // A guardrail built without a router is a dependency the caller omitted, not a classifier that failed:
    // the cheap substring check is the whole rule, and nothing is refused or announced.
    const noRouter = constitutionGuardrail();
    expect(await noRouter.check('mock.outbound', { body: freshText() }, ctx)).toBeNull();
    expect(vault.events.count('guardrail.checking')).toBe(after);
  });
});
