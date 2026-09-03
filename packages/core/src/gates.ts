import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { repoRoot } from './template.js';

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

/** Who runs a gate: `<role>.review|verify` names the role; `requester.review` goes to the job's requester. */
export function gateAssignee(gate: string, job: { for?: string; owner_role?: string }): string {
  if (gate === 'requester.review') return job.for ?? job.owner_role ?? 'ceo';
  return gate.split('.')[0];
}
