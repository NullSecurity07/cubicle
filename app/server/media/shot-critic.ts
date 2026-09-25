import type { Finding, Want } from './critic.ts';
import { dealMoves, dealShots, LENS_OF, moveOf, stillOf, takesMove, type Size } from './moves.ts';
import type { Spec } from './spec.ts';
import type { Pack } from './templates/packs.ts';

// The camera.
//
// How each picture is taken: its size, its lens and what the camera does. A storyboard may say any of these or none
// of them; the studio deals what it leaves out. What it did say is read against four rules, all of which can be put
// right here without asking anybody, and every one put right is said on the card.
//
//   1. Three pictures in a row the same size is one shot held three times. The third is re-dealt.
//   2. A close-up on a wide lens bends what is close to it; an extreme wide on a long lens cannot take in a place.
//   3. A move the studio does not know is dropped and dealt again; a move only a real clip can make, asked of a
//      still, becomes the nearest move a still can make.
//   4. Two neighbours making the same move is one move made twice. The second is dealt again.

const SIZE_WORDS: Record<Size, string> = { ecu: 'extreme close-up', cu: 'close-up', mcu: 'medium close-up', ms: 'medium', ws: 'wide', ews: 'extreme wide' };
// The size a run of one size is broken with: from far to near, and from near to far.
const BREAK: Record<Size, Size> = { ecu: 'ws', cu: 'ws', mcu: 'ws', ms: 'cu', ws: 'cu', ews: 'mcu' };
// "a orbit" is not English.
const article = (word: string) => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);

export function criticiseShots(spec: Spec, _want?: Want): Finding[] {
  const found: Finding[] = [];
  const say = (rule: string, says: string, scene?: number) => found.push({ rule, says, scene });
  const scenes = spec.scenes;
  const shown = scenes.map((scene, index) => ({ scene, index })).filter(({ scene }) => takesMove(scene.layout));
  shown.forEach(({ scene, index }, order) => {
    const at = index + 1;
    const before = shown.slice(Math.max(0, order - 2), order).map((one) => one.scene.shot);
    if (scene.shot && before.length === 2 && before.every((one) => one === scene.shot)) {
      say('sizes', `scenes ${shown[order - 2].index + 1} to ${at} are all ${SIZE_WORDS[scene.shot]} shots — a film cuts between sizes`, at);
    }
    if ((scene.shot === 'cu' || scene.shot === 'ecu') && (scene.lens === 24 || scene.lens === 35)) {
      say('lens', `scene ${at} is a ${SIZE_WORDS[scene.shot]} on a ${scene.lens}mm lens, which bends whatever is close to it`, at);
    }
    if (scene.shot === 'ews' && scene.lens === 135) say('lens', `scene ${at} is an extreme wide on a 135mm lens, which cannot take in a place`, at);
  });
  scenes.forEach((scene, index) => {
    const at = index + 1;
    if (!scene.move || !takesMove(scene.layout)) return;
    const move = moveOf(scene.move);
    if (!move) { say('move', `scene ${at} asks the camera to "${scene.move}", which is not a move the studio knows`, at); return; }
    if (takesMove(scene.layout) === 'still' && move.kind === 'motion') say('move', `scene ${at} is a still, and a still cannot ${move.name === 'handheld' ? 'be handheld' : `make ${article(move.name)}`}`, at);
    const last = index > 0 ? moveOf(scenes[index - 1].move) : undefined;
    if (last && last.name === move.name && takesMove(scenes[index - 1].layout)) say('move', `scenes ${index} and ${at} both ${move.name === 'static' ? 'stand still' : `make ${article(move.name)}`}`, at);
  });
  return found;
}

// The four rules done rather than said, and every blank dealt. Nothing here asks anybody anything.
export function mendShots(spec: Spec, want: Pick<Want, 'pace'> & { look?: Pack }): { spec: Spec; notes: string[] } {
  const notes: string[] = [];
  const note = (line: string) => { if (!notes.includes(line)) notes.push(line); };
  // A move on a scene that has no picture of its own to move is nothing, and goes quietly.
  let scenes = spec.scenes.map((one) => (one.move && !takesMove(one.layout) ? { ...one, move: undefined } : { ...one }));

  // 1. Sizes: a third in a row is broken, and its lens goes with it, because the lens belonged to the size.
  const shown = scenes.map((scene, index) => ({ scene, index })).filter(({ scene }) => takesMove(scene.layout));
  shown.forEach(({ index }, order) => {
    const size = scenes[index].shot;
    if (!size || order < 2) return;
    const [a, b] = [scenes[shown[order - 2].index].shot, scenes[shown[order - 1].index].shot];
    if (a !== size || b !== size) return;
    const next = BREAK[size];
    scenes[index] = { ...scenes[index], shot: next, lens: LENS_OF[next] };
    note(`three pictures in a row were ${SIZE_WORDS[size]} shots, so scene ${index + 1} is ${article(SIZE_WORDS[next])} instead`);
  });
  scenes = dealShots(scenes);

  // 2. Lenses that fight their size.
  scenes = scenes.map((scene, index) => {
    if ((scene.shot === 'cu' || scene.shot === 'ecu') && (scene.lens === 24 || scene.lens === 35)) {
      note(`scene ${index + 1} was a close shot on a wide lens, which bends whatever is near it, so it is taken on an 85`);
      return { ...scene, lens: 85 };
    }
    if (scene.shot === 'ews' && scene.lens === 135) {
      note(`scene ${index + 1} was an extreme wide on a long lens, which cannot take in a place, so it is taken on a 35`);
      return { ...scene, lens: 35 };
    }
    return scene;
  });

  // 3. Moves the studio does not know, and moves a still cannot make.
  scenes = scenes.map((scene, index) => {
    if (!scene.move) return scene;
    const move = moveOf(scene.move);
    if (!move) {
      note(`scene ${index + 1} asked the camera to "${scene.move}", which is not a move the studio knows, so it is given one that is`);
      return { ...scene, move: undefined };
    }
    if (takesMove(scene.layout) === 'still' && move.kind === 'motion') {
      const still = stillOf(move.name)!;
      note(`scene ${index + 1} is a still, and only a real clip can ${move.name === 'handheld' ? 'be handheld' : `make ${article(move.name)}`}, so it ${still.name === 'static' ? 'holds still' : `makes ${article(still.name)}`} instead`);
      return { ...scene, move: still.name };
    }
    // A still move the clip model does not read well is left to the deal, quietly: the clip is still made.
    if (takesMove(scene.layout) === 'motion' && move.kind === 'still' && !move.wanReads) return { ...scene, move: undefined };
    return { ...scene, move: move.name };
  });

  // 4. The same move twice running: the second is dealt again.
  for (let index = 1; index < scenes.length; index += 1) {
    const [before, now] = [scenes[index - 1].move, scenes[index].move];
    if (!now || now !== before) continue;
    note(`scenes ${index} and ${index + 1} made the same move, so the second is given another`);
    scenes[index] = { ...scenes[index], move: undefined };
  }
  scenes = dealMoves(scenes, spec.pace ?? want.pace, spec.pack ?? want.look);
  return { spec: { ...spec, scenes }, notes };
}
