import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { repoRoot } from './template.js';
import type { Org } from './org.js';
import type { RiskLevel } from './schemas.js';

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

/**
 * The gate chain a job actually owes, given its risk class (owner's operating model §26–27: guardrails for
 * ordinary engineering, human review reserved for genuinely high-risk decisions).
 *
 * Low risk is the base chain and nothing else. Medium and high insert `security.review` at the *front*: a
 * security problem found after QA has spent a cycle on the change costs the cycle twice. High risk adds no
 * further gate — it adds the owner's approval on a `threat_model` proposal, which the harness requires before
 * `finish` is accepted, because an owner decision is not a job anyone can be assigned.
 */
export function gatesForRisk(t: GateTable, jobType: string, risk: RiskLevel = 'low'): string[] {
  const base = gatesFor(t, jobType);
  if (risk === 'low' || base.includes('security.review')) return base;
  return ['security.review', ...base];
}

export function criteriaFor(t: GateTable, jobType: string): string {
  return (t[jobType] ?? t.custom ?? { criteria: '' }).criteria;
}

/**
 * Who runs a gate. `requester.review` goes to the job's requester. Otherwise the prefix names either a role
 * (`coo.verify` → `coo`) or a **team** (`research.review` → the research team's lead, `qa.review` → `qa_lead`).
 * The team form is what lets a gate follow the org chart instead of hard-coding whoever leads a room today;
 * without a lead source the old prefix-is-a-role rule applies, which keeps the pure-parsing tests and callers
 * working — except `security.review`, whose fallback is the CISO: `security` is a team (the CISO's office),
 * not a role id, so without this the gate was assigned to a non-existent role and the harness fell back to
 * the CEO.
 *
 * The lead source is either a loaded `Org` or a `(team) => leadRole | null` lookup, so a caller that has only
 * a roster function does not have to build an `Org` to resolve a gate.
 */
export type GateTeamLead = (team: string) => string | null | undefined;

export function gateAssignee(
  gate: string,
  job: { for?: string; owner_role?: string },
  teamLead?: Org | GateTeamLead,
): string {
  if (gate === 'requester.review') return job.for ?? job.owner_role ?? 'ceo';
  const who = gate.split('.')[0];
  const lead = typeof teamLead === 'function' ? teamLead(who) : teamLead?.teams[who]?.lead;
  if (lead) return lead;
  return who === 'security' ? 'ciso' : who;
}
