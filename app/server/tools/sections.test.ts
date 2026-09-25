import { describe, expect, it } from 'vitest';
import { headings, replaceSection, rewriteLoss } from './sections.ts';

const PLAN = '# Launch plan\n\nIntro line.\n\n## Research\n\nNils found three rivals.\n\n### Sources\n\n- a\n- b\n\n## Review\n\nFaye: weak numbers.\n\n## Build\n\nTBD\n';

describe('headings', () => {
  it('finds every markdown heading with its level, and none inside a code fence', () => {
    expect(headings(`${PLAN}\n\`\`\`\n# not a heading\n\`\`\`\n`).map((one) => [one.level, one.title])).toEqual([[1, 'Launch plan'], [2, 'Research'], [3, 'Sources'], [2, 'Review'], [2, 'Build']]);
  });
});

describe('rewriteLoss', () => {
  it('lets a rewrite through that keeps the sections and most of the text', () => {
    expect(rewriteLoss(PLAN, PLAN.replace('TBD', 'Ship the stage in October.'))).toBeNull();
    expect(rewriteLoss('', 'anything')).toBeNull();
  });

  it('names the sections a rewrite of one section would lose', () => {
    const loss = rewriteLoss(PLAN, '## Build\n\nShip it. Everything is ready to go and has been checked by the team twice over.');
    expect(loss).toMatch(/drops 4 of its 5 sections \("Launch plan", "Research", "Sources", "Review"\)/);
  });

  it('catches a rewrite that keeps the headings but empties them', () => {
    expect(rewriteLoss(PLAN, '# Launch plan\n## Research\n### Sources\n## Review\n## Build\n')).toMatch(/keeps only \d+ of its \d+ characters/);
  });

  it('matches headings whatever their case or spacing', () => {
    expect(rewriteLoss('## Who  it is for\n\nFounders who ship alone.', '## who it is for\n\nFounders who ship alone, fast.')).toBeNull();
  });
});

describe('replaceSection', () => {
  const swap = (heading: string, body: string) => {
    const out = replaceSection(PLAN, heading, body);
    if ('error' in out) throw new Error(out.error);
    return out.text;
  };

  it('swaps only the text under one heading and keeps the others', () => {
    const out = swap('Review', 'Faye: numbers now sourced.');
    expect(out).toBe(PLAN.replace('Faye: weak numbers.', 'Faye: numbers now sourced.'));
  });

  it('takes the subsections along, up to the next heading of the same or a higher level', () => {
    const out = swap('## Research', 'Nils found four rivals.');
    expect(out).toContain('## Research\n\nNils found four rivals.\n\n## Review');
    expect(out).not.toContain('Sources');
  });

  it('replaces the last section to the end, and does not write the heading twice', () => {
    expect(swap('build', '## Build\n\nShip the stage.')).toBe(PLAN.replace('TBD\n', 'Ship the stage.\n'));
  });

  it('refuses a heading that is not there, listing the ones that are', () => {
    expect(replaceSection(PLAN, 'Pricing', 'x')).toEqual({ error: expect.stringMatching(/no heading "Pricing".*"Research".*append_doc/) });
    expect(replaceSection('## A\n\n1\n\n## A\n\n2', 'A', 'x')).toEqual({ error: expect.stringMatching(/more than one heading is called "A"/) });
  });
});
