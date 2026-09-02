import { describe, it, expect } from 'vitest';
import { parseNote, stringifyNote, extractYamlBlock, extractOwnerComments } from '../src/frontmatter.js';

describe('frontmatter', () => {
  it('round-trips and preserves key order', () => {
    const data = { id: 'job_1', type: 'custom', title: 'T', status: 'queued', depends_on: [], approval: 'none', side_effects_done: [] };
    const text = stringifyNote(data, '## Goal\n\nhi');
    const back = parseNote(text);
    expect(back.data).toEqual(data);
    expect(Object.keys(back.data)).toEqual(Object.keys(data));
    expect(back.body).toBe('## Goal\n\nhi\n');
  });
  it('keeps ISO timestamps as strings', () => {
    const n = parseNote('---\ncreated: 2026-09-02T13:55:06.921Z\nn: 1\n---\nx');
    expect(n.data.created).toBe('2026-09-02T13:55:06.921Z');
    expect(n.data.n).toBe(1);
  });
  it('handles notes without frontmatter', () => {
    const n = parseNote('# Hello\n');
    expect(n.data).toEqual({});
    expect(n.body).toBe('# Hello\n');
  });
  it('extracts yaml blocks and owner comments', () => {
    const body = 'x\n```yaml\nmax_emails_per_day: 5\n```\n%%cubicle: be terser%% and %% cubicle: more blue %%';
    expect(extractYamlBlock(body)).toEqual({ max_emails_per_day: 5 });
    expect(extractOwnerComments(body)).toEqual(['be terser', 'more blue']);
  });
});
