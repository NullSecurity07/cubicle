import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { Shape } from '../../shared/model.ts';
import { CHROMES } from '../browser.ts';
import { projectDir } from '../folder.ts';
import { createLibrary } from '../library/notes.ts';
import { musicBed, MOODS, SFX_DIR, sfxFile, type Mood } from './audio.ts';
import { type Credit, type Mood as MusicMood } from './music.ts';
import { noClips } from './clips.ts';
import { closesOnGround, headlineOf, mendShots, repair, trimTo, type Want } from './critic.ts';
import { lensPhrase } from './moves.ts';
import { finishPicture, looking } from './finish.ts';
import { hands } from './turns.ts';
import type { Sight } from './sight.ts';
import {
  bibleFor, direct, faceIn, fitLength, layoutsFor, NO_FACE_HINT, narratorWanted, onCamera, photograph, readBrief, tellOf, understandingOf,
  type Asked, type Understanding,
} from './director.ts';
import { checkCut, cuttingFor, editFilm, takesOf, type Edit, type Shot as Cut, type Take } from './editor.ts';
import { ff, ffReady, FFMPEG } from './ff.ts';
import { fitStill, normalise } from './footage.ts';
import { DRAWN_BEFORE, mayDrawHere, outOfPictures } from './image.ts';
import type { Maker, Piece } from './jobs.ts';
import { availableRam, availableSwap, needsRam, roomToFilm as room } from './local-clips.ts';
import {
  AI_LAYOUTS, content, countWords, MAX_AI, MAX_LOCAL_AI, PURPOSES,
  fallbackOf, withinCaps, type Spec,
} from './spec.ts';
import { creditOf, filmStock, photoCredits } from './stock.ts';
import {
  afforded, closeHolds, drawnAs, heldUp, lineUnder, photoOfTheLine, sceneLine, shareOut, shotKey, slotsFor, standInOf, stockQueries, topicOf,
  ofTheWorld, worldOf, worldScore, type Slot, type Visual,
} from './visuals.ts';
import { isDraft, makingWords, secondsEach } from '../../shared/film-time.ts';
import { filmMemory, storyboardKey, subjectKey, type KeptSubject } from './remembered.ts';
import { pictureHash, type FilmRecord, type RecordPicture } from './edits.ts';
import { pcmSeconds, readPcm, recordOf, wavOfPcm } from './film-record.ts';
import { sourcesOf } from './grounding.ts';
import { briefWants } from './close.ts';
import {
  FORMATS, isPack, PACE, PACKS, PACES, paintOf, quietOf, sceneSeconds, snapToBeats, startsOf,
  type Film, type Pace, type Pack, type Shot,
} from './templates/index.ts';
import { camOf } from './templates/layouts.ts';
import { hushPcm, sceneClock, timeWords, type Hush, type Part, type Word } from './timings.ts';
import { gather, narratorOf, productFacts, takeLine, type VideoAsk, type VideoDeps } from './gather.ts';
import { settleLength } from './length.ts';
import { readAround } from './take.ts';
import { carryExtras, chromePath, drawingFor, editPlan, renderProject, stageVendor, withJobDir } from './render.ts';
import { castLine, castVoice, engineOf, isVoice, VOICES, wavSeconds } from './voice.ts';
import { creditsOf, designOf, NONCOMMERCIAL, OMNI_ENGINE } from './omnivoice.ts';

export const SETUP_HINT = 'No video renderer is set up. The founder installs Chrome and ffmpeg — both are free — and restarts the app.';

// The bed under a film is written by `media/music.ts`, which is asked for a mood and a length and hands back a
// finished loop at −23 LUFS with its own beats and its own credit. Nothing about it is decided here.


// A picker the founder left on Auto is nothing at all; anything else is their decision and is obeyed.
const chose = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  (typeof value === 'string' && value !== 'auto' && (allowed as readonly string[]).includes(value) ? value as T : undefined);

// Where the words a picture model is handed are written is `media/visuals.ts` now, one picture a shot, out of the
// phrase being spoken under it. What used to be here — a subject cut out of a scene's headline, the nouns that
// summon lettering struck out of it, and a texture wherever a frame was already full of type — is all in there,
// with a critic over it that no single function could have.

// Why nobody speaks on camera when the free lip-sync service is set up and answering, but this film was not allowed
// to spend its minutes. Without it the founder heard NO_FACE_HINT telling them to add HF_TOKEN — which they had.
// Those minutes are the founder's to spend, so a film on auto with nothing unlimited installed does not spend them
// uninvited; it says what would.
export const heldFaceLine = (draft: boolean): string => (draft
  ? 'this is a draft, so nobody speaks on camera — the full film can use the free lip-sync service, which is set up'
  : 'the free lip-sync service is set up and working, but AI clips are not on for this film, so nobody speaks on camera — turning AI clips on uses some of the free daily minutes');

// What a film says, once, when it would have used real photographs and cannot. Health and the keys panel say it too;
// this is the founder hearing it where the drawn pictures are.
export const NO_PHOTOS_LINE = 'Real photographs needs a Pexels key (free at pexels.com/api, set in Keys), so every picture in this film is drawn';

export function hyperframesVideos(deps: VideoDeps): Maker {
  const bin = resolve(import.meta.dirname, '../../node_modules/.bin/hyperframes');
  const vendor = resolve(import.meta.dirname, 'templates/vendor');
  const clips = deps.clips ?? noClips;

  return {
    name: 'Hyperframes',
    ready: () => (chromePath() ? null : SETUP_HINT),
    async make(ask, { report, signal }): Promise<Piece> {
      const asked = ask as VideoAsk;
      // Notes on a film already made are a remake of that film, not a new one: only what they touch is made again.
      if (typeof asked.edit === 'string' && asked.edit.trim()) {
        const { remakeVideo } = await import('./remake.ts');
        return remakeVideo(deps, { film: asked.edit.trim(), notes: asked.prompt, record: asked.record }, { report, signal }, { bin, vendor });
      }
      return withJobDir(deps.dir, Date.now().toString(36), report, async (at) => {

        // Everything the founder decided, and nothing they did not. What is still open the director reads out of the
        // brief itself, one pass at a time, saying each decision on the card as it makes it.
        const told: Asked = {
          brief: asked.prompt,
          purpose: chose(asked.purpose, PURPOSES),
          seconds: typeof asked.length === 'number' && Number.isFinite(asked.length) ? asked.length : undefined,
          shape: chose(asked.format, ['wide', 'tall', 'square'] as const),
          pace: chose(asked.pace, PACES),
          pack: chose(asked.look, PACKS),
          music: chose(asked.music, MOODS),
          captions: asked.captions,
          // Nothing asks for somebody on camera by a switch: the card has a `person` field, but neither the card nor
          // a person's call ever sets it, so whether a film wants a face is read out of the brief alone.
        };
        // The founder's AI-clips switch: on, off, or theirs to work out.
        const wantsAi = asked.ai === true || asked.ai === 'on';
        const autoAi = asked.ai === 'auto' || asked.ai === undefined;
        const here = !!deps.local && !deps.local.ready();
        // A draft is the film to look at before the film: a few small pictures shared across the shots, nothing
        // moving drawn for it, and a quick encode. What it says and how it is cut are exactly the full film's.
        const draft = isDraft(asked.speed);
        const memory = filmMemory(deps.cacheDir ? join(deps.cacheDir, 'films') : undefined);

        const { material, files, bed, narrator: studioVoice } = await gather(deps, asked, at, report, signal);
        if (signal?.aborted) throw new Error('stopped');
        if (material.using.length) report(`using: ${material.using.join(', ')}`);

        // A person who wrote the whole storyboard is not overruled about what is in it, only about how it is set —
        // but it is read by the same editor as the director's own work. A storyboard written by somebody in a chat
        // used to go straight to the renderer, which is exactly how the founder's own film came back as three
        // talking-head scenes with no variety, no length check and nothing grounding them. The rules do not care
        // who wrote the scenes.
        let understanding: Understanding;
        let spec: Spec;
        let bible: string;
        // The one idea the film turns on, which every picture in it is drawn against. A storyboard handed over
        // whole has no plan behind it, so the brief itself stands in for one.
        let angle = asked.prompt.slice(0, 160);
        // The storyboard as directed and where it is kept, so a storyboard filled out to its length after its first
        // reading is the one the full film is made from too.
        let keptAs: { key: string; directed: Awaited<ReturnType<typeof direct>> } | undefined;
        const mayUseAi = !draft && (wantsAi || (autoAi && here));
        if (draft && wantsAi) report('this is a draft, so nothing moving is drawn for it — the full film has the moving shots');
        // Whether anything can really move a mouth to a recording right now. It is the only thing that lets a
        // person speak on camera in one of these films, and a film never fakes it.
        const lipsync = !!deps.lipsync && !deps.lipsync.ready() && mayUseAi;
        if (asked.spec) {
          understanding = understandingOf({}, told, readBrief(asked.prompt));
          bible = bibleFor(understanding);
          spec = asked.spec;
          if (spec.pace) understanding.pace = spec.pace;
          if (spec.pack) understanding.pack = spec.pack;
          if (spec.music) understanding.mood = spec.music;
          if (spec.captions !== undefined) understanding.captions = spec.captions;
          report(tellOf(understanding));
          const want: Want = {
            seconds: understanding.seconds, pace: understanding.pace, purpose: understanding.purpose,
            captions: understanding.captions, bible, layouts: layoutsFor({ ai: mayUseAi, lipsync, material }),
            reel: understanding.purpose === 'reel' || understanding.purpose === 'ad',
            product: material.lines.length > 0 || material.assets.length > 0 || !!material.brand,
            sources: sourcesOf(material, asked.prompt),
            screens: material.assets.filter((one) => one.kind === 'screen').map((one) => one.name),
            person: understanding.person,
            ...briefWants(material, asked.prompt),
          };
          const mended = repair(spec, want);
          spec = mended.spec;
          for (const line of mended.notes.slice(0, 5)) report(line);
          const shots = mendShots(spec, { pace: understanding.pace, look: understanding.pack });
          spec = shots.spec;
          for (const line of shots.notes.slice(0, 3)) report(line);
        } else {
          // A full film asked for straight after its draft is that film, not a second opinion: it is made from
          // the storyboard the founder has just watched. Anything else — the same speed again, a changed brief, a
          // new wire — is directed afresh, because pressing Make again has always meant "show me another".
          const key = storyboardKey({ brief: asked.prompt, told, lines: material.lines, assets: material.assets.map((one) => one.name) });
          const watched = await memory.storyboard<Awaited<ReturnType<typeof direct>>>(asked.cardId, key, draft ? 'draft' : 'full');
          if (watched) report('this is the draft you watched, now made in full: the same storyboard, every shot its own picture');
          const directed = watched ?? await direct(told, material, deps.think, { report, ai: mayUseAi, lipsync, signal });
          if (signal?.aborted) throw new Error('stopped');
          if (watched) report(tellOf(directed.understanding));
          else await memory.keepStoryboard(asked.cardId, { key, speed: draft ? 'draft' : 'full', directed });
          understanding = directed.understanding;
          spec = directed.spec;
          keptAs = { key, directed };
          bible = directed.bible;
          angle = directed.plan.angle || angle;
        }
        const shape: Shape = understanding.shape;
        const pack: Pack = isPack(understanding.pack) ? understanding.pack : 'clean';
        const pace: Pace = understanding.pace;
        const seconds = understanding.seconds;
        const mood: Mood = understanding.mood;
        const captions = understanding.captions;
        const sfx = asked.sfx !== false;

        await stageVendor(vendor, at, pack);

        const brand = pack === 'brand' ? material.brand : undefined;
        if (pack === 'brand' && !brand) report('no product colours were found, so the film is set in the clean look');

        const able = mayUseAi && !clips.ready();
        if (wantsAi && !able) report(`AI clips are switched on but not ready: ${clips.ready()}`);
        // Real photographs and real footage, where the look can hold them and while a library will answer. A refused
        // key or a spent day is said once and every scene after goes to the next library, or to drawing; no key at
        // all is said once, further down.
        const photoLibrary = filmStock(deps.stock, pack, report);
        // What the film is about, in the brief's own nouns: what every photograph in it may be of.
        const topic = topicOf(asked.prompt);
        // The film's world: the brief's own things and, for a film about the company, the product's. Every picture
        // and photograph is of the line and of this world, and nothing a museum would catalogue gets in unasked.
        const world = worldOf(asked.prompt, productFacts(material.lines.join('\n\n')));
        // A moving shot the film was going to have can still be real footage somebody filmed when no AI clip can be
        // made, which costs nothing and needs no key (Wikimedia Commons).
        const realClips = mayUseAi && photoLibrary.clips;
        // Who filmed each real clip, for the credits beside the film.
        const clipCredits = new Map<string, string>();
        const { spec: capped, notes } = withinCaps(spec, { ai: able || realClips, assets: [...files.keys()], most: here ? MAX_LOCAL_AI : MAX_AI });
        spec = capped;
        for (const note of notes) report(note);
        // Only now is it settled whether there is really a person in this film: a clip scene that was written and
        // then could not be made is not somebody on camera, and the brief asked for somebody on camera. Whether
        // this machine can film one is asked here and now, because what a computer can spare changes minute to
        // minute and a clip that leans on swap takes an hour instead of three minutes.
        const spare = here && able ? await availableRam() : null;
        // Memory and swap together, because a machine leaning on swap makes the clip slowly rather than not at all —
        // and a founder refused at 21 GB when 22 was wanted has been told no for a gigabyte.
        const filming = here && able ? room({ ram: spare, swap: await availableSwap(), needs: needsRam() }) : { answer: 'no' as const, line: '' };
        if (understanding.person && here && able && filming.line) report(filming.line);
        // A real picture of a real person, already on the card, is who the film puts on camera. Nothing is drawn and
        // nothing is filmed for a face the founder has already made.
        const face = faceIn(material);

        // Casting, which is one decision and is made once. The voices the model really ships are read off the
        // weights themselves — gender, accent and the grade the model's own authors gave them — and the film takes
        // the best one that fits what the brief asked for. The founder's pick on the card overrules all of it.
        const table = await deps.voices?.cast?.().catch(() => undefined) ?? VOICES;
        const wanted = narratorWanted(asked.prompt, understanding);
        // A wired voice studio is the founder saying whose voice this is, unless they picked one on this card, which wins.
        const reading = narratorOf(asked, studioVoice);
        const narrator = isVoice(reading.voice) ? (table.find((one) => one.id === reading.voice) ?? castVoice(wanted, table)) : castVoice(wanted, table);
        // Kokoro reads every film. OmniVoice only when the founder chose it by hand — on this card, or on the voice
        // studio they wired to it: its weights forbid selling what it makes, and a film is usually selling something,
        // so it is never picked here on its own. A voice cloned in that studio is cloned here too.
        const omniAsked = reading.engine === OMNI_ENGINE;
        const borrowed = omniAsked ? engineOf(deps.voices, OMNI_ENGINE) : undefined;
        const omniAsk = { engine: OMNI_ENGINE, design: reading.design,
          ...(reading.ref ? { clone: reading.clone, ref: reading.ref, ...(reading.refText ? { refText: reading.refText } : {}) } : {}),
          ...(reading.language ? { language: reading.language } : {}) };
        const borrowAsk = { prompt: '', ...omniAsk };
        const borrowHint = borrowed ? borrowed.ready(borrowAsk) : omniAsked ? 'it is not on this machine' : null;
        if (omniAsked && asked.narrate !== false && borrowHint) report(`OmniVoice cannot read this film (${borrowHint}), so Kokoro does`);
        // A cloned voice is the recording's, whatever the design says, so a design is read only when nothing is cloned.
        const omni = borrowed && !borrowHint ? designOf(reading.ref ? undefined : reading.design) : null;
        const omniSays = reading.ref ? `cloned from ${reading.clone ?? 'a recording'}` : omni?.instruct;
        if (asked.narrate !== false) report(omni ? `narrator: OmniVoice, ${omniSays} · ${NONCOMMERCIAL}` : castLine(narrator));
        const narratorGender = omni ? (omni.kept.includes('male') ? 'm' : omni.kept.includes('female') ? 'f' : narrator.gender) : narrator.gender;
        // Whoever is on screen has to sound like themselves. The only description of a drawn or dropped picture
        // anybody has is the words it was drawn from, so that is what is read — and where it says a man and the
        // narrator is a woman, nobody goes on camera at all rather than the two being put together.
        const shownAs = narratorWanted([face && material.assets.find((one) => one.name === face)?.prompt,
          spec.scenes.map((one) => one.portrait_prompt).filter(Boolean).join(' ')].filter(Boolean).join(' ')).gender;
        const held = !!deps.lipsync && !deps.lipsync.ready() && !lipsync;
        spec = { ...spec, scenes: onCamera(spec.scenes, understanding, bible, (line) => report(held && line === NO_FACE_HINT ? heldFaceLine(draft) : line),
          { ready: lipsync, narratorGender, personGender: shownAs }, face) };

        // Every drawn picture is filed under what was asked for, so the same film rendered twice draws nothing the
        // second time and a founder's daily quota lasts the week.
        const drawing = drawingFor(deps);
        const reader = omni ? borrowed : deps.voices;
        const saying = reader && !reader.ready(omni ? borrowAsk : undefined) && asked.narrate !== false ? reader : null;
        // What the narration's own licence says, when it says anything. It travels with the film.
        let voiceTerms = '';
        if (!drawing) report('no picture maker is set up, so the scenes are set on drawn backgrounds instead of photographs');
        const { width, height } = FORMATS[shape];
        // `null` here means ffmpeg answered; anything else is the line the founder is told instead.
        const noFf = await ffReady();
        if (noFf && (spec.scenes.some((scene) => scene.layout === 'footage') || mood !== 'none')) report(noFf);

        const wantsClips = spec.scenes.filter((scene) => AI_LAYOUTS.has(scene.layout)).length;
        // Where the next picture would really be drawn, asked of the makers themselves: a free service that still
        // has some of today left answers in four seconds, and this machine is only the answer once it has none.
        // It used to be "could this machine draw?", which said eleven minutes about a film that took two.
        const drawsHere = () => (deps.images?.next ? deps.images.next() === 'this computer' : mayDrawHere());
        const drawnHere = drawsHere();
        // How long this is going to take, said before it starts rather than found out. The number of pictures is a
        // guess until the film has been read aloud and cut — a scene is one shot or it is three — so it is said
        // again, exactly, the moment the shot list exists and before anything slow has happened.
        const guessed = drawing ? afforded(Math.round(spec.scenes.length * 1.6), drawnHere, 8, draft) : 0;
        report(`${draft ? 'a draft, ' : ''}${spec.scenes.length} scenes, ${makingWords({ seconds, pictures: guessed, clips: here ? wantsClips : 0, narrate: !!saying, here: drawnHere, draft })}`);
        // --- the length, measured ---------------------------------------------------------------------------
        //
        // A film runs as long as its reading (`length.ts`), and the storyboard's own count of its words is a guess at
        // that: the hero film was budgeted at twenty seconds and read in fifteen. So a directed film is read once, by
        // the narrator who will read it, before anything is cut; under 85% of the length asked for, the director is
        // asked once for the lines that fill it, and the reading is made again. Over 115%, scenes come out of the
        // middle. The first reading is kept and used whenever the script has not changed, so this costs nothing
        // when the length was right.
        const sayIt = (prompt: string) => saying!.make({ prompt, voice: narrator.id, ...(omni ? omniAsk : {}) }, { report: () => {}, signal });
        let firstRead: { script: string; piece: Awaited<ReturnType<typeof sayIt>> } | undefined;
        if (keptAs && saying && seconds && !studioVoice?.take) {
          const script = spec.scenes.map((scene) => (scene.say ?? '').trim()).filter(Boolean).join(' ');
          const piece = script ? await sayIt(script).catch(() => undefined) : undefined;
          if (signal?.aborted) throw new Error('stopped');
          if (piece) {
            firstRead = { script, piece };
            const measured = wavSeconds(piece.bytes);
            const want: Want = {
              seconds, pace: understanding.pace, purpose: understanding.purpose, captions: understanding.captions, bible,
              layouts: layoutsFor({ ai: mayUseAi, lipsync, material }), reel: understanding.purpose === 'reel' || understanding.purpose === 'ad',
              product: material.lines.length > 0 || material.assets.length > 0 || !!material.brand,
              sources: sourcesOf(material, asked.prompt), screens: material.assets.filter((one) => one.kind === 'screen').map((one) => one.name),
              ...briefWants(material, asked.prompt),
            };
            const fitted = await fitLength(spec, want, understanding, material, deps.think, report, measured);
            if (fitted !== spec) {
              spec = fitted;
              await memory.keepStoryboard(asked.cardId, { key: keptAs.key, speed: draft ? 'draft' : 'full', directed: { ...keptAs.directed, spec } });
            }
          }
        }

        report('cutting what you gave it and recording the narration…');
        const shots: Shot[] = spec.scenes.map((scene) => ({ scene, seconds: 0 }));
        const said = (index: number, line: string) => report(`scene ${index + 1}: ${line}`);

        // Everything a scene was handed is made ready first: the founder's own footage, the screenshots, the moving
        // shots. None of these depends on how the film is cut, and all of them decide how it is cut.
        const scenework = Promise.all(spec.scenes.map(async (scene, index) => {
          const shot = shots[index];
          // Where a named asset really is: in this job's assets already, or still out in the shared files. A phone film
          // wants the phone view of a page, whichever one the storyboard happened to name.
          const wanted = scene.layout === 'device' && shape === 'tall' && scene.asset?.includes('-desktop-')
            ? (files.has(scene.asset.replace('-desktop-', '-mobile-')) ? scene.asset.replace('-desktop-', '-mobile-') : scene.asset)
            : scene.asset;
          const named = wanted ? files.get(wanted) : undefined;
          const source = named ? (named.where === 'job' ? join(at, 'assets', named.file) : deps.fileOf?.(named.file) ?? named.file) : '';
          // A screenshot, a dropped picture or the product's own mark: already on disk, only the right shape away.
          if (named && named.kind !== 'video' && named.kind !== 'audio' && (scene.layout === 'device' || scene.layout === 'picture' || scene.layout === 'logo' || scene.layout === 'presenter')) {
            // A screenshot goes in whole: a device scene reads down the page it was taken of, so cropping it is wrong.
            if (named.kind === 'screen' && named.where === 'job') shot.image = named.file;
            else {
              shot.image = `fit-${index}.png`;
              await fitStill(source, join(at, 'assets', shot.image), width, height, signal)
                .catch(async () => { shot.image = `as-is-${index}.png`; await copyFile(source, join(at, 'assets', shot.image)).catch(() => { shot.image = undefined; }); });
            }
          }
          if (scene.layout === 'footage' && named) {
            const cut = `cut-${index}.mp4`;
            said(index, 'cutting your footage to the frame…');
            await (noFf ? Promise.reject(new Error(noFf)) : normalise({ from: source, to: join(at, 'assets', cut), width, height, start: scene.start, seconds: scene.seconds, mute: scene.mute, signal }))
              .then(() => { shot.video = cut; }, (error: Error) => { said(index, `that clip could not be used (${error.message}), so the scene is its words instead`); shot.scene = fallbackOf(scene); });
          }
          if (scene.layout === 'clip' && (able || realClips)) {
            let why = '';
            if (able) {
              try {
                said(index, 'making a few seconds of moving picture…');
                // A still first, so the clip looks like the rest of the film rather than like a different film.
                const still = drawing ? await drawing.make({ prompt: [`${bible}. ${scene.clip_prompt!}`, lensPhrase(scene.lens)].filter(Boolean).join(', '), shape }, { report: () => {}, signal }).then((one) => one.bytes, () => undefined) : undefined;
                const made = await clips.broll({ prompt: scene.clip_prompt!, image: still, seconds: scene.seconds ?? 4, shape, move: scene.move }, { report: (line) => said(index, line), signal });
                shot.video = `clip-${index}.mp4`;
                await writeFile(join(at, 'assets', shot.video), made.bytes);
              } catch (error) {
                why = (error as Error).message;
              }
            }
            // Real footage of the scene's own things, filmed by somebody and credited, cut to the film's frame.
            let missed = '';
            if (!shot.video && realClips && !noFf && !signal?.aborted) {
              // Asked like a photograph: the clip's own things beside the film's topic, then the topic alone, and
              // a clip that is of neither, or of a place or a day the brief never named, is refused.
              const wanted = { line: scene.clip_prompt ?? scene.text ?? '', subject: scene.clip_prompt ?? '' };
              let real = null as Awaited<ReturnType<typeof photoLibrary.clip>>;
              for (const query of stockQueries(wanted, topic, world)) {
                real = await photoLibrary.clip({
                  query, shape, seconds: scene.seconds ?? 4,
                  speaker: !!scene.person, names: [material.brand?.name ?? ''].filter(Boolean),
                  fits: (one) => photoOfTheLine(one.what, wanted, topic, asked.prompt, world),
                  rank: (one) => worldScore(one.what, world),
                }, signal);
                if (real || signal?.aborted) break;
              }
              if (!real) missed = await photoLibrary.noClip();
              if (missed) report(missed);
              if (real) {
                const raw = `stock-clip-${index}-raw.${real.ext}`;
                const cut = `stock-clip-${index}.mp4`;
                await writeFile(join(at, 'assets', raw), real.bytes);
                // A third of the way in, where a clip has started rather than shows its title card, when it is long
                // enough to have one.
                const length = real.found.seconds ?? 0;
                const want = scene.seconds ?? 4;
                const start = length > want * 2 ? Math.min(Math.round(length / 3), Math.max(0, length - want - 1)) : 0;
                await normalise({ from: join(at, 'assets', raw), to: join(at, 'assets', cut), width, height, start, seconds: want, mute: true, signal })
                  .then(() => {
                    shot.video = cut;
                    clipCredits.set(cut, creditOf(real.found));
                    said(index, `real footage instead${why ? ' of an AI clip' : ''}: ${creditOf(real.found)}`);
                  }, (error: Error) => { why ||= `the real footage could not be cut (${error.message})`; });
              }
            }
            if (!shot.video) {
              said(index, why ? `the clip could not be made (${why}), so the scene is a picture instead` : `${missed || 'no real footage of it was found'}, so the scene is a picture instead`);
              shot.scene = fallbackOf(scene);
            }
          }
        }));

        // Somebody speaking on camera waits for the reading, because a mouth is matched to a recording and there
        // was no recording until now.
        const lipsyncWork = async () => {
          if (!lipsync) return;
          for (const [index, scene] of spec.scenes.entries()) {
            const shot = shots[index];
            // Somebody speaking on camera, and the only way this studio will make one: a real lip-sync backend,
            // handed the actual recording, moving the actual mouth to it. There is no second route and there is no
            // stand-in. A drawn person whose mouth moves to a separate recording is the single fastest way to make a
            // film read as generated, and the studio would rather show nobody at all — `onCamera` has already turned
            // these scenes into the faceless edit wherever no backend was standing by, so reaching here means one is.
            if (scene.layout === 'presenter' && lipsync) {
              try {
                said(index, 'making the person on screen say it…');
                const face = shot.image ? await readFile(join(at, 'assets', shot.image))
                  : drawing && scene.portrait_prompt ? (await drawing.make({ prompt: `${scene.portrait_prompt}, head and shoulders portrait, plain background, even light`, shape }, { report: () => {}, signal })).bytes
                    : null;
                if (!face) throw new Error('there is no face to use');
                // No recording, no lip sync, no person: a mouth cannot be matched to a line that was never said.
                const speech = shot.voice ? await readFile(join(at, 'assets', shot.voice.file)) : null;
                if (!speech?.length) throw new Error('there is no recording for the mouth to match');
                const about = material.assets.find((one) => one.name === scene.asset)?.prompt || scene.portrait_prompt;
                const made = await clips.presenter({ portrait: face, speech, about, shape }, { report: (line) => said(index, line), signal });
                shot.video = `pres-${index}.mp4`;
                await writeFile(join(at, 'assets', shot.video), made.bytes);
              } catch (error) {
                said(index, `nobody could be lip-synced (${(error as Error).message}), so the line is said over the film's own pictures instead`);
                shot.scene = fallbackOf(scene);
              }
            }
          }
        };

        // --- the narration, read once ---------------------------------------------------------------------------
        //
        // One recording for the whole film. It used to be one a scene, glued end to end, and that is audible: a
        // fresh breath at every join and the same flat stress on every sentence, because nothing reading a line
        // ever knew what came before it. Read in one go the voice rises, falls and hurries the way somebody
        // talking does — and there is one clock for the whole piece instead of a dozen that have to be added up.
        //
        // It happens here, before a single picture is drawn, and that order is the whole of phase three. Until now
        // the pictures were drawn first, from the scenes, which meant one picture a scene however many times the
        // editor cut inside it — a reel of five photographs where the shot list called for eleven, which is what
        // "one picture with the text swapped over it" actually was. The reading is what the cut is made against,
        // so the reading comes first, then the cut, and only then does anybody draw anything.
        //
        // The recording and the scene work above do not wait for each other any more. Nothing a scene is handed
        // decides what is said, and a moving shot drawn here is three minutes the voice used to spend doing nothing.
        const target = asked.spec ? 0 : seconds;
        const lines = spec.scenes.map((scene) => (scene.say ?? '').trim());
        const script = lines.filter(Boolean).join(' ');
        const scriptWords = script.split(/\s+/).filter(Boolean);
        let voice: { file: string; seconds: number } | undefined;
        let parts: Part[] = [];
        let words: Word[] = [];
        const recording = (async () => {
          if (!saying || !script) return;
          report('reading the whole film in one go…');
          try {
            // A line the founder already recorded in the wired Voice studio, in this same voice, is said as they
            // recorded it; only the rest of the film is read. A take in any other voice would be two narrators.
            const reuse = studioVoice && omniAsked === !!omni ? takeLine(lines, studioVoice.take, reading) : -1;
            const around = reuse >= 0 && studioVoice?.take
              ? await readAround(lines, reuse, studioVoice.take.bytes, sayIt).catch((error: Error) => { report(`the Voice studio's recording could not be used (${error.message}), so the whole film is read`); return null; })
              : null;
            if (around) report(`scene ${reuse + 1} says the Voice studio's own recording, so that line is used as recorded`);
            const piece = around ? { ext: 'wav', ...around } : firstRead?.script === script ? firstRead.piece : await sayIt(script);
            if (piece.noncommercial || (around && omni)) voiceTerms = piece.credits ?? creditsOf(reading.ref ? `${omniSays}` : `designed as ${omniSays ?? 'a voice'}`);
            await writeFile(join(at, 'assets', 'say.wav'), piece.bytes);
            let file = 'say.wav';
            let spoke = wavSeconds(piece.bytes);
            parts = piece.parts ?? [{ text: script, seconds: spoke }];
            // The length, held to what was asked for: the whole reading is spoken a little quicker — up to a
            // seventh, which nobody hears as fast — before a single scene is cut, because a film that loses a
            // scene loses an idea. One track means one pass rather than one a scene.
            const room = target ? target - spec.scenes.length * PACE[pace].tail * 0.6 : 0;
            if (room > 0 && spoke > room * 1.04 && !noFf) {
              const faster = Math.min(1.16, spoke / room);
              if (faster > 1.02) {
                report(`the narration came to ${Math.round(spoke)} seconds, so it is read ${Math.round((faster - 1) * 100)}% quicker to fit ${target}`);
                await ff(FFMPEG, ['-y', '-loglevel', 'error', '-i', join(at, 'assets', 'say.wav'), '-filter:a', `atempo=${faster.toFixed(3)}`, join(at, 'assets', 'say-fit.wav')], signal, 180)
                  .then(async () => {
                    file = 'say-fit.wav';
                    spoke = wavSeconds(await readFile(join(at, 'assets', file)));
                    parts = parts.map((part) => ({ ...part, seconds: part.seconds / faster }));
                  }, () => {});
              }
            }
            voice = { file, seconds: spoke };
          } catch (error) { report(`the narration could not be recorded (${(error as Error).message}), so the film is silent`); }
        })();
        await Promise.all([scenework, recording]);
        if (signal?.aborted) throw new Error('stopped');

        // Which words belong to which scene. The script is the scenes' own lines in order, so this is counting.
        const spans: { from: number; to: number }[] = [];
        let counted = 0;
        for (const line of lines) {
          const count = countWords(line);
          spans.push({ from: counted, to: counted + count });
          counted += count;
        }
        // How long each scene holds when nothing is said over it: long enough to read what is on it. With a reading,
        // only the wordless scenes need one; without, every scene does.
        const quietFor = (spoken: boolean): number[] => spec.scenes.map((scene, index) => (spoken && spans[index].to > spans[index].from ? 0
          : sceneSeconds([scene.heading, scene.text, ...(scene.bullets ?? [])].filter(Boolean).join(' '), 0, pace)));
        // The reading on the film's clock: a breath before the first word, and a silence for every wordless scene
        // where that scene falls, so a title card with no line is silent for its own length and the voice starts on
        // the first scene that says something (`timings.ts`).
        const clockOf = (heard: Word[]) => sceneClock(heard, spans, quietFor(true), { ...PACE[pace], min: cuttingFor(pack, pace).min });
        let hushes: Hush[] = [];

        // --- the edit ---------------------------------------------------------------------------------------
        //
        // Everything above decided what the film says and found what it has to look at. This decides when it cuts,
        // and until now nothing did: every scene simply held for as long as the line over it, which is three long
        // shots under a voice and is exactly the film the founder rejected. `media/editor.ts` does it, by the
        // numbers editors actually work to, and it is deterministic — the same film cuts the same way twice.
        //
        // It is a function of the words it is cut against because it is now run twice: once against where the
        // words *ought* to fall, which is known the moment the recording exists, and once against where they were
        // measured to fall. The first is what lets the pictures start while the second is still being listened for.
        const style = cuttingFor(pack, pace);
        const cutTo = (heard: Word[], tell: boolean): { takes: Take[]; edit: Edit } => {
          // The words are already on the film's one clock (`sceneClock`), so every take sits on its own words and a
          // wordless scene sits in the silence the reading was given for it.
          const takes: Take[] = takesOf(spec.scenes, spans, heard, {
            lead: PACE[pace].lead, tail: PACE[pace].tail, min: style.min, floor: PACE[pace].floor,
            least: quietFor(heard.length > 0), moving: shots.map((one) => !!one.video),
          });
          // How long the film really runs: as long as its reading and a short beat to close on, never padded to the
          // length asked for with a caption frozen on screen. `media/length.ts` says why.
          const settled = settleLength(takes, heard, target);
          if (tell && settled) report(settled);

          return { takes, edit: editFilm(takes, heard, style, { sfxOn: sfx }) };
        };

        // --- the pictures ---------------------------------------------------------------------------------------
        //
        // One picture a cut. Every shot in the list above gets something of its own on screen, drawn from the
        // phrase actually being spoken while it is up — not from the scene's headline, and not from the film's
        // subject in general. `media/visuals.ts` holds the rules and the critic; this is the part that spends
        // quota on them, in the order a real edit would: what the founder gave us, then a real photograph
        // somebody took, then one drawn here, and a texture only when everything else has run out.
        //
        // They are asked for as soon as there is a cut to ask against, and they are kept under the shot's own
        // name — which scene, which take — rather than its place in a list, so a picture started against the
        // guessed cut is still the right shot's picture when the measured cut arrives.
        type Drawn = { file: string; hold?: number; lift?: number; plies?: { back: string; mid: string; fore: string } };
        const pictures = new Map<string, Promise<Drawn | undefined>>();
        const stops = new Map<string, AbortController>();
        // Three at a time whoever draws them. This machine takes its own pictures one at a time whatever it is
        // asked, so the only thing three hands change here is that a free service is not made to wait its turn.
        const inHand = hands(3);
        const paint = paintOf(pack, brand);
        let spent = false;
        if (photoLibrary.missing && drawing && !draft) report(NO_PHOTOS_LINE);
        let kept = 0;
        // The one thing a picture maker says that a founder needs to hear: that a free service has run dry and the
        // rest are being drawn here, which is the difference between seconds and minutes. It was swallowed with
        // the rest of the makers' chatter, so a film quietly took eight minutes after promising two. Said once,
        // with the new wait beside it.
        const switched = new Set<string>();
        // What looking at the pictures found, said once a kind rather than once a picture, and how many were drawn again.
        const lookingAt = looking();
        // What made every picture in the film, so a note on it later knows which ones it can keep.
        const madeFrom = new Map<string, RecordPicture>();
        deps.sight?.warm();
        let pending = 0;
        const fromMaker = (line: string) => {
          if (!/used up/.test(line) || switched.has(line)) return;
          switched.add(line);
          const waiting = pending;
          report(drawsHere() && waiting ? `${line} — about ${Math.max(1, Math.round((waiting * secondsEach(true, draft)) / 60))} more minute${Math.round((waiting * secondsEach(true, draft)) / 60) > 1 ? 's' : ''} for the pictures` : line);
        };
        const gone = (error: Error, scene: number) => {
          if (outOfPictures(error.message)) {
            if (!spent) report("today's free pictures are used up, so the rest of the film sits on textures — they come back tomorrow");
            spent = true;
            return;
          }
          said(scene, `no picture: ${error.message}`);
        };
        const drawOne = async (visual: Visual, stop: AbortSignal): Promise<Drawn | undefined> => {
          if (spent || !drawing || stop.aborted) return undefined;
          const scene = spec.scenes[visual.scene];
          const name = `${visual.scene}-${visual.take}`;
          let file = '';
          // Who took a photograph, said the way a credit is said. The licence does not ask for it; knowing where a
          // picture in a finished film came from is still worth a line beside the film.
          let credit: string | undefined;
          try {
              // A real photograph of a real thing, from somebody who took one. People in stock are b-roll and
              // nothing else: never the film's own speaker, and never beside a claim about a named product.
            {
              // A photograph whose own description has none of the line's things in it is of something else.
              // Asked twice at most, the shot's own things beside the film's topic and then the topic alone; a
              // photograph that shares no word with either is refused, and after two misses the picture is drawn.
              let photo = null as Awaited<ReturnType<typeof photoLibrary.take>>;
              for (const query of stockQueries(visual, topic, world)) {
                photo = await photoLibrary.take({
                  query, shape,
                  speaker: !!scene.person || scene.layout === 'presenter', names: [material.brand?.name ?? ''].filter(Boolean),
                  fits: (one) => photoOfTheLine(one.what, visual, topic, asked.prompt, world),
                  rank: (one) => worldScore(one.what, world),
                }, stop);
                if (photo || stop.aborted) break;
              }
              if (photo) {
                file = `stock-${name}.${photo.ext}`;
                await writeFile(join(at, 'assets', file), photo.bytes);
                credit = creditOf(photo.found);
              }
            }
            if (!file) {
              const piece = await drawing.make({ prompt: drawnAs(visual, bible), shape, ...(draft ? { size: 'draft' } : {}) }, { report: fromMaker, signal: stop });
              if (piece.by === DRAWN_BEFORE) kept += 1;
              file = `frame-${name}.${piece.ext}`;
              await writeFile(join(at, 'assets', file), piece.bytes);
            }
            // Looked at, drawn again once if it broke a rule, lifted, cut into planes and measured for its scrim:
            // the same steps a remade film's pictures go through, in `finish.ts`.
            const done = await finishPicture({
              dir: join(at, 'assets'), file, visual, scene, pack, paint, sight: deps.sight, state: lookingAt, stop, report,
              redraw: async (again) => {
                const piece = await drawing.make({ prompt: drawnAs(again, bible), shape, ...(draft ? { size: 'draft' } : {}) }, { report: fromMaker, signal: stop });
                const second = `frame-${name}-b.${piece.ext}`;
                await writeFile(join(at, 'assets', second), piece.bytes);
                return second;
              },
            });
            // What made the picture that was kept: the redrawn subject when the second drawing won, so a remake in a
            // new look draws from the words that did not summon the stranger.
            const subject = done.visual.subject;
            madeFrom.set(done.file, done.file.startsWith('stock-')
              ? { kind: 'stock', hash: pictureHash(subject, '', shape), subject, ...(credit ? { credit } : {}) }
              : { kind: 'drawn', hash: pictureHash(subject, bible, shape), subject });
            return { file: done.file, hold: done.hold, lift: done.lift, plies: done.plies };
          } catch (error) {
            // A picture nobody is waiting for any more was stopped on purpose, and is not a thing that went wrong.
            if (!stop.aborted) gone(error as Error, visual.scene);
            return undefined;
          }
        };

        // Which shots of a cut need a picture, which of them get one of their own, and the drawing of every one of
        // those that is not already under way. Called once against the guessed cut and once against the measured
        // one; the second call finds nearly everything it wants already started.
        const drawFor = async (cut: Cut[], heard: Word[], tell: boolean) => {
          const needing = cut.map((one, order) => ({ one, at: order }))
            .filter(({ one }) => !shots[one.scene].video && !shots[one.scene].image
              && !closesOnGround(shots[one.scene].scene.layout, one.scene, shots.length));
          if (!drawing || !needing.length) return { needing, owners: needing.map(() => -1) };
          const have = new Set(needing.flatMap(({ one }, which) => (pictures.has(shotKey(one)) ? [which] : [])));
          // How many of those can really be drawn today, said in minutes before the waiting starts. Away from this
          // machine a picture is four seconds; here it is most of a minute, and eleven minutes of waiting for a
          // fifteen-second reel is not a trade a founder would make without being asked.
          const many = afforded(needing.length, drawsHere(), 8, draft);
          const owners = shareOut(needing.map(({ one }) => one.seconds), many, have);
          const fresh = [...new Set(owners)].filter((which) => !have.has(which));
          if (tell) {
            const drawn = new Set(owners).size;
            report(`${drawn} picture${drawn === 1 ? '' : 's'} for ${cut.length} shots — ${makingWords({ seconds, pictures: drawn, clips: 0, narrate: false, here: drawsHere(), draft })}`);
          }
          if (!fresh.length) return { needing, owners };
          const slots: Slot[] = cut.map((one) => ({
            scene: one.scene, take: one.take, layout: spec.scenes[one.scene].layout,
            line: lineUnder(heard, one.at, one.at + one.seconds, sceneLine(spec.scenes[one.scene])),
          }));
          // Whatever the storyboard already wrote for a scene is the first take's picture, so the director's own
          // work is the starting point rather than something thrown away.
          const seeded = slotsFor(slots, captions, spec.scenes).map((one) => {
            const wrote = spec.scenes[one.scene].image_prompt ?? spec.scenes[one.scene].bg_prompt;
            return one.take === 0 && wrote ? { ...one, subject: wrote } : one;
          });
          const wanted = fresh.map((which) => seeded[needing[which].at]);
          // A line that has had a picture put under it before gets that picture again. It is what makes the cache
          // of drawn pictures worth having: the words a picture is filed under are written by a model, and a
          // model never writes the same sentence twice, so until this nothing drawn was ever found again.
          const keys = new Map(wanted.map((one) => [one.at, subjectKey(one, bible)]));
          const known = await memory.subjects([...keys.values()]);
          const unknown = wanted.filter((one) => {
            const before = known.get(keys.get(one.at)!);
            return !before || !heldUp({ ...one, ...before }) || !!standInOf(before.subject, world.named) || !ofTheWorld(before.subject, world);
          });
          const written = unknown.length ? await photograph(unknown, bible, angle, deps.think, { report, signal }, world) : [];
          await memory.keepSubjects(written.filter((one) => one.subject.trim())
            .map((one): [string, KeptSubject] => [keys.get(one.at)!, { subject: one.subject, metaphor: one.metaphor }]));
          for (const slot of wanted) {
            const before = known.get(keys.get(slot.at)!);
            // A subject remembered from an earlier film is held to today's rules like a new one: one that does not
            // hold up is written again rather than drawn again.
            const remembered = before ? { ...slot, ...before } : undefined;
            const visual = remembered && heldUp(remembered) && !standInOf(remembered.subject, world.named) && ofTheWorld(remembered.subject, world) ? remembered : written.find((one) => one.at === slot.at) ?? slot;
            const key = shotKey(visual);
            const mine = new AbortController();
            stops.set(key, mine);
            const stop = signal ? AbortSignal.any([signal, mine.signal]) : mine.signal;
            pending += 1;
            pictures.set(key, inHand(() => drawOne(visual, stop)).finally(() => { pending -= 1; }));
          }
          return { needing, owners };
        };

        // Where the words ought to fall, worked out from how long each sentence took to say. It is what the film
        // is cut against whenever the recording cannot be listened back to, so it is near enough to choose
        // pictures by — and it exists now, where the measurement is most of a minute away on a long film.
        const rough = voice ? clockOf((await timeWords(null, null, parts, 0, { script: scriptWords })).words).words : [];
        const early = voice && drawing
          ? drawFor(cutTo(rough, false).edit.shots, rough, true).then(() => true, () => false)
          : Promise.resolve(false);

        if (voice) {
          // And now the one measurement in this studio that was always a guess. Every cut, punch-in and caption
          // in the film lands on one of these.
          report('listening back for where each word falls, and drawing while it does…');
          const heard = await timeWords(bin, join(at, 'assets', voice.file), parts, 0, { script: scriptWords, signal })
            .catch(async () => ({ words: (await timeWords(null, null, parts, 0, { script: scriptWords })).words, how: 'guessed' as const }));
          const clocked = clockOf(heard.words);
          words = clocked.words;
          hushes = clocked.hushes;
          report(heard.how === 'heard'
            ? 'the words were measured, so every cut lands on one'
            : 'the words could not be measured on this machine, so their timing comes from the sentences — the cuts are close rather than exact');
        }
        const startedEarly = await early;
        if (signal?.aborted) throw new Error('stopped');

        // The recording, given the same silences as its words, so it plays on the film's clock from 0: the voice
        // waits out a wordless title instead of reading the next scene's line under it.
        if (voice && hushes.length) {
          const read = await readFile(join(at, 'assets', voice.file)).catch(() => null);
          const pcm = read ? readPcm(read) : null;
          if (pcm) {
            const held = hushPcm(pcm, hushes);
            await writeFile(join(at, 'assets', 'say-film.wav'), wavOfPcm(held));
            voice = { file: 'say-film.wav', seconds: Math.round(pcmSeconds(held) * 1000) / 1000 };
          } else report('the narration could not be laid on the film\'s clock, so it may run ahead of a scene with nothing said over it');
        }

        // Somebody speaking on camera needs their own line as sound, cut out of the film's one reading.
        if (voice && words.length && !noFf) {
          for (const [index, scene] of spec.scenes.entries()) {
            if (scene.layout !== 'presenter') continue;
            const span = spans[index];
            if (span.to <= span.from) continue;
            // The recording plays on the film's clock now, so a word's time is its place in the file.
            const from = Math.max(0, words[span.from].at);
            const until = Math.max(from + 0.4, words[span.to - 1].at + words[span.to - 1].seconds);
            const file = `say-${index}.wav`;
            await ff(FFMPEG, ['-y', '-loglevel', 'error', '-ss', from.toFixed(3), '-i', join(at, 'assets', voice.file),
              '-t', (until - from).toFixed(3), join(at, 'assets', file)], signal, 120)
              .then(() => { shots[index].voice = { file, seconds: until - from }; }, () => {});
          }
        }

        const { takes, edit } = cutTo(words, true);
        report(`${edit.shots.length} shots over ${spec.scenes.length} scenes — ${edit.changesPer10s} picture changes every ten seconds`);
        // What the shot list says about itself, before anything is drawn for it. A hold nobody breaks and a hook
        // that has not changed picture by two and a half seconds are both faults of the cut, not of the pictures,
        // and both were in the proof films.
        for (const line of checkCut(edit.shots, takes.map((one) => one.scene), takes.map((one) => !!one.moving)).slice(0, 3)) report(line.says);

        // The bed is written while the pictures are drawn: it needs the film's length and nothing else, and the
        // length is known from here on.
        const bedWork = mood !== 'none' && !noFf && !bed && deps.music
          ? (report('writing the music…'), deps.music.bed({ mood: mood as MusicMood, seconds: Math.ceil(edit.shots.reduce((sum, one) => sum + one.seconds, 0)) + 2 }, { report, signal })
            .then((made) => ({ made, error: undefined }), (error: Error) => ({ made: undefined, error })))
          : null;

        // The measured cut, asked for its pictures. Whatever the guessed cut already started is found under the
        // same shot's name and waited for; the odd shot the guess did not have is drawn now; and a picture the
        // measured cut has no shot for is stopped rather than left drawing for nobody.
        const { needing, owners } = await drawFor(edit.shots, words, !startedEarly);
        const using = new Set([...new Set(owners)].filter((which) => which >= 0).map((which) => shotKey(needing[which].one)));
        for (const [key, stop] of stops) if (!using.has(key)) stop.abort();
        // Which drawable shot each one takes its picture from, and what was made for it.
        const made = new Map<number, Drawn>();
        await Promise.all([...new Set(owners)].filter((which) => which >= 0).map(async (which) => {
          const piece = await pictures.get(shotKey(needing[which].one));
          if (piece) made.set(which, piece);
        }));
        const unseen = deps.sight?.why();
        if (unseen) report(unseen);
        if (kept) report(`${kept} of the pictures ${kept === 1 ? 'was' : 'were'} drawn before, so ${kept === 1 ? 'it' : 'they'} cost nothing this time`);

        await lipsyncWork();
        if (signal?.aborted) throw new Error('stopped');

        // A scene whose picture never arrived becomes the words it carries, so a founder with no picture key still
        // gets a film, and every scene is as long as the line said over it.
        const drewFor = new Map<number, Drawn & { shared: boolean }>();
        // The close holds the film's best picture of its world, never the weakest one and never the picture of the
        // shot before it carried on.
        // A picture that passed the critic is of the film; one of its world's things in it counts for more.
        const scores = new Map([...made].map(([which, piece]) => {
          const score = worldScore(madeFrom.get(piece.file)?.subject ?? '', world);
          return [which, score < 0 ? -1 : 1 + score] as const;
        }));
        const holding = closeHolds(owners, scores);
        if (holding.at(-1) !== owners.at(-1)) report("the close holds the film's best picture of its subject rather than the one before it");
        needing.forEach(({ at: order }, which) => {
          const owner = holding[which];
          const piece = made.get(owner);
          if (piece) drewFor.set(order, { ...piece, shared: owner !== which });
        });
        // Which scenes ended up with something in front of the words at all: a picture scene with nothing to show
        // is a picture scene that has to become its words.
        const sceneGot = new Set(edit.shots.map((one, order) => (drewFor.has(order) ? one.scene : -1)).filter((one) => one >= 0));
        for (const [index, shot] of shots.entries()) {
          const layout = shot.scene.layout;
          // A device scene is a screenshot inside a mockup, so nothing but a real screenshot will do: a drawn
          // picture behind the words is not the product, and an empty phone frame is worse than a sentence.
          if (layout === 'device' && !shot.image) shot.scene = fallbackOf(shot.scene);
          if (layout === 'picture' && !shot.image && !sceneGot.has(index)) shot.scene = fallbackOf(shot.scene);
          if ((layout === 'footage' || layout === 'clip' || layout === 'presenter') && !shot.video && !shot.image) shot.scene = fallbackOf(shot.scene);
          // A scene that lost its words to the captions and then lost its picture to a refused call would be three
          // seconds of nothing at all. Whenever there is nothing written on a scene, the words come back — the
          // line it is already saying, cut to a headline.
          const silentOnScreen = ![shot.scene.heading, shot.scene.text, ...(shot.scene.bullets ?? [])].some((one) => one?.trim());
          // A moving shot, or a real picture or screen filling the frame, carries a scene on its own — one wordless
          // picture in three is the point. Anything else with nothing written on it is a gradient.
          //
          // …and in a captioned film a photograph behind the words carries it too, because the words being said
          // are already on the frame. This line is where a real reel lost its caption track: the critic had taken
          // the narration off three scenes precisely so the captions could say it, and then this put a headline
          // cut from the same sentence straight back on — which silenced the captions again. A scene needs words
          // of its own only when there is nothing else at all.
          const carries = !!shot.video || (!!shot.image && (shot.scene.layout === 'picture' || shot.scene.layout === 'device'))
            || (captions && sceneGot.has(index) && !!shot.scene.say);
          if (silentOnScreen && shot.scene.say && !carries) {
            shot.scene = { ...shot.scene, layout: shot.scene.layout === 'picture' ? 'statement' : shot.scene.layout, text: headlineOf(shot.scene.say ?? '', 6) || trimTo(shot.scene.say, 6) };
          }
        }

        // The shot list as the renderer wants it: one entry a shot, each with the scene it belongs to, its own
        // picture, the hold measured off that picture and the push the editor asked for. Two shots of one scene
        // never show the same frame — a picture change that changes nothing is worse than a hold.
        // The picture a scene ended up with, whichever of its shots was the one that got it. A second take of a
        // picture scene whose own picture was never drawn used to render an <img> pointed at nothing.
        const sceneHas = new Map<number, Drawn & { shared: boolean }>();
        edit.shots.forEach((one, order) => {
          const drew = drewFor.get(order);
          if (drew && !sceneHas.has(one.scene)) sceneHas.set(one.scene, drew);
        });
        const cut: Shot[] = edit.shots.map((one, order): Shot => {
          const base = shots[one.scene];
          const fills = base.scene.layout === 'picture' || base.scene.layout === 'logo';
          const drew = drewFor.get(order) ?? (fills ? sceneHas.get(one.scene) : undefined);
          return {
            ...base,
            seconds: one.seconds,
            take: one.take,
            punch: one.punch ? { ...one.punch, at: Math.max(0, one.punch.at - one.at) } : undefined,
            ...(drew && !base.video && !base.image
              ? (fills
                ? { image: drew.file, scrim: drew.hold, lift: drew.lift, plies: drew.plies }
                : { bg: drew.file, bgShared: drew.shared, scrim: drew.hold, lift: drew.lift, plies: drew.plies })
              : {}),
          };
        });
        holdTheLastPicture(cut, (file) => {
          const subject = madeFrom.get(file)?.subject;
          if (subject === undefined) return 0;
          const score = worldScore(subject, world);
          return score < 0 ? -1 : 1 + score;
        });
        let total = edit.total;

        // The bed. The founder's own track first; failing that whatever the music maker can write for the mood.
        let music: { file: string; seconds: number } | undefined;
        let credit: Credit | undefined;
        let beats: number[] | undefined;
        let bedFile = '';
        if (mood !== 'none' && !noFf) {
          if (bed) bedFile = deps.fileOf?.(bed.path) ?? bed.path;
          else if (bedWork) {
            const wrote = await bedWork;
            if (wrote.made) {
              bedFile = join(at, 'assets', `bed-source.${wrote.made.ext}`);
              await writeFile(bedFile, wrote.made.bytes);
              credit = wrote.made.credit;
              beats = wrote.made.beats;
            } else report(`no music this time: ${wrote.error?.message}`);
          } else report('no music is set up — drop a music file on the card and the next film will have a bed under it');
        }
        // A cut lands better on a beat than a hair away from one — but only in a film with nobody talking over it.
        // Where narration leads, the phrase is the beat, and pulling a cut off the word onto the drum is the very
        // thing that makes an edit feel mechanical.
        if (beats?.length && !words.length) {
          const snapped = snapToBeats(cut.map((one) => one.seconds), beats);
          snapped.forEach((value, index) => { cut[index].seconds = value; });
          report('nobody is speaking, so the cuts are pulled onto the beat');
        }

        const { starts, total: clock } = startsOf(cut);
        total = clock;

        // The sounds the film is cut with: the editor's, capped at five and each on a cut frame, rather than one
        // on every entrance of every element. An effect on every cut is what a template sounds like.
        const cues = edit.cues;
        for (const sound of new Set(cues.map((one) => one.sound))) {
          await copyFile(join(SFX_DIR, sfxFile(sound)), join(at, 'assets', sfxFile(sound))).catch(() => {});
        }
        if (bedFile && mood !== 'none') {
          report('mixing the music under the narration…');
          // Where the bed has to get out of the way, and by how much: the editor works it out from the narration
          // it has just measured, rather than from where a scene happens to start.
          const windows = edit.ducks.map((one) => ({ at: one.at, seconds: one.seconds }));
          await musicBed({ from: bedFile, to: join(at, 'assets', 'bed.wav'), seconds: total, mood: mood as MusicMood, windows, signal })
            .then(() => { music = { file: 'bed.wav', seconds: total }; }, (error: Error) => report(`the music could not be mixed: ${error.message}`));
        }
        if (credit && music) report(`Music: ${credit.title} by ${credit.by} · ${credit.licence}`);
        if (voiceTerms) report(`Voice: OmniVoice · CC-BY-NC 4.0 · this film is ${NONCOMMERCIAL.replace(' (its', ' (the voice\'s')}`);

        // The words a film turns on, which are what the caption track lights up.
        const keywords = [...new Set(edit.shots.map((one) => one.keyword).filter(Boolean) as string[])];
        // And where it must stay quiet: the stretches of narration whose scene already writes the line out.
        // Where the caption track must stay quiet: a scene that already writes out what is being said, and a scene
        // whose own type grows down into the band the captions live in. Two systems of type in one part of the
        // frame is not a caption track, it is a collision — a real reel put the word "AWAY." on top of a checklist.
        const quiet = quietOf(cut, starts);
        // A film whose scenes nearly all write their own words has almost no caption track left, and a founder who
        // switched captions on deserves to hear that from the card rather than to notice it in the film.
        const hushed = quiet.reduce((sum, one) => sum + one.seconds, 0);
        if (captions && total > 0 && hushed > total * 0.6) {
          report('most of this film writes its own words on screen, so the captions stay out of the way — two sets of words in one place is read as neither');
        }

        const film: Film = {
          title: spec.title, shape, look: pack === 'brand' && !brand ? 'clean' : pack, shots: cut, pace, captions, brand,
          bed: music, cues, beats, voice, words, keywords, quiet,
        };
        const { bytes, poster } = await renderProject(bin, at, film, { draft, report, signal });
        // A film read in a non-commercial voice says so beside itself, with the music's credit, so the terms go
        // wherever the file goes.
        const nc = voiceTerms ? [
          'The narration in this film was made with OmniVoice. The film is not for commercial use.',
          '', voiceTerms.trim(), ...(credit && music ? ['', `Music: ${credit.title} by ${credit.by} · ${credit.licence} · ${credit.source}`] : []), '',
        ].join('\n') : '';
        // Who took the photographs on screen. Pexels does not ask for a credit, but a film that carries somebody's
        // photograph should be able to say whose it is wherever the file goes.
        // Real footage is credited the same way, and CC BY footage must be.
        const photos = photoCredits(cut.flatMap((one) => [one.image, one.bg, one.video])
          .map((file) => (file ? madeFrom.get(file)?.credit ?? clipCredits.get(file) : undefined)));
        const terms = nc || photos ? [nc.trimEnd(), photos].filter(Boolean).join('\n\n') + '\n' : '';
        // A finished film goes out with the same film laid out as tracks, for a founder who wants to move one cut by
        // hand. A draft does not: it is a film to look at, not one to finish.
        const handEdit = draft ? undefined : await editPlan(film, at).catch(() => undefined);
        // …and with a record of what it was made of, so notes on it remake only what they touch. The pictures the
        // founder handed over and the moving shots are theirs or were costly, and are never made again.
        let record: FilmRecord | undefined;
        if (handEdit) {
          for (const [index, shot] of shots.entries()) {
            if (shot.image && !madeFrom.has(shot.image)) madeFrom.set(shot.image, { kind: 'given', hash: `given:${shot.image}` });
            if (shot.video) madeFrom.set(shot.video, { kind: 'video', hash: `video:${index}:${shot.video}`, ...(clipCredits.has(shot.video) ? { credit: clipCredits.get(shot.video) } : {}) });
          }
          const bedSource = bedFile ? `bed-source${extname(bedFile).toLowerCase() || '.wav'}` : '';
          record = recordOf({
            title: spec.title, spec: { ...spec, scenes: shots.map((one) => one.scene) }, shape, look: film.look, pace, captions, sfx, music: mood, bible,
            shots: edit.shots.map((one, order) => ({ ...cut[order], scene: one.scene, take: one.take, seconds: cut[order].seconds })),
            narrator: voice && saying ? { voice: narrator.id, ...(omni ? { engine: OMNI_ENGINE, design: reading.design, ...(reading.ref ? { ref: reading.ref, ...(reading.refText ? { refText: reading.refText } : {}) } : {}), ...(reading.language ? { language: reading.language } : {}) } : {}), file: voice.file, seconds: voice.seconds } : undefined,
            words, pictures: Object.fromEntries(madeFrom),
            bed: bedSource && music ? { source: bedSource, mood, own: !!bed, ...(credit ? { credit } : {}) } : undefined,
            brand,
          });
          // What the record names and the hand-editable export does not carry: the planes a still was cut into, and
          // the bed before it was ducked under this narration.
          await carryExtras(handEdit, at, [...cut.flatMap((one) => (one.plies ? [one.plies.back, one.plies.mid, one.plies.fore] : [])), ...(voice ? [voice.file] : [])]);
          if (bedSource) {
            const read = await readFile(bedFile).catch(() => null);
            if (read) handEdit.files.push({ name: bedSource, bytes: read }); else record.bed = undefined;
          }
        }
        return { ext: 'mp4', bytes, poster, credit, ...(nc ? { noncommercial: true } : {}), ...(terms ? { credits: terms } : {}), ...(handEdit ? { edit: handEdit } : {}), ...(record ? { record } : {}) };
      });
    },
  };
}

// The studio's other halves, by the names the app has always imported them under.
export { fakeVideos, fakeVideosOf } from './fake-video.ts';
export type { VideoAsk, VideoDeps } from './gather.ts';

// The close holds the film's last picture behind its line. Journey 13: a farmers market film ended on four seconds of
// a plain gold gradient behind "Find fresh harvest this weekend", which reads as the film running out of pictures.
// The close is still set on its own words and nothing new is drawn for it: the picture the film last showed carries
// on under it, dimmed by its scrim, until the voice and the music end.
//
// Given how well each picture sits in the film's world (`score`, by file), the close holds the best of them rather
// than whichever came last: journey 14's voicemail film closed on eight seconds of a bronze anchor. Of equals, the
// latest is held, so the film still runs on into its close.
export function holdTheLastPicture(cut: Shot[], score?: (file: string) => number): void {
  const last = cut.at(-1);
  if (!last || last.video || last.image || last.bg || !closesOnGround(last.scene.layout, cut.length - 1, cut.length)) return;
  let held: Shot | undefined;
  let best = -Infinity;
  for (let index = cut.length - 2; index >= 0; index -= 1) {
    const one = cut[index];
    const file = one.bg ?? (one.scene.layout === 'picture' ? one.image : undefined);
    if (!file) continue;
    const mark = score ? score(file) : 0;
    if (mark > best) { held = one; best = mark; }
    if (!score) break;
  }
  if (!held) return;
  const file = held.bg ?? held.image!;
  Object.assign(last, { bg: file, bgShared: true, scrim: Math.max(held.scrim ?? 0, 0.55), lift: held.lift, plies: held.plies });
}
