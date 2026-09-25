import type { Understanding } from './director.ts';
import { bibleFor } from './director.ts';
import { pictureHash, type FilmRecord } from './edits.ts';
import { recordOf } from './film-record.ts';
import type { VideoAsk } from './gather.ts';
import type { Maker } from './jobs.ts';
import { FPS, type EditPlan } from './mlt.ts';
import type { Spec } from './spec.ts';
import { PACK } from './templates/index.ts';
import type { Word } from './timings.ts';
import { isDraft } from '../../shared/film-time.ts';

// The video studio in the fake-model mode and the checks: no Chrome, no models, a second of colour for the film —
// and a record, so notes on it are read and applied exactly as the real studio would.

// A second of one flat colour, so the checks and the fake-model mode never need Chrome.
const CLIP = 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAOwbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAtt0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAIAAABAAAAAAJTbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAKABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAAB/m1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAb5zdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAFA8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABoYAAAAAAAAABhzdHRzAAAAAAAAAAEAAAAKAAAEAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAYGN0dHMAAAAAAAAACgAAAAEAAAgAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAAAgAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAKAAAAAQAAADxzdHN6AAAAAAAAAAAAAAAKAAACyQAAAAwAAAAMAAAADAAAAAwAAAASAAAADgAAAAwAAAAMAAAAEgAAABRzdGNvAAAAAAAAAAEAAAPgAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMQAAAAhmcmVlAAADS21kYXQAAAKuBgX//6rcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MTAgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAATZYiEABH//ufj/AptY+nCoYzc8QAAAAhBmiRsQQ/+4AAAAAhBnkJ4h3+3gQAAAAgBnmF0Q3+6gAAAAAgBnmNqQ3+6gQAAAA5BmmhJqEFomUwId//+4QAAAApBnoZFESw7/7eBAAAACAGepXRDf7qBAAAACAGep2pDf7qAAAAADkGaqUmoQWyZTAhv//7g';
const POSTER = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export const fakeVideos: Maker = {
  name: 'fake',
  ready: () => null,
  async make(ask, { report }) {
    const asked = ask as VideoAsk;
    // Notes on a fake film are read and applied for real; only the second of colour stands in for the render.
    if (typeof asked.edit === 'string' && asked.record) {
      const { fakeRemake } = await import('./remake.ts');
      const remade = await fakeRemake({ film: asked.edit, notes: asked.prompt, record: asked.record }, report);
      const title = remade.record?.title ?? 'A film';
      return {
        ext: 'mp4', bytes: Buffer.from(CLIP, 'base64'), poster: { ext: 'png', bytes: Buffer.from(POSTER, 'base64') }, ...remade,
        edit: { film: { title, width: 1280, height: 720, fps: FPS, shots: [{ seconds: 1, ground: PACK.clean.paint.ground, words: title }] }, files: [] },
      };
    }
    const title = asked.prompt.slice(0, 60);
    // Three scenes, so a note can drop one and leave a film.
    const spec = asked.spec ?? { title, scenes: [
      { layout: 'title' as const, heading: title, say: `This is ${title}.` },
      { layout: 'statement' as const, text: 'What it does', say: 'Here is what it does for you.' },
      { layout: 'outro' as const, text: 'Thanks for watching', say: 'Thanks for watching.' },
    ] };
    report(`reading the brief: ${asked.prompt.slice(0, 60)}`);
    // What it was handed, said the way the real one says it, so a run without models still shows the founder that
    // the picture they drew reached the film.
    if (asked.images?.length) report(`using: ${asked.images.length} picture${asked.images.length === 1 ? '' : 's'} you were handed — ${asked.images.join(', ')}`);
    report(`${spec.scenes.length} scenes: ${spec.title}`);
    report('rendering 6 seconds…');
    // The second of colour laid out the way a real film is, so the card and the tool show the project in fake mode too.
    const edit: EditPlan | undefined = isDraft(asked.speed) ? undefined : {
      film: { title: spec.title, width: 1280, height: 720, fps: FPS, shots: [{ seconds: 1, ground: PACK.clean.paint.ground, words: spec.title }] },
      files: [],
    };
    return { ext: 'mp4', bytes: Buffer.from(CLIP, 'base64'), poster: { ext: 'png', bytes: Buffer.from(POSTER, 'base64') }, ...(edit ? { edit, record: fakeRecord(spec, asked.narrate !== false) } : {}) };
  },
};

// What a fake film remembers: two seconds a scene, a picture a scene, and the lines said one word a third of a
// second, so notes on it are read and counted exactly as the real studio would read and count them.
function fakeRecord(spec: Spec, narrate: boolean): FilmRecord {
  const words: Word[] = [];
  let clock = 0;
  const shots = spec.scenes.map((scene, index) => {
    const said = (scene.say ?? '').split(/\s+/).filter(Boolean);
    const seconds = Math.max(2, said.length * 0.34 + 0.6);
    if (narrate) said.forEach((word, at) => words.push({ word, at: Math.round((clock + 0.3 + at * 0.34) * 1000) / 1000, seconds: 0.3 }));
    clock += seconds;
    return { scene: index, take: 0, seconds, bg: `frame-${index}-0.png` };
  });
  const bible = bibleFor({ pack: 'clean' } as Understanding);
  return recordOf({
    title: spec.title, spec, shape: 'wide', look: 'clean', pace: 'calm', captions: false, sfx: true, music: 'none', bible, shots,
    narrator: narrate && words.length ? { voice: 'af_heart', file: 'say.wav', seconds: clock } : undefined, words,
    pictures: Object.fromEntries(shots.map((one) => [one.bg, { kind: 'drawn' as const, hash: pictureHash(spec.scenes[one.scene].say ?? '', bible, 'wide'), subject: spec.scenes[one.scene].say ?? '' }])),
  });
}
