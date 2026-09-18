import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { repoRoot } from './template.js';
import { officeHolder, divisionOf, teamOf, leadOf, type Org } from './org.js';
import { OFFICES, DEFAULT_OFFICES, ModelTier, type Office, type RiskLevel } from './schemas.js';

export interface GateSpec { gates: string[]; criteria: string; model_tier?: ModelTier }
export type GateTable = Record<string, GateSpec>;

/**
 * What a review costs by default. A gate reads a finished piece of work and judges it against written
 * criteria — real work, but not the work that needs the best model in the house. The owner's first live run
 * spent eleven strong-tier calls in a minute on gate jobs against a free strong tier of about sixty calls a
 * day, and the company then had nothing left to think with (finding F7, ruling FR-7).
 *
 * It is a *default*, in both directions: `config/gates.yaml`'s `model_tier:` map raises or lowers it per gate
 * when a review genuinely needs something else, and the reviewer's own charter is still the ceiling
 * (`effectiveTier`), so a cheap-tier charter reviews at cheap.
 */
export const DEFAULT_GATE_TIER: ModelTier = 'medium';

/**
 * The tier a gate job is created at: the gate's own `model_tier:` in `config/gates.yaml` if it has one,
 * otherwise `DEFAULT_GATE_TIER`. A gate named only in the `model_tier:` map and nowhere else is not a gate the
 * table knows, so it reads as the default like any other unknown one.
 */
export function gateTier(t: GateTable, gate: string): ModelTier {
  return t[gate]?.model_tier ?? DEFAULT_GATE_TIER;
}

export function parseGates(text: string): GateTable {
  const raw = YAML.parse(text) ?? {};
  const gatesMap = (raw.gates ?? {}) as Record<string, string[]>;
  const criteriaMap = (raw.criteria ?? {}) as Record<string, string>;
  const tierMap = (raw.model_tier ?? {}) as Record<string, ModelTier>;

  // Merge both maps by key. `model_tier:` deliberately adds no keys of its own: the job types the system knows
  // are the ones this table gates or describes (gen-docs reads them from here), and a tier for something that
  // is neither would invent one.
  const allKeys = new Set([...Object.keys(gatesMap), ...Object.keys(criteriaMap)]);
  const out: GateTable = {};

  for (const k of allKeys) {
    out[k] = {
      gates: gatesMap[k] ?? [],
      criteria: criteriaMap[k] ?? '',
      ...(tierMap[k] ? { model_tier: ModelTier.parse(tierMap[k]) } : {}),
    };
  }

  return out;
}

const cache = new Map<string, GateTable>();
export function loadGates(file = path.join(repoRoot(), 'config', 'gates.yaml')): GateTable {
  const hit = cache.get(file); if (hit) return hit;
  const t = parseGates(readFileSync(file, 'utf8')); cache.set(file, t); return t;
}

export function gatesFor(t: GateTable, jobType: string): string[] {
  return (t[jobType] ?? t.custom ?? { gates: [] }).gates;
}

/** The security gate, named by the office that runs it. `security.review` is the pre-office name. */
export const SECURITY_GATE = 'office:security.review';
const SECURITY_GATE_NAMES = [SECURITY_GATE, 'security.review'];

/**
 * The gate chain a job actually owes, given its risk class (owner's operating model §26–27: guardrails for
 * ordinary engineering, human review reserved for genuinely high-risk decisions).
 *
 * Low risk is the base chain and nothing else. Medium and high insert `office:security.review` at the *front*: a
 * security problem found after QA has spent a cycle on the change costs the cycle twice. High risk adds no
 * further gate — it adds the owner's approval on a `threat_model` proposal, which the harness requires before
 * `finish` is accepted, because an owner decision is not a job anyone can be assigned.
 *
 * A chain that already names the security gate under *either* name keeps the one it has: a table an owner wrote
 * before the rename must not end up gated twice by the same review.
 */
export function gatesForRisk(t: GateTable, jobType: string, risk: RiskLevel = 'low'): string[] {
  const base = gatesFor(t, jobType);
  // Always a fresh array: `gatesFor` hands back the table's own list, and a caller that sorts or splices the
  // chain would otherwise rewrite the loaded gate table for every job after it.
  if (risk === 'low' || base.some((g) => SECURITY_GATE_NAMES.includes(g))) return [...base];
  return [SECURITY_GATE, ...base];
}

export function criteriaFor(t: GateTable, jobType: string): string {
  return (t[jobType] ?? t.custom ?? { criteria: '' }).criteria;
}

/**
 * Who runs a gate.
 *
 * - `requester.review` goes back to the job's requester, and to the chief executive when nobody asked.
 * - `office:<office>.<verb>` resolves through the constitution's office map (`officeHolder`), so re-staffing a
 *   seat in `Memory/constitution.md` moves every gate that office runs — no gate names a person.
 * - `team:<team>.<verb>` goes to that room's lead and, when the room has no *active* lead, up the tree to the
 *   lead of its division rather than straight to the CEO.
 * - anything else is the pre-office form: the head names a team if one exists (`research.review` → the research
 *   room's lead), otherwise it is a literal role id, so a gate an owner wrote by hand keeps working.
 *
 * The lead source is either a loaded `Org` or a `(team) => leadRole | null` lookup, so a caller that has only a
 * roster function does not have to build an `Org` to resolve a gate; with a lookup (or nothing at all) an office
 * degrades to the office's *default* seat — `office:security.review` still lands on the CISO — and a room with
 * no answer degrades to the chief executive.
 *
 * **Never the job's own author** (ruling W4-12). A gate is a second pair of eyes (spec §4), and `research.review`
 * resolves to the research room's lead, who is also who most `research` jobs are assigned to — so by default that
 * gate was a self-review. The harness used to catch it after the fact and log a `daemon.warning`; the
 * 2026-09-14 run logged three, which is three times the roster said "review your own work" and something else
 * had to say no. It is decided here instead, where the gate is resolved, so nobody downstream can get it wrong
 * and there is nothing left to warn about. `job.assigned` is the author; when it is not given, or when only a
 * lookup is available, the resolution is unchanged.
 */
export type GateTeamLead = (team: string) => string | null | undefined;

/** A gate name with its `office:` / `team:` prefix and its verb stripped: the room or office it points at. */
function gateRoom(gate: string): string {
  const dot = gate.lastIndexOf('.');
  return (dot === -1 ? gate : gate.slice(0, dot)).replace(/^(?:office|team):/, '');
}

/**
 * Somebody other than `author` who can run `gate`, in the brief's order: an active member of the gate's own room
 * (the research room for `research.review`), then that room's lead, then the resolved reviewer's own lead, then
 * the chief executive. Null when the author is genuinely the only person who could look, which is the one case
 * where a self-review is better than no review.
 */
export function otherEyesFor(gate: string, assignee: string, author: string, org: Org): string | null {
  const room = org.teams[gateRoom(gate)] ?? teamOf(org, assignee);
  const candidates = [...(room?.members ?? []), room?.lead ?? '', leadOf(org, assignee) ?? '', officeHolder(org, 'chief_executive')];
  return candidates.find((c) => c && c !== author && org.roles[c]) ?? null;
}

export function gateAssignee(
  gate: string,
  job: { for?: string; owner_role?: string; assigned?: string },
  source?: Org | GateTeamLead,
): string {
  const org = typeof source === 'function' ? undefined : source;
  const lookup: GateTeamLead = typeof source === 'function' ? source : (t) => org?.teams[t]?.lead;
  const ceo = org ? officeHolder(org, 'chief_executive') : 'ceo';
  const resolved = resolveGate();
  // The author is excluded here, where the gate is resolved, rather than patched over by whoever created the
  // job. With no `Org` there is no roster to pick an alternative from, so the resolution stands and the caller
  // (which has one) does the excluding.
  if (!org || !job.assigned || resolved !== job.assigned) return resolved;
  return otherEyesFor(gate, resolved, job.assigned, org) ?? resolved;

  function resolveGate(): string {
    if (gate === 'requester.review') return job.for ?? job.owner_role ?? ceo;

    // The verb is the last segment; everything before it names the office or the room. `lastIndexOf` rather than
    // `split('.')` so a team id that contains a dot still reads as one name.
    const dot = gate.lastIndexOf('.');
    const head = dot === -1 ? gate : gate.slice(0, dot);

    if (head.startsWith('office:')) {
      const office = head.slice('office:'.length);
      if (org && (OFFICES as readonly string[]).includes(office)) return officeHolder(org, office as Office);
      // An office head the OFFICES enum does not know falls back to a raw team lookup, which (unlike the room
      // path below) named no active-role check — a departed lead named in `org.teams[office].lead` would still
      // get the gate. Guard it the same way `roomLead` does, when an org is actually available to check against.
      const lead = lookup(office);
      if (lead && (!org || org.roles[lead])) return lead;
      return DEFAULT_OFFICES[office as Office] ?? ceo;
    }
    if (head.startsWith('team:')) return roomLead(head.slice('team:'.length), org, lookup, ceo) ?? ceo;
    // Pre-office name: a team id if the org knows one, else the literal role the owner wrote — except
    // `security.review`, whose head is the CISO's office rather than a role id, so without an org it would
    // otherwise resolve to a role called "security" that has never existed.
    return roomLead(head, org, lookup, ceo) ?? (head === 'security' ? DEFAULT_OFFICES.security : head);
  }

  function roomLead(id: string, o: Org | undefined, look: GateTeamLead, fallback: string): string | null {
    if (o) {
      const room = o.teams[id];
      if (!room) return null;
      if (o.roles[room.lead]) return room.lead;
      // The room's lead is gone: the work goes up the tree to the division, not sideways to the CEO.
      const div = divisionOf(o, room.id);
      const divLead = div && div !== room.id ? o.teams[div]?.lead : null;
      return divLead && o.roles[divLead] ? divLead : fallback;
    }
    return look(id) ?? null;
  }
}
