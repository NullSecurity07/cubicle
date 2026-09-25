import { describe, expect, it } from 'vitest';
import { capLines, type Word } from '../templates/captions.ts';
import { captionPiece } from './index.ts';

// The pill item run for real, in a stand-in for the page: every element it makes is kept, and every step of its
// timeline is written down, so what a viewer would see can be read back without a browser.
type El = { id: string; textContent: string; style: Record<string, string>; className: string; children: El[]; appendChild: (child: El) => void; getContext: () => unknown };
function runPill(script: string) {
  const byId = new Map<string, El>();
  const made: El[] = [];
  const element = (): El => {
    const el: El = {
      id: '', textContent: '', style: {}, className: '', children: [],
      appendChild(child) { this.children.push(child); if (child.id) byId.set(child.id, child); },
      getContext: () => ({ font: '', measureText: (text: string) => ({ width: text.length * 30 }) }),
    };
    made.push(el);
    return el;
  };
  const stage = element();
  stage.id = 'caption-stage';
  byId.set('caption-stage', stage);
  const document = {
    createElement: () => element(),
    getElementById: (id: string) => byId.get(id) ?? made.find((one) => one.id === id) ?? null,
  };
  const steps: { what: string; target: El; vars: Record<string, unknown>; at: number }[] = [];
  const tl = {
    set(target: El, vars: Record<string, unknown>, at: number) { steps.push({ what: 'set', target, vars, at }); return tl; },
    to(target: El, vars: Record<string, unknown>, at: number) { steps.push({ what: 'to', target, vars, at }); return tl; },
    fromTo(target: El, _from: unknown, vars: Record<string, unknown>, at: number) { steps.push({ what: 'fromTo', target, vars, at }); return tl; },
  };
  const gsap = { timeline: () => tl };
  new Function('document', 'gsap', 'window', `${script}\nregistryCaptions();`)(document, gsap, {});
  const groups = made.filter((one) => one.className === 'caption-group');
  const wordsOf = (group: El): string[] => group.children[0].children[0].children.flatMap((line) => line.children.map((word) => word.textContent));
  const hidden = (group: El) => steps.filter((one) => one.target === group && one.what === 'set' && one.vars.opacity === 0).map((one) => one.at);
  return { groups: groups.map((group) => ({ words: wordsOf(group), gone: Math.max(...hidden(group)) })) };
}

const band = { left: 64, bottom: 80, width: 1100, size: 80 };
const theme = { ink: '#FFFFFF', signal: '#E8B04B', ground: '#1C2530', display: "'Studio Sans', sans-serif", body: "'Studio Sans', sans-serif" };
const say = (text: string, from = 0.3, each = 0.36): Word[] => text.split(' ').map((word, at) => ({ word, at: from + at * each, seconds: each - 0.06 }));

describe('the pill caption track', () => {
  it('keeps the script\'s own casing: "AI" is never set as "ai"', () => {
    const words = say('A small team of AI people works beside you.');
    const lines = capLines(words, 26, 3);
    const { groups } = runPill(captionPiece('pill', lines, 6, band, theme, 3).script);
    const shown = groups.flatMap((one) => one.words);
    expect(shown).toContain('AI');
    expect(shown).not.toContain('ai');
    expect(shown[0]).toBe('A');
  });

  it('shows the lines the studio grouped, not a grouping of its own', () => {
    const words = say('Wires are access, so each person reads only what is wired to them.');
    const lines = capLines(words, 26, 3);
    const { groups } = runPill(captionPiece('pill', lines, 8, band, theme, 3).script);
    expect(groups.map((one) => one.words.join(' '))).toEqual(lines.map((line) => line.words.map((word) => word.word).join(' ')));
  });

  it('takes the last line off a beat after it is said, never holding it to the end of the film', () => {
    const words = say('Nothing leaves the machine. Research.');
    const lines = capLines(words, 26, 3);
    const lastSaid = words.at(-1)!.at + words.at(-1)!.seconds;
    const { groups } = runPill(captionPiece('pill', lines, 20, band, theme, 3).script);
    expect(groups.at(-1)!.gone).toBeLessThanOrEqual(lastSaid + 1);
    expect(groups.at(-1)!.gone).toBeGreaterThan(lastSaid);
  });
});
