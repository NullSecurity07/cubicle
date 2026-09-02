import { describe, it, expect } from 'vitest';
import { parseJsonToolReply, repairJson, buildJsonToolInstruction } from '../src/jsontools.js';

describe('json tool calling', () => {
  it('parses a clean tool call', () => {
    expect(parseJsonToolReply('{"tool":"vault.read","args":{"path":"Plans/plan.md"}}')).toEqual({ kind: 'tool', name: 'vault.read', args: { path: 'Plans/plan.md' } });
  });
  it('repairs fenced, trailing-comma, single-quoted replies', () => {
    const raw = "Sure! Here you go:\n```json\n{'tool': 'vault.write', args: {path: 'Jobs/x.md', content: 'hi',},}\n```";
    const r = parseJsonToolReply(raw);
    expect(r.kind).toBe('tool');
    if (r.kind === 'tool') { expect(r.name).toBe('vault.write'); expect(r.args).toEqual({ path: 'Jobs/x.md', content: 'hi' }); }
  });
  it('parses final answers and reports garbage', () => {
    expect(parseJsonToolReply('{"final": "done"}')).toEqual({ kind: 'final', text: 'done' });
    expect(parseJsonToolReply('I cannot do that').kind).toBe('error');
  });
  it('handles three successive replies with one malformed', () => {
    const replies = ['{"tool":"a","args":{}}', '{"tool": "b", "args": {"n": 1,}}', '{"final":"ok"}'];
    const out = replies.map(parseJsonToolReply).map((r) => r.kind);
    expect(out).toEqual(['tool', 'tool', 'final']);
  });
  it('builds an instruction listing tools', () => {
    const s = buildJsonToolInstruction([{ name: 'finish', description: 'end', parameters: { type: 'object' } }]);
    expect(s).toContain('finish');
    expect(s).toContain('exactly one JSON object');
    expect(repairJson('{"a":1,}')).toBe('{"a":1}');
  });
});
