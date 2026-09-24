import { describe, expect, it } from 'vitest';
import { VOICES } from '../server/media/voice.ts';
import { castable, guessGender, poolsOf, recast, type Speaker, voiceFor } from './voices.ts';

// People as the stage really holds them: an id that never changes and a name the founder typed.
const person = (id: string, name: string, more: Partial<Speaker> = {}): Speaker => ({ id, name, ...more });
const maya = person('marketing', 'Maya');
const dev = person('build', 'Dev');
const sam = person('room-a1b2c3', 'Sam');
// The stage as the app leaves it: each person's voice is written down the first time it is needed, in stage order.
const settle = (people: Speaker[]): Speaker[] =>
  people.reduce<Speaker[]>((done, one, at) => [...done, { ...one, voice: voiceFor(one, [...done, ...people.slice(at)], VOICES) }], []);

describe('the two pools', () => {
  it('are read off the voices the model came with', () => {
    const pools = poolsOf(VOICES);
    expect(pools.woman).toContain('af_heart');
    expect(pools.man).toContain('am_michael');
    expect(pools.woman).toContain('bf_emma');
    expect(pools.man).toContain('bm_fable');
    // Every voice is in one pool and no voice is in both, so nobody can be left unable to speak.
    expect(pools.woman.length + pools.man.length).toBe(VOICES.length);
    expect(pools.woman.filter((id) => pools.man.includes(id))).toEqual([]);
  });
});

describe('guessing from a name', () => {
  it('knows common given names from several places', () => {
    for (const name of ['Maya', 'Priya', 'Ananya', 'Sara', 'Emma', 'Fatima', 'Yuki']) expect(guessGender(name)).toBe('woman');
    for (const name of ['Arjun', 'Rahul', 'Dev', 'Michael', 'Omar', 'Diego', 'Kenji']) expect(guessGender(name)).toBe('man');
  });

  it('says nothing about a name that is genuinely either, or one it has never met', () => {
    for (const name of ['Sam', 'Alex', 'Kiran', 'Jordan', 'Noor', 'Ali', 'Devon']) expect(guessGender(name)).toBe('neither');
    for (const name of ['Vexil', 'Q', '', '   ']) expect(guessGender(name)).toBe('neither');
  });

  it('reads the given name out of however the founder wrote it', () => {
    expect(guessGender('  priya  ')).toBe('woman');
    expect(guessGender('Arjun Mehta')).toBe('man');
  });
});

describe('who speaks in which voice', () => {
  it('gives six people six different voices', () => {
    const six = settle([maya, dev, sam, person('r2', 'Priya'), person('r3', 'Rahul'), person('r4', 'Quill')]);
    expect(new Set(six.map((one) => one.voice)).size).toBe(6);
    for (const one of six) expect(VOICES.some((voice) => voice.id === one.voice)).toBe(true);
  });

  it('draws from the pool their gender says, and from both when it says neither', () => {
    const pools = poolsOf(VOICES);
    expect(pools.woman).toContain(voiceFor(maya, [maya], VOICES));
    expect(pools.man).toContain(voiceFor(dev, [dev], VOICES));
    expect([...pools.woman, ...pools.man]).toContain(voiceFor(sam, [sam], VOICES));
    // What the founder said outranks what the name suggests.
    expect(pools.man).toContain(voiceFor({ ...maya, gender: 'man' }, [maya], VOICES));
  });

  it('keeps a person on the same voice as others come and go', () => {
    const [saidMaya, saidDev, saidSam] = settle([maya, dev, sam]);
    // Somebody joins, somebody leaves, and everybody who was here sounds exactly as they did yesterday.
    const later = [saidMaya, saidSam, person('r9', 'Rohan'), person('r8', 'Ananya')];
    expect(voiceFor(saidMaya, later, VOICES)).toBe(saidMaya.voice);
    expect(voiceFor(saidSam, later, VOICES)).toBe(saidSam.voice);
    expect(voiceFor(saidDev, [saidDev], VOICES)).toBe(saidDev.voice);
    // And before anybody's voice has been written down, people arriving after them change nothing either.
    expect(voiceFor(dev, [maya, dev], VOICES)).toBe(voiceFor(dev, [maya, dev, sam, person('r7', 'Leo')], VOICES));
  });

  it('never takes back a voice the founder picked by hand', () => {
    const picked = { ...sam, voice: 'bm_fable' };
    expect(voiceFor(picked, [maya, dev, picked], VOICES)).toBe('bm_fable');
    // Even when it is nothing like the pool their gender draws from.
    expect(voiceFor({ ...maya, gender: 'woman', voice: 'am_michael' }, [maya], VOICES)).toBe('am_michael');
  });

  it('falls back cleanly when a saved voice is not a voice any more', () => {
    const gone = { ...maya, voice: 'af_someone_removed' };
    const given = voiceFor(gone, [gone, dev], VOICES);
    expect(poolsOf(VOICES).woman).toContain(given);
    expect(given).toBe(voiceFor(maya, [maya, dev], VOICES));
  });

  it('gives the best voices first, and never casts a woman below B- or a man outside the best three', () => {
    const gradeOf = (id: string) => VOICES.find((one) => one.id === id)!.grade;
    // The first woman on a stage is Heart, the one A in the model.
    expect(voiceFor(maya, [maya], VOICES)).toBe('af_heart');
    const crowd = settle(Array.from({ length: 12 }, (_, at) => person(`p${at}`, at % 2 ? 'Rahul' : 'Priya')));
    for (const one of crowd.filter((_, at) => at % 2 === 0)) expect(['A', 'A-', 'B-']).toContain(gradeOf(one.voice!));
    for (const one of crowd.filter((_, at) => at % 2 === 1)) expect(['am_fenrir', 'am_michael', 'am_puck']).toContain(one.voice);
    // Nobody shares until every good voice of their pool has been given once.
    expect(new Set(crowd.slice(0, 7).map((one) => one.voice)).size).toBe(7);
    // Somebody whose gender is not said draws from both good pools.
    for (const one of settle([sam, person('q', 'Quill'), person('z', 'Zed')])) expect(castable(one.voice, 'neither', VOICES)).toBe(true);
  });

  it('casts the same person the same voice every time', () => {
    const stage = [maya, dev, sam, person('r2', 'Priya'), person('r3', 'Rahul')];
    const once = settle(stage).map((one) => one.voice);
    expect(settle(stage).map((one) => one.voice)).toEqual(once);
    // Among voices as good as each other, the id decides, not the order of the list the voices came in.
    expect(voiceFor(dev, [dev], [...VOICES].reverse())).toBe(voiceFor(dev, [dev], VOICES));
  });

  it('still casts from a list that carries no grades', () => {
    const bare = VOICES.map(({ id, name }) => ({ id, name }));
    expect(poolsOf(bare).woman).toContain(voiceFor(maya, [maya], bare));
  });
});

describe('casting again under the stricter rule', () => {
  it('recasts a voice the app cast below the floor, and leaves the founder\'s own pick alone', () => {
    const rooms = [
      { ...maya, gender: 'woman' as const, voice: 'af_kore' },
      { ...dev, voice: 'am_eric', voiceBy: 'cast' as const },
      { ...sam, voice: 'bm_lewis', voiceBy: 'founder' as const },
      { ...person('r2', 'Priya'), voice: 'bf_emma' },
      person('r3', 'Rohan'),
    ];
    const { rooms: after, changed } = recast(rooms, VOICES);
    expect(changed.map((one) => one.name)).toEqual(['Maya', 'Dev']);
    expect(after[0]).toMatchObject({ voice: 'af_heart', voiceBy: 'cast' });
    expect(['am_fenrir', 'am_michael', 'am_puck']).toContain(after[1].voice);
    // The founder picked Lewis by hand; a good cast voice stays; somebody never cast is left to be cast when asked.
    expect(after[2]).toEqual(rooms[2]);
    expect(after[3]).toEqual(rooms[3]);
    expect(after[4]).toEqual(rooms[4]);
    // A second start changes nothing.
    expect(recast(after, VOICES).changed).toEqual([]);
  });
});
