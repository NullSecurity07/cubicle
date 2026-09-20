import { describe, expect, it } from 'vitest';
import { orderedClips, type Clip, type Clips, type Help } from './clips.ts';
import { fakeLocalPerson, localPerson, MOST_MINUTES, personPrompt } from './local-person.ts';
import { onCamera } from './director.ts';
import type { Scene, Understanding } from './video.ts';

// Somebody on camera. The founder drew a person, wired it up, asked for a reel with a real face and got a
// photograph, because every route that could animate a picture had said no and nothing else was tried.

const help = (said: string[] = []): Help => ({ report: (line) => said.push(line) });
const clip = (name: string): Clip => ({ ext: 'mp4', bytes: Buffer.from(name) });
const backend = (name: string, over: Partial<Clips> = {}): Clips => ({
  ready: () => null,
  broll: async () => clip(`${name}-broll`),
  presenter: async () => clip(`${name}-person`),
  ...over,
});

describe('who the person on camera is', () => {
  it('asks for the framing first and the picture\'s own words after it', () => {
    // A video model handed "an influencer" alone draws a wide shot of a room with somebody in it.
    const said = personPrompt('image of influencer talking abt what investors look for in a new company');
    expect(said.indexOf('facing the camera')).toBeLessThan(said.indexOf('influencer'));
    expect(said).toContain('influencer');
    expect(said).toContain('talking');
    // "a picture of" is how the card describes it to itself, not something to draw.
    expect(personPrompt('a picture of a woman in a red coat')).not.toMatch(/a picture of/);
    // Nothing known about them is still somebody, rather than nobody.
    expect(personPrompt()).toContain('seen from the waist up');
  });
});

describe('the order a moving person is asked for in', () => {
  it('asks the free service first and this machine second, the other way round from b-roll', async () => {
    // Only the Spaces can make the founder's own picture speak, so they go first; b-roll has no particular face to
    // keep, so it is made here where it is unlimited.
    const online = backend('online');
    const here = backend('here');
    const clips = orderedClips({ broll: [here, online], presenter: [online, here] });
    expect((await clips.broll({ prompt: 'x', seconds: 3 }, help())).bytes.toString()).toBe('here-broll');
    expect((await clips.presenter({ portrait: Buffer.of(1), speech: Buffer.of(1) }, help())).bytes.toString()).toBe('online-person');
  });

  it('draws them in the shape of the film, so their hands are not cut off at the sides', async () => {
    // The shape has to reach the renderer, or a phone reel gets a wide clip with its middle cut out.
    let asked: string | undefined;
    const here = backend('here', { broll: async (ask) => { asked = ask.shape; return clip('here-broll'); } });
    await here.presenter({ portrait: Buffer.of(1), speech: Buffer.of(1), shape: 'tall' }, help());
    const person = localPerson({ env: {} as NodeJS.ProcessEnv, clips: here });
    await person.presenter({ portrait: Buffer.of(1), speech: Buffer.of(1), shape: 'tall' }, help());
    expect(asked).toBe('tall');
  });

  it('draws the person here when the free service has nothing left', async () => {
    const spent = backend('online', { presenter: async () => { throw new Error('today\'s free GPU minutes are used up'); } });
    const clips = orderedClips({ broll: [], presenter: [spent, backend('here')] });
    expect((await clips.presenter({ portrait: Buffer.of(1), speech: Buffer.of(1) }, help())).bytes.toString()).toBe('here-person');
  });

  it('says what it is about to cost before anybody waits for it', async () => {
    const said: string[] = [];
    await fakeLocalPerson.presenter({ portrait: Buffer.of(1), speech: Buffer.of(1) }, help(said));
    expect(said.join(' ')).toMatch(/drawing the person moving on this computer — about \d+ minutes/);
  });
});

describe('what a film will spend on people', () => {
  it('stops after a few scenes rather than making a founder wait an hour', async () => {
    const said: string[] = [];
    const person = localPerson({ env: {} as NodeJS.ProcessEnv, clips: backend('here') });
    const ask = { portrait: Buffer.of(1), speech: Buffer.of(1) };
    // Every scene costs minutes, and a film of them is an afternoon.
    let made = 0;
    let stopped = '';
    for (let scene = 0; scene < 8; scene += 1) {
      try { await person.presenter(ask, help(said)); made += 1; } catch (error) { stopped = (error as Error).message; break; }
    }
    expect(made).toBeGreaterThan(0);
    expect(made * 3).toBeLessThanOrEqual(MOST_MINUTES);
    expect(stopped).toContain('as long as it goes');
  });
});

describe('one person to a film', () => {
  const person = (): Understanding => ({
    purpose: 'reel', audience: 'founders', platform: 'a phone', shape: 'tall', seconds: 15, pace: 'punchy',
    tone: 'friendly', mood: 'upbeat', pack: 'creator', person: true, captions: true, said: '',
  });

  it('marks every on-camera scene, so none of them lends its face to the scenes beside it', () => {
    // A portrait drawn for one of these used to be shared down its whole run, and five scenes of a reel sat on a
    // close-up of somebody who was not even the film's presenter.
    const six = Array.from({ length: 6 }, (_one, index): Scene => ({ layout: 'statement', text: `Line ${index}`, say: `Line ${index}.` }));
    const made = onCamera(six, person(), 'warm daylight', () => {}, { minutes: 3 });
    const faces = made.filter((one) => one.person);
    expect(faces.length).toBeGreaterThan(1);
    for (const one of faces) expect(one.person).toBe(true);
    // And everything that is not on camera is left to be about its own subject.
    expect(made.filter((one) => !one.person).every((one) => !one.bg_prompt?.includes('facing the camera'))).toBe(true);
  });
});
