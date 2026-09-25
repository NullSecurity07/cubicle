import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { emptyInterview, isAudioName, totalSeconds, type Interview, type InterviewEvent, type InterviewInsights, type InterviewRecording } from '../../shared/interviews.ts';
import type { Stage } from '../../shared/model.ts';
import type { Ear } from './hear.ts';

export const interviewCardIds = (stage: Stage) => (stage.cards ?? []).filter((card) => card.kind === 'interview').map((card) => card.id);

// Turning any recording into a 16 kHz wav at `output`, and saying how long it is in seconds.
export type Convert = (input: string, output: string, signal?: AbortSignal) => Promise<number>;
export type Interviews = ReturnType<typeof createInterviews>;

const safe = (id: string) => { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`bad id: ${id}`); return id; };
export const NO_CONSENT = 'Tick that they agreed to be recorded first.';

// One sidecar a card, one folder of sound beside it. The server owns both: the page only asks, and hears every change.
// Transcribing is one job at a time across every card, because each one takes the machine's cores while it runs.
export function createInterviews(dir: string, opts: { ear: Ear; convert: Convert; tell?: (cardId: string, event: InterviewEvent) => void; now?: () => number }) {
  const { ear, convert, tell = () => {}, now = Date.now } = opts;
  const home = join(dir, 'interviews');
  const sidecar = (cardId: string) => join(home, `${safe(cardId)}.json`);
  const folder = (cardId: string) => join(home, safe(cardId));
  const cache = new Map<string, Interview>();
  const revs = new Map<string, number>();
  let writes: Promise<unknown> = Promise.resolve();
  let jobs: Promise<unknown> = Promise.resolve();
  const stop = new AbortController();

  async function load(cardId: string): Promise<Interview> {
    const known = cache.get(cardId);
    if (known) return known;
    let data = emptyInterview();
    try { data = { ...data, ...JSON.parse(await readFile(sidecar(cardId), 'utf8')) }; } catch { /* a new card */ }
    // A job cut off by the app closing is not still running: it can be tried again.
    if (data.state === 'transcribing') data = { ...data, state: 'failed', problem: 'The app closed while this was being written down. Try again.', line: undefined };
    cache.set(cardId, data);
    revs.set(cardId, Math.max(revs.get(cardId) ?? 0, now()));
    return data;
  }
  function save(cardId: string) {
    const data = cache.get(cardId) ?? emptyInterview();
    const text = JSON.stringify(data, null, 2);
    writes = writes.then(async () => { await mkdir(home, { recursive: true }); await writeFile(`${sidecar(cardId)}.tmp`, text); await rename(`${sidecar(cardId)}.tmp`, sidecar(cardId)); }).catch(() => {});
    revs.set(cardId, Math.max((revs.get(cardId) ?? 0) + 1, now()));
    tell(cardId, { data, rev: revs.get(cardId)! });
  }
  async function change(cardId: string, edit: (data: Interview) => void): Promise<Interview> {
    const data = await load(cardId);
    edit(data);
    save(cardId);
    return data;
  }

  // Every recording written down again, in order, each one's lines carrying on from where the one before ended.
  // Runs behind any job already going; the card says what it is doing the whole time.
  function transcribe(cardId: string): Promise<void> {
    const job = jobs.then(async () => {
      const data = await load(cardId);
      if (!data.recordings.length) return;
      await change(cardId, (one) => { one.state = 'transcribing'; one.line = 'Writing the conversation down on this machine…'; delete one.problem; });
      const started = now();
      const work = join(folder(cardId), 'work');
      try {
        await mkdir(work, { recursive: true });
        const lines: Interview['transcript'] = [];
        let from = 0;
        let engine = '';
        for (const [index, recording] of data.recordings.entries()) {
          const wav = join(work, `rec-${index + 1}.wav`);
          const seconds = await convert(join(home, recording.path), wav, stop.signal);
          if (data.recordings.length > 1) await change(cardId, (one) => { one.line = `Writing down recording ${index + 1} of ${one.recordings.length} on this machine…`; });
          const heard = await ear.hear(wav, seconds, stop.signal);
          engine = heard.engine;
          for (const line of heard.lines) lines.push({ at: Math.round((line.at + from) * 10) / 10, text: line.text });
          from += recording.seconds;
        }
        await change(cardId, (one) => { one.transcript = lines; one.state = 'idle'; one.engine = engine; one.tookMs = now() - started; delete one.line; });
      } catch (error) {
        await change(cardId, (one) => { one.state = 'failed'; one.problem = `It could not be written down: ${(error as Error).message}`; delete one.line; });
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
      }
    });
    jobs = job.catch(() => {});
    return job;
  }

  return {
    settled: () => Promise.all([writes, jobs]),
    list: load,
    async read(cardId: string): Promise<InterviewEvent> { const data = await load(cardId); return { data, rev: revs.get(cardId)! }; },
    // The founder's tick. Taking it back is allowed and stops new recordings; what was recorded stays until removed.
    consent: (cardId: string, yes: boolean) => change(cardId, (data) => { data.consent = yes; if (yes) data.consentAt = now(); else delete data.consentAt; }),
    // A recording arrives as it is streamed, straight to disk. It is measured before it counts: a file with no sound
    // in it is thrown away and the card says why. Then the whole interview is written down again, this one included.
    async add(cardId: string, name: string, body: Readable, limit: number): Promise<InterviewRecording> {
      const data = await load(cardId);
      if (!data.consent) throw new Error(NO_CONSENT);
      if (data.state === 'transcribing') throw new Error('Wait until the last recording is written down.');
      if (!isAudioName(name)) throw new Error('That is not a recording this card can read. Use a wav, mp3, m4a, ogg, webm or mp4 file.');
      const ext = name.split('.').pop()!.toLowerCase();
      await mkdir(folder(cardId), { recursive: true });
      const path = `${safe(cardId)}/rec-${data.recordings.length + 1}-${now().toString(36)}.${ext}`;
      const full = join(home, path);
      let bytes = 0;
      try {
        await pipeline(async function* () {
          for await (const chunk of body) {
            bytes += (chunk as Buffer).length;
            if (bytes > limit) throw new Error(`That recording is too large (the limit is ${Math.round(limit / 1_000_000)} MB).`);
            yield chunk as Buffer;
          }
        }, createWriteStream(full));
        if (!bytes) throw new Error('That recording is empty.');
        const work = join(folder(cardId), 'work');
        await mkdir(work, { recursive: true });
        const seconds = await convert(full, join(work, 'measure.wav'), stop.signal).finally(() => rm(join(work, 'measure.wav'), { force: true }).catch(() => {}));
        if (!(seconds > 0.2)) throw new Error('That recording has no sound in it.');
        const recording: InterviewRecording = { path, seconds: Math.round(seconds * 10) / 10, at: now(), name: name.slice(-80) };
        await change(cardId, (one) => { one.recordings.push(recording); });
        void transcribe(cardId);
        return recording;
      } catch (error) {
        await rm(full, { force: true }).catch(() => {});
        throw error;
      }
    },
    transcribe,
    // A recording taken off the card: its sound goes to the workspace's trash, and the rest is written down again.
    async remove(cardId: string, index: number) {
      const data = await load(cardId);
      const gone = data.recordings[index];
      if (!gone) throw new Error('there is no such recording');
      if (data.state === 'transcribing') throw new Error('Wait until the recording is written down.');
      await mkdir(join(dir, 'trash'), { recursive: true });
      await rename(join(home, gone.path), join(dir, 'trash', `${now().toString(36)}-${gone.path.replace(/\//g, '-')}`)).catch(() => {});
      await change(cardId, (one) => { one.recordings.splice(index, 1); one.transcript = []; delete one.engine; delete one.tookMs; if (!one.recordings.length) { one.state = 'idle'; delete one.problem; } });
      if (data.recordings.length) void transcribe(cardId);
    },
    insights: (cardId: string, insights: InterviewInsights) => change(cardId, (data) => { data.insights = insights; }),
    // Where one recording's sound is, for the player, and how big it is.
    async sound(cardId: string, index: number): Promise<{ file: string; size: number } | null> {
      const recording = (await load(cardId)).recordings[index];
      if (!recording) return null;
      const file = join(home, recording.path);
      const size = await stat(file).then((one) => one.size, () => null);
      return size === null ? null : { file, size };
    },
    seconds: async (cardId: string) => totalSeconds((await load(cardId)).recordings),
    close() { stop.abort(); },
  };
}
