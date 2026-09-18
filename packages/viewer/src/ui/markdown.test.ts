import { describe, it, expect } from 'vitest';
import { md, inline } from './markdown.js';

/**
 * W5-3(b), from dry-run 3: the reader printed the note's own punctuation at the owner.
 *
 * The resolved pick read `---` on a line of its own and `_Resolved 2026-09-18T09:21:08.008Z: applied to
 * Brand/name.md_` with the underscores showing. Markdown the owner can see is markdown the reader has not
 * rendered, and this reader is the whole of what "in the office" means.
 */
describe('the reader\'s markdown (W5-3)', () => {
  it('draws a rule rather than printing three dashes', () => {
    expect(md('Above\n\n---\n\nBelow')).toContain('<hr>');
    expect(md('Above\n\n---\n\nBelow')).not.toContain('<p>---</p>');
    expect(md('***')).toContain('<hr>');
    expect(md('_______')).toContain('<hr>');
    // A dash inside a sentence is a dash, and a fence is still a fence.
    expect(md('a - b')).toContain('<p>a - b</p>');
    expect(md('```\n---\n```')).toContain('---');
  });

  it('renders _italics_ as italics, and leaves snake_case alone', () => {
    // `<em>`, because `<i>` is this reader's wikilink and `.prose i` is upright by design.
    expect(md('_Resolved at nine: applied to Brand/name.md_')).toContain('<em>Resolved at nine: applied to Brand/name.md</em>');
    expect(md('She said _no_.')).toContain('<em>no</em>');
    expect(md('[[Ideas/meal-kits]]')).toContain('<i>Ideas/meal-kits</i>');
    // Identifiers are not emphasis: an owner reading about `score_inputs` or a job id must see them as typed.
    expect(md('score_inputs and effort_value')).toContain('score_inputs and effort_value');
    expect(md('score_inputs and effort_value')).not.toContain('<em>');
    expect(md('a_b_c')).not.toContain('<em>');
    expect(md('[speed](https://a.example/_b_)')).not.toContain('<em>');
  });

  it('escapes first, so a note can never write HTML into the office', () => {
    expect(md('_<script>alert(1)</script>_')).not.toContain('<script>');
    expect(inline('**<b>hi</b>**')).toBe('<b>&lt;b&gt;hi&lt;/b&gt;</b>');
  });
});
