import { describe, expect, it } from 'vitest';
import { alignToScript, nearestPhrase, phrasesIn, timeWords, type Word } from './timings.ts';

const heard = (rows: [string, number, number][]): Word[] => rows.map(([word, at, end]) => ({ word, at, seconds: end - at }));

describe('putting the measured times onto the words that were really said', () => {
  // These are the real numbers whisper gave back for a real Kokoro recording of this line. It mis-heard the last
  // word — "built" came back as "build" — which is exactly why the transcript is used only for its times.
  const measured = heard([
    ['Investors', 0.41, 1.01], ['do', 1.01, 1.23], ['not', 1.23, 1.39], ['fund', 1.58, 2.01], ['ideas.', 2.01, 3.02],
    ['They', 3.22, 3.25], ['fund', 3.43, 3.48], ['evidence', 3.48, 3.95], ['that', 3.95, 4.18], ['somebody', 4.18, 4.65],
    ['actually', 4.65, 5.12], ['wants', 5.12, 5.31], ['this', 5.40, 5.54], ['thing', 5.54, 6.02], ['you', 6.02, 6.10],
    ['build.', 6.10, 6.64],
  ]);
  const script = 'Investors do not fund ideas. They fund evidence that somebody actually wants this thing you built.'.split(' ');

  it('keeps the script\'s own words and the recording\'s own times', () => {
    const lined = alignToScript(measured, script);
    expect(lined).toHaveLength(script.length);
    expect(lined.map((one) => one.word)).toEqual(script);
    expect(lined[0]).toMatchObject({ word: 'Investors', at: 0.41 });
    // The word whisper got wrong keeps the script's spelling and the recording's timing.
    expect(lined.at(-1)).toMatchObject({ word: 'built.', at: 6.10 });
  });

  it('puts a word nothing heard back where it must have been', () => {
    const dropped = measured.filter((one) => one.word !== 'actually');
    const lined = alignToScript(dropped, script);
    expect(lined.map((one) => one.word)).toEqual(script);
    const missing = lined[10];
    expect(missing.word).toBe('actually');
    // Between the word before it and the word after it, and nowhere else.
    expect(missing.at).toBeGreaterThanOrEqual(lined[9].at);
    expect(missing.at + missing.seconds).toBeLessThanOrEqual(lined[11].at + 0.01);
  });

  it('ignores a word that was heard and never said', () => {
    const extra = [...measured.slice(0, 3), { word: 'um', at: 1.39, seconds: 0.12 }, ...measured.slice(3)];
    const lined = alignToScript(extra, script);
    expect(lined.map((one) => one.word)).toEqual(script);
    expect(lined[3]).toMatchObject({ word: 'fund', at: 1.58 });
  });

  it('never goes backwards, whatever it was handed', () => {
    const lined = alignToScript(measured, script);
    for (let at = 1; at < lined.length; at += 1) expect(lined[at].at).toBeGreaterThanOrEqual(lined[at - 1].at);
    expect(alignToScript([], script)).toEqual([]);
    expect(alignToScript(measured, [])).toEqual([]);
  });

  it('falls back to spreading the words over the sentence when nothing could be measured', async () => {
    const parts = [{ text: 'Investors do not fund ideas.', seconds: 3 }];
    const guessed = await timeWords(null, null, parts);
    expect(guessed.how).toBe('guessed');
    expect(guessed.words).toHaveLength(5);
    expect(guessed.words[0].at).toBe(0);
    // A binary that answers nothing is the same as no binary at all: the film is still made.
    const broken = await timeWords('/nowhere/hyperframes', '/nowhere/say.wav', parts);
    expect(broken.how).toBe('guessed');
  });
});

describe('where the speaker stops', () => {
  const words = heard([
    ['Investors', 0.0, 0.5], ['want', 0.5, 0.8], ['proof.', 0.8, 1.3],
    ['Not', 1.7, 2.0], ['ideas.', 2.0, 2.6],
    ['Show', 3.2, 3.5], ['them', 3.5, 3.7], ['one', 3.7, 3.9], ['number.', 3.9, 4.6],
  ]);

  it('breaks on the breath and on the full stop, never inside a thought', () => {
    const phrases = phrasesIn(words);
    expect(phrases).toHaveLength(3);
    expect(phrases[0]).toMatchObject({ at: 0, from: 0, to: 3 });
    expect(phrases[1].at).toBe(1.7);
    expect(phrases[2].at).toBe(3.2);
  });

  it('pulls a cut onto the nearest boundary it can reach, and leaves it where it is otherwise', () => {
    const phrases = phrasesIn(words);
    // A cut asked for at 1.55 belongs on the end of the first thought, a fifth of a second away.
    expect(nearestPhrase(phrases, 1.55)).toBe(1.7);
    // A cut asked for in the middle of the last sentence has no boundary within reach, and says so rather than
    // handing back the moment it was asked about.
    expect(nearestPhrase(phrases, 4.0)).toBeNull();
    expect(nearestPhrase([], 2.2)).toBeNull();
  });
});
