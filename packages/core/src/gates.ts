import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { repoRoot } from './template.js';
import type { Org } from './org.js';

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

export function criteriaFor(t: GateTable, jobType: string): string {
  return (t[jobType] ?? t.custom ?? { criteria: '' }).criteria;
}

/**
 * Who runs a gate. `requester.review` goes to the job's requester. Otherwise the prefix names either a role
 * (`coo.verify` → `coo`) or a **team** (`research.review` → the research team's lead, `qa.review` → `qa_lead`).
 * The team form is what lets a gate follow the org chart instead of hard-coding whoever leads a room today;
 * without `org` the old prefix-is-a-role rule applies, which keeps the pure-parsing tests and callers working.
 */
export function gateAssignee(gate: string, job: { for?: string; owner_role?: string }, org?: Org): string {
  if (gate === 'requester.review') return job.for ?? job.owner_role ?? 'ceo';
  const who = gate.split('.')[0];
  return org?.teams[who]?.lead ?? who;
}
