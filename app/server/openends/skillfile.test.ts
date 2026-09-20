import { describe, expect, it } from 'vitest';
import type { Skill } from '../../shared/model.ts';
import { CAPS } from '../skills.ts';
import { cameFromOutside, fileName, frontMatter, OUTSIDE, parseSkillFile, renderSkillFile } from './skillfile.ts';

const WHOLE = `---
name: Ship a launch page
description: When the founder asks for a landing page for a launch
---

# Ship a launch page

## When to use
When the founder asks for a landing page for a launch

## Procedure
1. Read the brand doc for voice
2. Write the headline first
3. One call to action above the fold

## Pitfalls
- Do not invent a price
- Never say "revolutionary"

## Verification
The founder can read it and knows what the product does.
`;

const skill = {
  id: 'ship-a-launch-page', name: 'Ship a launch page', when: 'When the founder asks for a landing page for a launch',
  procedure: ['Read the brand doc for voice', 'Write the headline first', 'One call to action above the fold'],
  pitfalls: ['Do not invent a price', 'Never say "revolutionary"'], verify: 'The founder can read it and knows what the product does.',
} as Skill;

describe('a skill as a file', () => {
  it('reads the fields at the top and the four headings under them', () => {
    expect(parseSkillFile(WHOLE)).toEqual({ name: skill.name, when: skill.when, procedure: skill.procedure, pitfalls: skill.pitfalls, verify: skill.verify });
  });

  it('writes one that reads back as the same skill', () => {
    expect(parseSkillFile(renderSkillFile(skill))).toEqual({ name: skill.name, when: skill.when, procedure: skill.procedure, pitfalls: skill.pitfalls, verify: skill.verify });
    expect(renderSkillFile(skill)).toContain('description: When the founder asks');
    expect(fileName(skill)).toBe('ship-a-launch-page.SKILL.md');
  });

  it('forgives a file somebody typed themselves', () => {
    // No block at the top, headings at whatever depth they felt like, a list marked three ways, and no "when" at all.
    const rough = ['# How to send the Friday note', '', '### steps', '* Read what everybody finished', '- Write it in five lines', '', '#### Done when:', 'The founder sent it.'].join('\n');
    expect(parseSkillFile(rough)).toEqual({
      name: 'How to send the Friday note', when: 'When "How to send the Friday note" applies',
      procedure: ['Read what everybody finished', 'Write it in five lines'], pitfalls: [],
      verify: 'The founder sent it.',
    });
  });

  it('says what is missing, rather than making half a skill', () => {
    expect(() => parseSkillFile('## Procedure\n1. Do the thing')).toThrow('has no name');
    expect(() => parseSkillFile('# A name and nothing else')).toThrow('has no procedure');
  });

  it('keeps every field inside what a skill may be', () => {
    const long = parseSkillFile(`---\nname: ${'n'.repeat(200)}\ndescription: ${'w'.repeat(400)}\n---\n## Procedure\n1. Go`);
    expect(long.name).toHaveLength(CAPS.name);
    expect(long.when).toHaveLength(CAPS.when);
  });

  it('reads the little block at the top and leaves anything else in it alone', () => {
    const { fields, rest } = frontMatter('---\nname: "A name"\nallowed-tools: Read, Write\n---\n# Body\n');
    expect(fields).toEqual({ name: 'A name', 'allowed-tools': 'Read, Write' });
    expect(rest).toBe('# Body\n');
    expect(frontMatter('# No block').fields).toEqual({});
  });

  it('is marked as having come from outside, without a new field on a skill', () => {
    expect(cameFromOutside({ source: { kind: 'taught', ref: OUTSIDE } })).toBe(true);
    expect(cameFromOutside({ source: { kind: 'taught', ref: `${OUTSIDE}:friday.SKILL.md` } })).toBe(true);
    expect(cameFromOutside({ source: { kind: 'run', ref: 'task-1' } })).toBe(false);
  });
});
