import { join } from 'node:path';
import { blankness, isBlank, liftFor, lighten, meanLight, scrimFor } from './contrast.ts';
import { SUBJECT_PRESENT } from './picture-policy.ts';
import { ASKS, facesLens, fault, isLettered, type Plies, type Sight } from './sight.ts';
import type { Scene } from './spec.ts';
import { PACK, type Pack } from './templates/index.ts';
import { liesDown, redrawnFor, uprightFor, type Visual } from './visuals.ts';

// What happens to one picture between arriving and going on screen, for a new film and for a film remade from
// notes alike. It used to live inside the first render only, so a remake in a new look redrew every picture with
// nobody checking it for a stranger staring down the lens, no lift for a graded look and no planes for parallax:
// the same note made a film that was quietly worse than a fresh one.

// A finished picture: the file to show, the visual that really produced it — which is the redrawn one when the
// second drawing was kept, so a later remake draws from the words that did not summon the stranger — and what the
// page needs to set words over it.
export type Finished = { file: string; visual: Visual; hold?: number; lift?: number; plies?: Plies };

// What one film's pictures share while they are finished: how many have been drawn a second time, and which
// faults the card has already been told about.
export type Looking = { redrawn: number; told: Set<string>; absent?: number; posed?: number };
export const looking = (): Looking => ({ redrawn: 0, told: new Set(), absent: 0 });

// Twice a film at most: a redraw is most of a minute, and a studio that doubts every picture it draws is a studio
// that takes twice as long to make the same film.
export const REDRAWS = 2;
// A drawn picture that does not show its own scene's things is drawn once more, closer, up to this many a film. It
// is its own count, so a stranger at the lens in one picture never spends the redraw an empty corridor needed.
export const ABSENT_REDRAWS = 3;
// A drawn picture seen as somebody lying on the floor, under a line that has nobody lying down, is drawn once more
// standing up, up to this many a film.
export const POSE_REDRAWS = 2;

export async function finishPicture(one: {
  // The folder the picture sits in, and its name there.
  dir: string; file: string;
  visual: Visual; scene: Scene; pack: Pack; paint: { quiet: string; ground: string };
  sight?: Sight; state: Looking; stop?: AbortSignal; report: (line: string) => void;
  // Draws the visual again and hands back the new file's name in the same folder. Without one nothing is redrawn.
  redraw?: (again: Visual) => Promise<string>;
  // What a drawn picture must be seen to show (`seenAs`), and the visual it is drawn again from when it does not.
  // A photograph has already been looked at before it was taken, and goes without.
  subject?: { label: string; closer: Visual };
}): Promise<Finished> {
  const { dir, visual, scene, pack, paint, sight, state, stop } = one;
  let file = one.file;
  let kept = visual;
  // First, whether there is anything in it at all. A frame of plain white or plain black is drawn once more, and
  // if that one is blank too, no picture goes on screen: the scene sits on the look's own ground with its words,
  // which is a designed frame, where a white sheet is a hole. This redraw is not one of the film's two, because a
  // blank picture is not a picture with a fault in it — it is no picture.
  if (isBlank(await blankness(join(dir, file)))) {
    if (!one.redraw || stop?.aborted) throw new Error('the picture came back blank, so the scene sits on the look with its words');
    const second = await one.redraw(visual);
    if (isBlank(await blankness(join(dir, second)))) throw new Error('the picture came back blank twice, so the scene sits on the look with its words');
    file = second;
    if (!state.told.has('blank')) { state.told.add('blank'); one.report('a picture came back blank, so it was drawn again'); }
  }
  // The picture is looked at before it is used. Every rule this studio has about a picture — nobody staring down
  // the lens, no writing — was only ever applied to the sentence the picture was asked for with, and a picture
  // model does what it likes: a proof film came back with two strangers looking straight at the viewer and a
  // sheet of handwriting. One that breaks a rule is drawn once more, as a place rather than a person and from
  // further off, and the better of the two is kept.
  const seen = await sight?.look(join(dir, file)).catch(() => null);
  if (fault(seen) > 0 && !stop?.aborted && state.redrawn < REDRAWS && one.redraw) {
    state.redrawn += 1;
    const why = facesLens(seen) ? 'somebody looking straight at the camera' : 'writing on it';
    const again = redrawnFor(visual, { face: facesLens(seen) });
    try {
      const second = await one.redraw(again);
      const better = fault(await sight?.look(join(dir, second)).catch(() => null)) < fault(seen);
      if (better) { file = second; kept = again; }
      if (!state.told.has(why)) { state.told.add(why); one.report(`a picture came back with ${why}, so it was drawn again${isLettered(seen) && facesLens(seen) ? ' without either' : ''}`); }
    } catch { /* the first picture stands: a film with a face in it beats a film with a hole in it */ }
  }
  // Then whether it is of its scene at all. A picture model handed "a busy dental front desk phone flashing red"
  // drew an empty clinic corridor, which no rule about faces or writing catches. The studio's eyes score the
  // picture against the scene's own things and a few generic pictures; under the line it is drawn once more, closer
  // on the thing, and the better of the two by the same score is kept.
  if (one.subject && sight?.about && one.redraw && !stop?.aborted && (state.absent ?? 0) < ABSENT_REDRAWS) {
    const present = await sight.about(join(dir, file), one.subject.label).catch(() => null);
    if (present !== null && present < SUBJECT_PRESENT) {
      state.absent = (state.absent ?? 0) + 1;
      try {
        const second = await one.redraw(one.subject.closer);
        const after = await sight.about(join(dir, second), one.subject.label).catch(() => null);
        if (after !== null && after > present) { file = second; kept = one.subject.closer; }
        one.report(`scene ${visual.scene + 1}: the picture did not show ${one.subject.label.replace(/^a photograph of /, '')} (${present.toFixed(2)}), so it was drawn again closer${after !== null ? ` (${after.toFixed(2)})` : ''}`);
      } catch { /* the first picture stands */ }
    }
  }
  // And whether anybody in it is lying on the floor when the line has nobody lying down. Journey 17's night-shift
  // nurse lay on a staff-room floor beside two plates under "night-shift nurses eat badly", which no rule about the
  // scene's own things catches: she was a nurse, and there were meals. The studio's eyes score the picture as its
  // scene against "a person lying on the floor"; nearer the second, it is drawn again standing, and the one less
  // like somebody lying down is kept.
  if (one.subject && sight?.versus && one.redraw && !stop?.aborted && (state.posed ?? 0) < POSE_REDRAWS
    && !liesDown(`${visual.line} ${visual.about ?? ''}`)) {
    const labels = [one.subject.label, ASKS.lying];
    const before = await sight.versus(join(dir, file), labels).catch(() => null);
    if (before && before[1] > before[0]) {
      state.posed = (state.posed ?? 0) + 1;
      const again = uprightFor(kept);
      try {
        const second = await one.redraw(again);
        const after = await sight.versus(join(dir, second), labels).catch(() => null);
        if (!after || after[1] < before[1]) { file = second; kept = again; }
        one.report(`scene ${visual.scene + 1}: the picture had somebody lying on the floor (${before[1].toFixed(2)}), so it was drawn again standing${after ? ` (${after[1].toFixed(2)})` : ''}`);
      } catch { /* the first picture stands */ }
    }
  }
  const path = join(dir, file);
  // A graded look over a picture that came back dark is how "dim and murky" happens. The shadows are raised in the
  // file itself, before anything measures it, so the scrim is solved against the picture a viewer will really
  // see; the gain in the page is only for a machine that could not rewrite it.
  const raised = PACK[pack].format?.grade ? await lighten(path).catch(() => null) : null;
  // …and where the look moves through its stills, the still is cut into the planes it moves.
  const plies = PACK[pack].parallax ? await sight?.plies(path).catch(() => null) : null;
  const big = scene.layout === 'hook' || scene.layout === 'stat' || scene.layout === 'title';
  // How hard the picture has to be held down for the words on it to be read, measured off the picture itself
  // where the words really sit — so a white wall gets a wash and a dark doorway gets almost nothing. The scrim is
  // solved for the *weakest* colour on the frame rather than the strongest: a line of support copy is set in the
  // quiet tone, and a wash that clears the headline leaves that line floating, which is what "grey list text" was.
  const hold = await scrimFor(path, visual.room === 'top' ? 'top' : 'foot', paint.quiet, paint.ground,
    { big, floor: PACK[pack].scrim * 0.35 }).catch(() => null);
  const light = PACK[pack].format?.grade && !raised ? await meanLight(path).catch(() => null) : null;
  return { file, visual: kept, hold: hold ?? undefined, lift: light === null ? undefined : liftFor(light), plies: plies ?? undefined };
}
