import { describe, expect, it } from 'vitest';
import { editFilm, cuttingFor, LONGEST_PICTURE, type Take } from './editor.ts';
import { productFacts } from './grounding.ts';
import { choosePhoto, closerFor, groundedFor, namesTwo, PHOTO_AGREES, picturePolicy, sceneThings, seenAs, type Listed } from './picture-policy.ts';
import type { Word } from './timings.ts';
import { shareOut, worldOf, type Visual } from './visuals.ts';

// Journey 16: "20 s explainer about our meal-prep delivery", for night-shift nurses, a weekly box of five meals.
const facts = 'ShiftMeals is a weekly meal-prep delivery for night-shift nurses. Hospital canteens close when the night shift begins. '
  + 'Five ready meals in a labelled box are delivered to the hospital staff entrance on Sunday evening.';
const ask = '20 s explainer about our meal-prep delivery';
const world = worldOf(ask, productFacts(facts));
const shot = (line: string, subject = ''): Visual => ({ scene: 0, take: 0, at: 0, line, subject, kind: 'medium', room: 'foot' } as Visual);
const canteens = shot('Hospital canteens close when your night shift begins.', 'A dark hospital hallway with a locked canteen door');
const meals = shot('Get five ready meals delivered to the staff entrance.', 'Five fresh ready meals handed over at the staff entrance');

// The three photographs Journey 16 put on screen, by their own titles.
const GRACE: Listed = { id: 'openverse-photo-569dbb20', what: "shepherd's family saying grace meal animal art building cat dog hospital person plant" };
const CAMPFIRE: Listed = { id: 'openverse-photo-c81685c9', what: 'Two people seated sofa campfire camper campfire camping furniture camping meals couple night camp couple silhouette people campfire person photo' };
const JAR: Listed = { id: 'openverse-photo-a6767718', what: 'Meal Prep (44260861320)' };
const NURSE: Listed = { id: 'openverse-photo-nurse', what: 'Nurse opening a meal box in a hospital break room at night' };

// A library that answers every query with the first of its photographs that fits, and eyes that see what they are told.
const library = (shelf: Listed[]) => {
  const asked: string[] = [];
  return {
    asked,
    take: async (query: string, fits: (one: Listed) => boolean) => {
      asked.push(query);
      const one = shelf.find(fits);
      return one ? { found: one } : null;
    },
  };
};
const eyes = (scores: Record<string, number | null>) => async (one: { found: Listed }) => scores[one.found.id] ?? null;

describe('which pictures come first', () => {
  it.each([
    ['20 s explainer about our meal-prep delivery', 'drawn-first'],
    ['a 30 second explainer about voicemail chaos at a dental practice front desk', 'drawn-first'],
    ['a launch video for our app', 'drawn-first'],
    ['a pitch film for investors about ShiftMeals', 'drawn-first'],
    ['a 20 second documentary clip about a pottery class, with real photographs', 'photo-first'],
    ['a documentary about farmers markets', 'photo-first'],
    ['a film about our kitchen with real footage of the cooks', 'photo-first'],
    ['b-roll of a busy hospital corridor', 'photo-first'],
    ['use stock photos of nurses for our ad', 'photo-first'],
  ])('%s is %s', (brief, policy) => {
    expect(picturePolicy(brief)).toBe(policy);
  });
});

describe('a photograph in a film drawn first', () => {
  it("names the scene's own things of the world, and none of what is done or when", () => {
    expect(sceneThings(canteens, world)).toEqual(['hospital', 'canteens']);
    expect(sceneThings(meals, world)).toEqual(['meals', 'staff', 'entrance']);
    expect(sceneThings(shot('You decide.'), world)).toEqual([]);
    expect(seenAs(canteens, world)).toBe('a photograph of hospital and canteens');
  });

  it("refuses Journey 16's three photographs: two by their titles, the engraving by looking at it", async () => {
    // The campfire names meals and a night: a night is not a thing, so the title names one of the world's things.
    expect(namesTwo(CAMPFIRE.what, meals, world)).toBeNull();
    // "Meal Prep" alone is a jar of food anywhere: it names no second thing of this film.
    expect(namesTwo(JAR.what, meals, world)).toBeNull();
    // The engraving's tags say meal and hospital, which is two of the world's things…
    expect(namesTwo(GRACE.what, canteens, world)).toBe('meal');
    // …and the studio's eyes see an old engraving, not a hospital canteen (it scored 0.02 on the real file).
    const shelf = library([GRACE, CAMPFIRE, JAR]);
    const first = await choosePhoto({ policy: 'drawn-first', visual: canteens, world, used: new Set(), take: shelf.take, look: eyes({ [GRACE.id]: 0.02 }) });
    expect(first.photo).toBeNull();
    expect(first.line).toMatch(/^drawn: "shepherd's family saying grace .*" named 'hospital' \+ 'meal' and did not look like it \(0\.02\)$/);
    const second = await choosePhoto({ policy: 'drawn-first', visual: meals, world, used: new Set(), take: library([CAMPFIRE, JAR]).take, look: eyes({ [CAMPFIRE.id]: 0.9, [JAR.id]: 0.96 }) });
    expect(second.photo).toBeNull();
    expect(second.line).toBe("drawn: no photo matched 'meals' + 'staff'");
    expect(shelf.asked).toEqual(['hospital canteens', 'hospital meal']);
  });

  it('takes a photograph that names two of the world and looks like the scene, once a film', async () => {
    const used = new Set<string>();
    const nurse = shot('Five ready meals in a box for the nurse on the night shift.');
    const took = await choosePhoto({ policy: 'drawn-first', visual: nurse, world, used, take: library([NURSE]).take, look: eyes({ [NURSE.id]: 0.81 }) });
    expect(took.photo?.found.id).toBe(NURSE.id);
    expect(took.line).toBe(`photo: "Nurse opening a meal box in a hospital break room at night" names 'meals' + 'nurses', and it looks like the scene (0.81)`);
    const again = await choosePhoto({ policy: 'drawn-first', visual: nurse, world, used, take: library([NURSE]).take, look: eyes({ [NURSE.id]: 0.81 }) });
    expect(again.photo).toBeNull();
  });

  it('draws when the eyes cannot look, or the scene names nothing of the world', async () => {
    const nurse = shot('Five ready meals in a box for the nurse on the night shift.');
    const blind = await choosePhoto({ policy: 'drawn-first', visual: nurse, world, used: new Set(), take: library([NURSE]).take, look: async () => null });
    expect(blind.photo).toBeNull();
    expect(blind.line).toMatch(/the studio could not look at it$/);
    const shelf = library([NURSE]);
    const none = await choosePhoto({ policy: 'drawn-first', visual: shot('You decide.'), world, used: new Set(), take: shelf.take, look: eyes({}) });
    expect(none).toEqual({ photo: null, line: "drawn: the line names none of the film's own things" });
    expect(shelf.asked).toEqual([]);
    expect(PHOTO_AGREES).toBeGreaterThan(0.04);
  });

  it('draws from the scene and the world, and draws again closer on its things', () => {
    const bare = groundedFor(shot('Hospital canteens close when your night shift begins.', 'A locked door in a dark hallway'), { ...world, setting: 'at a city hospital' });
    expect(bare.subject).toBe('hospital and canteens, A locked door in a dark hallway, at a city hospital');
    expect(groundedFor(canteens, world)).toBe(canteens);
    const closer = closerFor(canteens, world);
    expect(closer.subject).toMatch(/^hospital and canteens, large and clear in the middle of the frame, A dark hospital hallway/);
    expect(closer.kind).toBe('medium');
  });
});

describe('a photograph in a documentary', () => {
  const pottery = worldOf('a 20 second documentary clip about a pottery class, with real photographs');
  const wheel = shot('Hands shape clay on a wheel.');
  const CLASS: Listed = { id: 'class', what: 'Pottery class, art class with clay, handmade pots and a pottery wheel' };
  it('is photographed first, held to the same eyes when they can look', async () => {
    const seen = await choosePhoto({ policy: 'photo-first', visual: wheel, world: pottery, topic: ['pottery', 'class'], used: new Set(), take: library([CLASS]).take, look: eyes({ class: 1 }) });
    expect(seen.photo?.found.id).toBe('class');
    const refused = await choosePhoto({ policy: 'photo-first', visual: wheel, world: pottery, topic: ['pottery', 'class'], used: new Set(), take: library([CLASS]).take, look: eyes({ class: 0.1 }) });
    expect(refused.photo).toBeNull();
    expect(refused.line).toMatch(/^drawn: "Pottery class.*" did not look like/);
    const blind = await choosePhoto({ policy: 'photo-first', visual: wheel, world: pottery, topic: ['pottery', 'class'], used: new Set(), take: library([CLASS]).take, look: async () => null });
    expect(blind.photo?.found.id).toBe('class');
  });
});

describe('how long one picture is on screen', () => {
  it('never shares one picture past six seconds, however few the film can afford', () => {
    // Journey 16: three scenes of four seconds under one jar of meal prep.
    expect(shareOut([4, 4, 4], 1)).toEqual([0, 1, 2]);
    expect(shareOut([2, 2, 2, 2, 2, 2], 1)).toEqual([0, 0, 0, 3, 3, 3]);
    expect(shareOut([3, 3, 3, 3], 2)).toEqual([0, 1, 1, 3]);
    const runs = (owners: number[], lengths: number[]) => owners.reduce<number[]>((all, one, at) => {
      if (at && owners[at - 1] === one) all[all.length - 1] += lengths[at]; else all.push(lengths[at]);
      return all;
    }, []);
    const lengths = [1.5, 2.2, 3.1, 1.8, 2.6, 4.4, 1.9, 2.5];
    for (const many of [1, 2, 3, 5]) expect(Math.max(...runs(shareOut(lengths, many), lengths))).toBeLessThanOrEqual(LONGEST_PICTURE);
  });

  it('cuts a twelve-second line into pictures of six seconds or less, payoff and all', () => {
    // One word every 0.42 s for twelve seconds, said over the payoff (the scene before the close).
    const words: Word[] = Array.from({ length: 29 }, (_one, at) => ({ word: at % 7 === 6 ? 'night.' : 'meals', at: 2 + at * 0.42, seconds: 0.4 }));
    const takes: Take[] = [
      { scene: { layout: 'hook', text: 'Canteens close', say: 'Canteens close.' }, index: 0, from: 0, to: 2 },
      { scene: { layout: 'statement', text: 'Weekly meals', say: 'meals' }, index: 1, from: 2, to: 14 },
      { scene: { layout: 'cta', text: 'ShiftMeals', say: 'ShiftMeals.' }, index: 2, from: 14, to: 16 },
    ];
    for (const pack of ['clean', 'editorial', 'documentary'] as const) {
      const edit = editFilm(takes, words, cuttingFor(pack, 'calm'));
      const payoff = edit.shots.filter((one) => one.scene === 1);
      expect(payoff.length, pack).toBeGreaterThanOrEqual(2);
      for (const one of payoff) expect(one.seconds, pack).toBeLessThanOrEqual(LONGEST_PICTURE + 0.01);
    }
  });
});
