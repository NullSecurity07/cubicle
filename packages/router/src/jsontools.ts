/**
 * Prompt-based tool calling for models with `tools: json`. The harness injects the tool schemas and a
 * strict instruction; replies are a single JSON object, parsed with tolerant repair.
 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ParsedToolReply =
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | { kind: 'final'; text: string }
  | { kind: 'error'; reason: string; raw: string };

export function buildJsonToolInstruction(tools: ToolSchema[]): string {
  const lines = tools.map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`);
  return [
    'You can use tools. You MUST respond with exactly one JSON object and nothing else — no prose, no markdown fences.',
    'To call a tool: {"tool": "<name>", "args": { ... }}',
    'To finish without a tool: {"final": "<your answer>"}',
    'Available tools:',
    ...lines,
  ].join('\n');
}

/** Extract the first balanced {...} object from free text. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  // Unbalanced: try closing the braces
  return text.slice(start) + '}'.repeat(Math.max(0, depth));
}

/** Tolerant JSON repair: fences, trailing commas, single quotes, unquoted keys, smart quotes. */
export function repairJson(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const obj = extractJsonObject(s);
  if (obj) s = obj;
  s = s.replace(/,\s*([}\]])/g, '$1');                  // trailing commas
  s = s.replace(/([{,]\s*)'([^']*)'\s*:/g, '$1"$2":');    // single-quoted keys
  s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":'); // unquoted keys
  s = s.replace(/:\s*'([^']*)'/g, (_m, v: string) => `: "${v.replace(/"/g, '\\"')}"`); // single-quoted values
  return s;
}

export function parseJsonToolReply(raw: string): ParsedToolReply {
  const attempts = [raw.trim(), repairJson(raw)];
  for (const a of attempts) {
    try {
      const j = JSON.parse(a);
      if (j && typeof j === 'object') {
        if (typeof j.tool === 'string') return { kind: 'tool', name: j.tool, args: (j.args && typeof j.args === 'object') ? j.args : {} };
        if (typeof j.final === 'string') return { kind: 'final', text: j.final };
        if (typeof j.name === 'string' && j.arguments) return { kind: 'tool', name: j.name, args: typeof j.arguments === 'string' ? JSON.parse(j.arguments) : j.arguments };
      }
    } catch { /* try next */ }
  }
  return { kind: 'error', reason: 'reply was not a single JSON object with "tool" or "final"', raw };
}
