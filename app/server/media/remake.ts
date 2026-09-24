import { mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { musicBed, SFX_DIR, sfxFile } from './audio.ts';
import { liftFor, meanLight, scrimFor } from './contrast.ts';
import { bibleFor, type Understanding } from './director.ts';
import {
  applyEdits, creditsLine, lengthOf, notesToEdits, opsWords, pictureHash, reuseLine, reuseOf, versionName,
  type EditOp, type EditedScene, type FilmRecord, type RecordPicture, type RecordShot,
} from './edits.ts';
import { editFilm, cuttingFor, type Take } from './editor.ts';
import { ffReady } from './ff.ts';
import { atRate, joinPcm, pcmSeconds, partName, readPcm, recordOf, silence, slicePcm, wavOfPcm, type Pcm } from './film-record.ts';
import { fitStill } from './footage.ts';
import { cachedImages } from './image.ts';
import type { Piece } from './jobs.ts';
import type { Mood as MusicMood } from './music.ts';
import { NONCOMMERCIAL, OMNI_ENGINE } from './omnivoice.ts';
import { content, crowdsCaptions, fallbackOf, saysWhatItShows, type Scene } from './spec.ts';
import { FORMATS, PACE, PACK, paintOf, type Film, type Pace, type Shot } from './templates/index.ts';
import { timeWords, type Word } from './timings.ts';
import { drawnAs, kindFor, roomFor, visualFrom, type Visual } from './visuals.ts';
import { engineOf } from './voice.ts';
import { editPlan, renderProject, stageVendor, type VideoDeps } from './video.ts';

type Help = { report: (line: string) => void; signal?: AbortSignal };
type Tools = { bin: string; vendor: string };

// Notes on a finished film, read and acted on. The notes are read into operations (`edits.ts`), and the film is
// remade from its own record: what the notes touched is made again, everything else is the old film's own file.
export async function remakeVideo(deps: VideoDeps, ask: { film: string; notes: string; record?: FilmRecord }, help: Help, tools: Tools): Promise<Piece> {
  const { report } = help;
  const record = ask.record;
  if (!record) throw new Error('there is no record of what that film was made of, so notes cannot remake it');
  report(`reading the notes on ${ask.film.split('/').pop()}…`);
  const read = await notesToEdits(ask.notes, record, deps.think);
  for (const note of read.unread) report(`I could not read: ${note}`);
  if (!read.ops.length) throw new Error(read.unread.length ? `nothing in the notes could be read as an edit (I could not read: ${read.unread.join('; ')})` : 'the notes asked for nothing to change');
  report(`the notes, read: ${opsWords(read.ops)}`);
  return remakeFilm({ path: ask.film, record }, read.ops, help, deps, tools);
}

// Where a scene's words sit and what they sound like, on the scene's own clock.
type Segment = { pcm: Pcm; words: Word[] };
const shiftWords = (words: Word[], by: number): Word[] => words.map((one) => ({ ...one, at: Math.round((one.at + by) * 1000) / 1000 }));
const spokenSpan = (words: Word[]): [number, number] => [words[0].at, words.at(-1)!.at + words.at(-1)!.seconds];

// A line with the breath around it set again: `lead` before the first word and `tail` after the last. The words
// themselves are never touched; only the silence either side of them is cut or added.
export function reshape(segment: Segment, lead: number, tail: number): Segment {
  if (!segment.words.length) return segment;
  const [first, end] = spokenSpan(segment.words);
  const from = first - lead;
  const to = end + tail;
  const length = pcmSeconds(segment.pcm);
  const body = slicePcm(segment.pcm, Math.max(0, from), Math.min(length, to));
  const rate = segment.pcm.rate;
  return {
    pcm: joinPcm([silence(Math.max(0, -from), rate), body, silence(Math.max(0, to - length), rate)], rate),
    words: shiftWords(segment.words, -from),
  };
}

// A scene held for the seconds asked. A line is never cut short to fit: a scene that has to say more than it was
// given holds for its line and the founder is told, because a sentence that stops mid-word is not a trim.
export function fitTo(segment: Segment, seconds: number): { segment: Segment; held: number; short: boolean } {
  const rate = segment.pcm.rate;
  if (!segment.words.length) {
    const want = seconds || pcmSeconds(segment.pcm);
    return { segment: { pcm: joinPcm([slicePcm(segment.pcm, 0, want), silence(Math.max(0, want - pcmSeconds(segment.pcm)), rate)], rate), words: [] }, held: want, short: false };
  }
  const [first, end] = spokenSpan(segment.words);
  const said = end - first;
  // "As short as its line": a breath before, a beat after.
  if (!seconds) { const tight = reshape(segment, 0.12, 0.3); return { segment: tight, held: pcmSeconds(tight.pcm), short: false }; }
  if (seconds < said + 0.3) { const tight = reshape(segment, 0.1, 0.2); return { segment: tight, held: pcmSeconds(tight.pcm), short: true }; }
  const room = seconds - said;
  const fitted = reshape(segment, room * 0.35, room * 0.65);
  return { segment: fitted, held: pcmSeconds(fitted.pcm), short: false };
}

const FILLS = new Set(['picture', 'logo']);

export async function remakeFilm(film: { path: string; record: FilmRecord }, ops: EditOp[], help: Help, deps: VideoDeps, tools: Tools): Promise<Piece> {
  const { record } = film;
  const { report, signal } = help;
  const base = film.path.replace(/\.[^./]+$/, '');
  const part = (name: string) => `${base}.parts/${name}`;
  const edited = applyEdits(record, ops);
  for (const problem of edited.problems) report(`not done: ${problem}`);
  if (!edited.done.length) throw new Error(`none of the notes could be done (${edited.problems.join('; ')})`);
  const pack = edited.look;
  const pace: Pace = edited.pace;
  const bible = pack === record.look ? record.bible : bibleFor({ pack } as Understanding);
  const reuse = reuseOf(record, edited, bible);
  const at = join(deps.dir, '.video', `edit-${Date.now().toString(36)}`);
  try {
    await mkdir(join(at, 'assets'), { recursive: true });
    await mkdir(join(at, 'vendor'), { recursive: true });
    await stageVendor(tools.vendor, at, pack);
    const shape = record.shape;
    const { width, height } = FORMATS[shape];
    const noFf = await ffReady();
    const brand = pack === 'brand' ? record.brand : undefined;
    const paint = paintOf(pack, brand);
    // A file out of the old film's parts, brought into this project under the same name. Once is enough.
    const brought = new Map<string, Promise<boolean>>();
    const bring = (name?: string): Promise<boolean> => {
      if (!name) return Promise.resolve(false);
      if (!brought.has(name)) {
        brought.set(name, (async () => {
          const bytes = await deps.readFile?.(part(name)).catch(() => null);
          if (!bytes) return false;
          await writeFile(join(at, 'assets', name), bytes);
          return true;
        })());
      }
      return brought.get(name)!;
    };

    const scenes: Scene[] = edited.scenes.map((one) => ({ ...one.scene }));
    // Somebody speaking on camera was lip-synced to the line they said. A new line cannot be put in an old mouth, so
    // that scene becomes the film's own pictures, and the founder hears why.
    edited.scenes.forEach((one, index) => {
      const moved = record.scenes[one.was].shots.some((shot) => shot.voice);
      if (one.line && scenes[index].layout === 'presenter' && moved) {
        scenes[index] = fallbackOf(scenes[index]);
        report(`shot ${index + 1} had somebody saying the old line, so the new one is said over a picture instead`);
      }
    });

    // --- the narration: the old reading, cut where the lines meet, with only the changed lines said again ---------
    const narrator = record.narrator;
    const voice = edited.voice ?? narrator?.voice ?? '';
    const engine = edited.engine ?? narrator?.engine;
    const reader = engine === OMNI_ENGINE ? engineOf(deps.voices, OMNI_ENGINE) : deps.voices;
    const readerAsk = { prompt: '', ...(engine === OMNI_ENGINE ? { engine: OMNI_ENGINE, design: narrator?.design } : {}) };
    const saying = narrator && reader && !reader.ready(engine === OMNI_ENGINE ? readerAsk : undefined) ? reader : null;
    const oldBytes = narrator ? await deps.readFile?.(part(narrator.file)).catch(() => null) : null;
    const old = oldBytes ? readPcm(oldBytes) : null;
    if (narrator && !old) report('the old narration could not be read back, so every line is said again');
    const rate = old?.rate ?? 24_000;
    const lead = PACE[pace].lead;
    let keptLines = 0;
    let saidLines = 0;
    const sayLine = async (text: string, index: number): Promise<Segment | null> => {
      if (!saying) return null;
      try {
        const piece = await saying.make({ ...readerAsk, prompt: text, voice }, { report: () => {}, signal });
        const heard = readPcm(piece.bytes);
        if (!heard) throw new Error('the recording could not be read');
        const file = join(at, 'assets', `line-${index}.wav`);
        await writeFile(file, piece.bytes);
        const script = text.split(/\s+/).filter(Boolean);
        const timed = await timeWords(tools.bin, file, piece.parts ?? [{ text, seconds: pcmSeconds(heard) }], 0, { script, signal })
          .catch(() => ({ words: [] as Word[] }));
        const pcm = atRate(heard, rate);
        return reshape({ pcm, words: timed.words }, lead, PACE[pace].tail);
      } catch (error) {
        report(`shot ${index + 1}'s line could not be said again (${(error as Error).message})`);
        return null;
      }
    };
    const segments: Segment[] = [];
    const trimmed: string[] = [];
    for (const [index, one] of edited.scenes.entries()) {
      const was = record.scenes[one.was];
      const oldSeconds = was.shots.reduce((sum, shot) => sum + shot.seconds, 0) || PACE[pace].floor;
      let segment: Segment | null = null;
      const plan = !old && reuse.lines[index] === 'keep' ? 'say' : reuse.lines[index];
      if (plan === 'keep' && old && was.line) { segment = { pcm: slicePcm(old, was.line.from, was.line.to), words: was.line.words }; keptLines += 1; }
      else if (plan === 'say' && scenes[index].say?.trim()) {
        segment = await sayLine(scenes[index].say!.trim(), index);
        if (segment) saidLines += 1;
        // A line that could not be said again keeps the old one where there is one, and is otherwise a silence.
        else if (old && was.line && !one.line) { segment = { pcm: slicePcm(old, was.line.from, was.line.to), words: was.line.words }; keptLines += 1; }
      }
      segment ??= { pcm: silence(oldSeconds, rate), words: [] };
      if (pace !== record.pace && segment.words.length) segment = reshape(segment, lead, PACE[pace].tail);
      if (one.trim !== undefined) {
        const fitted = fitTo(segment, one.trim);
        segment = fitted.segment;
        if (fitted.short) trimmed.push(`shot ${one.was + 1} takes ${fitted.held.toFixed(1)} seconds to say its line, so it holds that long rather than ${one.trim}`);
      }
      segments.push(segment);
    }
    for (const line of trimmed) report(line);
    if (signal?.aborted) throw new Error('stopped');

    // One reading again, laid end to end, and every word on the film's own clock.
    const starts: number[] = [];
    let clock = 0;
    for (const segment of segments) { starts.push(clock); clock += pcmSeconds(segment.pcm); }
    const words: Word[] = narrator ? segments.flatMap((segment, index) => shiftWords(segment.words, starts[index])) : [];
    let voiceFile: { file: string; seconds: number } | undefined;
    if (narrator && words.length) {
      const joined = joinPcm(segments.map((one) => one.pcm), rate);
      await writeFile(join(at, 'assets', 'say.wav'), wavOfPcm(joined));
      voiceFile = { file: 'say.wav', seconds: pcmSeconds(joined) };
    }

    // --- the cut: the editor again, on the new clock. It is deterministic, so what did not move cuts as it did ------
    const style = cuttingFor(pack, pace);
    const videoOf = (one: EditedScene) => record.scenes[one.was].shots.find((shot) => shot.video)?.video;
    const takes: Take[] = scenes.map((scene, index): Take => {
      const seconds = pcmSeconds(segments[index].pcm);
      return {
        scene, index, from: starts[index], to: starts[index] + seconds,
        moving: !!videoOf(edited.scenes[index]) && scene.layout !== 'statement',
        least: segments[index].words.length ? 0 : seconds,
      };
    });
    const edit = editFilm(takes, words, style, { sfxOn: record.sfx });
    report(`${edit.shots.length} shots over ${scenes.length} scenes, ${Math.round(edit.total)} seconds`);

    // --- the pictures: the old ones where the notes left them, new ones where they asked --------------------------
    const drawing = deps.images && !deps.images.ready()
      ? cachedImages(deps.images, deps.cacheDir ? join(deps.cacheDir, 'pictures') : join(deps.dir, '.cache', 'pictures'))
      : null;
    const pictures: Record<string, RecordPicture> = {};
    const kept = new Set<string>();
    const drawn = new Set<string>();
    const swapped = new Map<number, string | null>();
    const told = new Set<string>();
    const tell = (line: string) => { if (!told.has(line)) { told.add(line); report(line); } };
    const newPicture = async (index: number, take: number, order: number, old?: RecordShot): Promise<{ file: string; scrim?: number; lift?: number } | null> => {
      const one = edited.scenes[index];
      const scene = scenes[index];
      // A picture the founder named: their own file, fitted to the frame once for the whole scene.
      if (one.picture?.asset) {
        if (!swapped.has(index)) {
          const source = deps.fileOf?.(one.picture.asset) ?? one.picture.asset;
          const file = `swap-${index}.png`;
          const done = await fitStill(source, join(at, 'assets', file), width, height, signal).then(() => file, () => null);
          if (!done) tell(`${one.picture.asset.split('/').pop()} could not be read, so shot ${index + 1} keeps its picture`);
          swapped.set(index, done);
          if (done) pictures[done] = { kind: 'given', hash: `given:${one.picture.asset}` };
        }
        const file = swapped.get(index);
        return file ? { file } : null;
      }
      if (!drawing) { tell(`no picture maker is set up, so shot ${index + 1} keeps its picture`); return null; }
      const was = old ? [old.image, old.bg].find((file) => file && record.pictures[file]) : undefined;
      const before = was ? record.pictures[was]?.subject : undefined;
      const line = scene.say ?? scene.text ?? scene.heading ?? '';
      // What to draw: what the founder asked for; the same subject in the new look; or, for "a new picture" and no
      // more, a subject out of the line that steers clear of the words the old one was drawn from.
      const subject = one.picture?.prompt
        ? (take ? `${one.picture.prompt}, from another side` : one.picture.prompt)
        : !one.picture && before ? before
          : visualFrom(line, index + take, new Set(content(before ?? '')));
      const visual: Visual = { at: order, scene: index, take, line, subject, kind: kindFor(order, scene.layout), room: roomFor(scene, edited.captions) };
      try {
        const piece = await drawing.make({ prompt: drawnAs(visual, bible), shape }, { report: () => {}, signal });
        const file = `frame-e${index}-${take}.${piece.ext}`;
        const path = join(at, 'assets', file);
        await writeFile(path, piece.bytes);
        pictures[file] = { kind: 'drawn', hash: pictureHash(subject, bible, shape), subject };
        const big = scene.layout === 'hook' || scene.layout === 'stat' || scene.layout === 'title';
        const scrim = await scrimFor(path, visual.room === 'top' ? 'top' : 'foot', paint.quiet, paint.ground, { big, floor: PACK[pack].scrim * 0.35 }).catch(() => null);
        const light = PACK[pack].format?.grade ? await meanLight(path).catch(() => null) : null;
        return { file, scrim: scrim ?? undefined, lift: light === null ? undefined : liftFor(light) };
      } catch (error) {
        tell(`shot ${index + 1} keeps its picture: ${(error as Error).message}`);
        return null;
      }
    };

    const cut: Shot[] = [];
    for (const [order, one] of edit.shots.entries()) {
      const index = one.scene;
      const oldShots = record.scenes[edited.scenes[index].was].shots;
      // The same take of the same scene, where the old cut had one; otherwise one of that scene's own pictures again.
      const old = oldShots.find((shot) => shot.take === one.take) ?? oldShots[one.take % Math.max(1, oldShots.length)];
      const shot: Shot = {
        scene: scenes[index], seconds: one.seconds, take: one.take,
        punch: one.punch ? { ...one.punch, at: Math.max(0, one.punch.at - one.at) } : undefined,
      };
      if (old?.video && scenes[index].layout !== 'statement' && await bring(old.video)) shot.video = old.video;
      if (old?.voice && reuse.lines[index] === 'keep' && await bring(old.voice.file)) shot.voice = old.voice;
      const oldPicture = old?.image ?? old?.bg;
      const own = oldPicture && record.pictures[oldPicture]?.kind === 'given' && !!old?.image && !FILLS.has(scenes[index].layout);
      let placed = false;
      if (reuse.pictures[index] === 'draw' && !shot.video && !own) {
        const made = await newPicture(index, one.take, order, old);
        if (made) {
          if (FILLS.has(scenes[index].layout) || (!old?.bg && !old?.image && scenes[index].layout === 'picture')) shot.image = made.file; else shot.bg = made.file;
          shot.scrim = made.scrim; shot.lift = made.lift;
          drawn.add(made.file);
          placed = true;
        }
      }
      if (!placed && old) {
        if (old.image && await bring(old.image)) { shot.image = old.image; kept.add(old.image); }
        if (old.bg && await bring(old.bg)) { shot.bg = old.bg; kept.add(old.bg); }
        shot.scrim = old.scrim;
        shot.lift = old.lift;
        shot.bgShared = old.bgShared || old.take !== one.take;
        if (old.plies && (await Promise.all([bring(old.plies.back), bring(old.plies.mid), bring(old.plies.fore)])).every(Boolean)) shot.plies = old.plies;
      }
      if (shot.image && record.pictures[shot.image]) pictures[shot.image] = record.pictures[shot.image];
      if (shot.bg && record.pictures[shot.bg]) pictures[shot.bg] = record.pictures[shot.bg];
      if (shot.video) pictures[shot.video] = record.pictures[shot.video] ?? { kind: 'video', hash: `video:${shot.video}` };
      // A picture scene that has nothing to show any more becomes its words, as it would in a new film.
      if (scenes[index].layout === 'picture' && !shot.image && !shot.bg) shot.scene = fallbackOf(scenes[index]);
      cut.push(shot);
    }
    report(reuseLine({ ...reuse, keptPictures: kept.size, drawPictures: drawn.size, keptLines, sayLines: saidLines }));
    if (signal?.aborted) throw new Error('stopped');

    // --- the music: the same bed, unless the notes changed it or the film moved more than a tenth ------------------
    const total = Math.round(cut.reduce((sum, one) => sum + one.seconds, 0) * 100) / 100;
    const mood = edited.music;
    let music: { file: string; seconds: number } | undefined;
    let credit = record.bed?.credit;
    let bedSource = '';
    if (mood !== 'none' && !noFf) {
      const before = lengthOf(record);
      const moved = before > 0 && Math.abs(total - before) > before * 0.1;
      const same = record.bed && (record.bed.own || (record.bed.mood === mood && !moved));
      if (same && await bring(record.bed!.source)) {
        bedSource = record.bed!.source;
        report(record.bed!.own ? 'your music, kept' : 'the music, kept');
      } else if (deps.music) {
        report(`writing the music again, ${record.bed?.mood !== mood ? `for a ${mood} bed` : `because the film is ${total > before ? 'longer' : 'shorter'} by more than a tenth`}…`);
        const made = await deps.music.bed({ mood: mood as MusicMood, seconds: Math.ceil(total) + 2 }, { report, signal }).catch((error: Error) => { report(`no music this time: ${error.message}`); return null; });
        if (made) { bedSource = `bed-source.${made.ext}`; await writeFile(join(at, 'assets', bedSource), made.bytes); credit = made.credit; }
      } else if (record.bed && await bring(record.bed.source)) bedSource = record.bed.source;
      if (bedSource) {
        await musicBed({ from: join(at, 'assets', bedSource), to: join(at, 'assets', 'bed.wav'), seconds: total, mood: mood as MusicMood, windows: edit.ducks.map((one) => ({ at: one.at, seconds: one.seconds })), signal })
          .then(() => { music = { file: 'bed.wav', seconds: total }; }, (error: Error) => report(`the music could not be mixed: ${error.message}`));
      }
    } else if (mood === 'none' && record.music !== 'none') report('no music under it');
    for (const sound of new Set(edit.cues.map((one) => one.sound))) await copyFile(join(SFX_DIR, sfxFile(sound)), join(at, 'assets', sfxFile(sound))).catch(() => {});

    const shotStarts: number[] = [];
    let running = 0;
    for (const shot of cut) { shotStarts.push(running); running = Math.round((running + shot.seconds) * 100) / 100; }
    const quiet = cut.map((shot, index) => (saysWhatItShows(shot.scene) || crowdsCaptions(shot.scene) ? { at: shotStarts[index], seconds: shot.seconds } : null))
      .filter(Boolean) as { at: number; seconds: number }[];
    const made: Film = {
      title: record.title, shape, look: pack, shots: cut, pace, captions: edited.captions, brand,
      bed: music, cues: edit.cues, voice: voiceFile, words, keywords: [...new Set(edit.shots.map((one) => one.keyword).filter(Boolean) as string[])], quiet,
    };
    const { bytes, poster } = await renderProject(tools.bin, at, made, { report, signal });

    // The new version carries its own parts, its own project and its own record, so it can be edited in turn.
    const handEdit = await editPlan(made, at).catch(() => undefined);
    const version = versionName(film.path);
    const credits = creditsLine(film.path, edited.done);
    // A scene is what its first shot showed: a picture scene left with nothing to show became its words.
    const final = scenes.map((scene, index) => cut.find((_, order) => edit.shots[order].scene === index)?.scene ?? scene);
    const next = recordOf({
      title: record.title, spec: { ...edited.spec, scenes: final }, counts: segments.map((one) => one.words.length),
      shape, look: pack, pace, captions: edited.captions, sfx: record.sfx, music: mood, bible,
      shots: cut.map((shot, order) => ({ ...shot, scene: edit.shots[order].scene, take: edit.shots[order].take, seconds: shot.seconds })),
      narrator: narrator && voiceFile ? { voice, ...(engine ? { engine } : {}), ...(narrator.design ? { design: narrator.design } : {}), file: voiceFile.file, seconds: voiceFile.seconds } : undefined,
      words, pictures, brand: record.brand,
      bed: bedSource && music ? { source: bedSource, mood, ...(record.bed?.own && bedSource === record.bed.source ? { own: true } : {}), ...(credit ? { credit } : {}) } : undefined,
    });
    Object.assign(next, { version: version.version, root: record.root ?? film.path, from: film.path, notes: opsWords(edited.done), credits });
    if (handEdit) {
      const carried = new Set(handEdit.files.map((one) => one.name));
      const extra = [...cut.flatMap((one) => (one.plies ? [one.plies.back, one.plies.mid, one.plies.fore] : [])), ...(voiceFile ? [voiceFile.file] : []), ...(bedSource ? [bedSource] : [])];
      for (const name of extra) {
        const safe = partName(name);
        if (!safe || carried.has(safe)) continue;
        const read = await readFile(join(at, 'assets', name)).catch(() => null);
        if (read) { handEdit.files.push({ name: safe, bytes: read }); carried.add(safe); }
      }
    }
    const omni = engine === OMNI_ENGINE;
    const terms = [credits, ...(omni ? ['', `The narration was made with OmniVoice. This film is ${NONCOMMERCIAL}.`] : []),
      ...(credit && music ? ['', `Music: ${credit.title} by ${credit.by} · ${credit.licence} · ${credit.source}`] : []), ''].join('\n');
    report(`saved as ${version.stem.split('/').pop()}.mp4 — ${credits}`);
    return {
      ext: 'mp4', bytes, poster, name: version.stem, record: next, credits: terms,
      ...(credit && music ? { credit } : {}), ...(omni ? { noncommercial: true } : {}), ...(handEdit ? { edit: handEdit } : {}),
    };
  } finally {
    if (process.env.STAGE_KEEP_PROJECT === '1') report(`the project this was rendered from is at ${at}`);
    else await rm(at, { recursive: true, force: true }).catch(() => {});
  }
}

// The same notes on a film in the fake-model mode: read and applied exactly as the real studio would, with the
// counting done on the record, and a second of colour for the film. What the card is told is the real line.
export async function fakeRemake(ask: { film: string; notes: string; record: FilmRecord }, report: (line: string) => void): Promise<Pick<Piece, 'record' | 'name' | 'credits'>> {
  const { record } = ask;
  report(`reading the notes on ${ask.film.split('/').pop()}…`);
  const read = await notesToEdits(ask.notes, record);
  for (const note of read.unread) report(`I could not read: ${note}`);
  if (!read.ops.length) throw new Error(read.unread.length ? `nothing in the notes could be read as an edit (I could not read: ${read.unread.join('; ')})` : 'the notes asked for nothing to change');
  report(`the notes, read: ${opsWords(read.ops)}`);
  const edited = applyEdits(record, read.ops);
  for (const problem of edited.problems) report(`not done: ${problem}`);
  const reuse = reuseOf(record, edited, edited.look === record.look ? record.bible : bibleFor({ pack: edited.look } as Understanding));
  report(reuseLine(reuse));
  report(`rendering ${edited.scenes.length} scenes…`);
  const version = versionName(ask.film);
  const credits = creditsLine(ask.film, edited.done);
  const next: FilmRecord = {
    ...record, version: version.version, root: record.root ?? ask.film, from: ask.film, notes: opsWords(edited.done), credits,
    spec: edited.spec, look: edited.look, pace: edited.pace, captions: edited.captions, music: edited.music,
    scenes: edited.scenes.map((one) => record.scenes[one.was]),
  };
  report(`saved as ${version.stem.split('/').pop()}.mp4 — ${credits}`);
  return { record: next, name: version.stem, credits: `${credits}\n` };
}

