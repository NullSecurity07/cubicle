import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { repoRoot } from './template.js';
import { officeHolder, divisionOf, type Org } from './org.js';
import { OFFICES, DEFAULT_OFFICES, type Office, type RiskLevel } from './schemas.js';

export interface GateSpec { gates: string[]; criteria: string }
export type GateTable = Record<string, GateSpec>;

export function parseGates(text: string): GateTable {
  const raw = YAML.parse(text) ?? {};
  const gatesMap = (raw.gates ?? {}) as Record<string, string[]>;
  const criteriaMap = (raw.criteria ?? {}) as Record<string, string>;

  // Merge both maps by key
  const allKeys = new Set([...Object.keys(gatesMap), ...Object.keys(criteriaMap)]);
  const out: GateTable = {};

  for (const k of allKeys) {
    out[k] = {
      gates: gatesMap[k] ?? [],
      criteria: criteriaMap[k] ?? '',
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
 */
export type GateTeamLead = (team: string) => string | null | undefined;

export function gateAssignee(
  gate: string,
  job: { for?: string; owner_role?: string },
  source?: Org | GateTeamLead,
): string {
  const org = typeof source === 'function' ? undefined : source;
  const lookup: GateTeamLead = typeof source === 'function' ? source : (t) => org?.teams[t]?.lead;
  const ceo = org ? officeHolder(org, 'chief_executive') : 'ceo';
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
