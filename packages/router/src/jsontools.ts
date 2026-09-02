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
    'When the job is complete, call the finish tool: {"tool": "finish", "args": {"status": "done", "summary": "<what you did>"}}',
    'Only if no finish tool exists, end with: {"final": "<your answer>"}',
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
  s = quoteKeysOutsideStrings(s);
  s = s.replace(/,\s*([}\]])/g, '$1'); // trailing commas (safe: only after a value/closer)
  return s;
}

/** Quote unquoted or single-quoted object keys and convert single-quoted values — only outside double-quoted strings. */
export function quoteKeysOutsideStrings(src: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  let expectKey = false; // right after { or , at object level
  const stack: ('obj' | 'arr')[] = [];
  while (i < src.length) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (ch === '"') inStr = false;
      i++; continue;
    }
    if (ch === '"') { inStr = true; expectKey = false; out += ch; i++; continue; }
    if (ch === '{') { stack.push('obj'); expectKey = true; out += ch; i++; continue; }
    if (ch === '[') { stack.push('arr'); expectKey = false; out += ch; i++; continue; }
    if (ch === '}' || ch === ']') { stack.pop(); expectKey = false; out += ch; i++; continue; }
    if (ch === ',') { expectKey = stack[stack.length - 1] === 'obj'; out += ch; i++; continue; }
    if (ch === "'") {
      // single-quoted string (key or value)
      let j = i + 1; let val = '';
      while (j < src.length && src[j] !== "'") { if (src[j] === '\\') { val += src[j + 1] ?? ''; j += 2; continue; } val += src[j]; j++; }
      out += '"' + val.replace(/"/g, '\\"') + '"';
      i = j + 1; expectKey = false; continue;
    }
    if (expectKey && /[A-Za-z_$]/.test(ch)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const k = j; let m = j; while (m < src.length && /\s/.test(src[m])) m++;
      if (src[m] === ':') { out += '"' + src.slice(i, k) + '"'; i = k; expectKey = false; continue; }
    }
    if (ch === ':') expectKey = false;
    out += ch; i++;
  }
  return out;
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
