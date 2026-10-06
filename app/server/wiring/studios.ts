import { resolve } from 'node:path';
import type { Browser } from '../browser.ts';
import { orderedClips } from '../media/clips.ts';
import { fakeLocalClips, localClips, MINUTES_EACH } from '../media/local-clips.ts';
import { createClips, fakeClips } from '../media/spaces.ts';
import { fakeImages, firstOf, imageMakers, spentFile } from '../media/image.ts';
import { lettered } from '../media/lettering.ts';
import { createMedia } from '../media/jobs.ts';
import { createMusic, fakeMusic } from '../media/music.ts';
import { fakeVideosOf, hyperframesVideos } from '../media/video.ts';
import { createSight, sightDir } from '../media/sight.ts';
import { photoLibrary } from '../media/free-stock.ts';
import { fakeVoices, voiceMakers } from '../media/voice.ts';
import { complete, promptSize, type ModelClient } from '../providers.ts';
import { route } from '../router.ts';
import type { Store } from '../store.ts';
import type { UsageBook } from '../usage.ts';

// Every studio card's makers, and the one job list they share. Built once at start, from the same models, browser and
// store the people use.
export function wireStudios(deps: { root: string; workspace: string; fake: boolean; store: Store; browser: Browser; clients: ModelClient[]; usage: UsageBook }) {
  const { root, workspace, fake, store, browser, clients, usage } = deps;
  // The studio cards: one job per card, the files in the shared files folder, the rest beside the stage.
  // A video is made out of the other two: it draws its stills with the picture makers and records its lines with the voice ones.
  // Every way of drawing, wrapped so that none of them is ever asked for writing: a picture model cannot spell, so the
  // picture comes out wordless and the real words are set over it afterwards in real type. This sits round the makers
  // rather than round any one studio, so the stills a film draws are as free of gibberish lettering as the ones a
  // person draws by hand. The video studio's own cache sits outside this, on the ask as it was written, and what it
  // holds is therefore the wordless picture — so a film rendered twice still costs one picture.
  const pictures = (fake ? [fakeImages] : imageMakers()).map(lettered);
  // The film's own way of drawing: every maker as one, tried in order. It is named because the card asks it one
  // thing before anything is made — whether the next picture is four seconds away or most of a minute.
  const filmPictures = firstOf(pictures, fake ? undefined : spentFile(resolve(root, 'app/.cache/pictures-spent.json')));
  const voices = fake ? [fakeVoices] : voiceMakers(resolve(root, 'app/.cache/voice'));
  // Direction is the one place in the app where the *best* free model matters more than the roomiest: a storyboard is
  // short, and what it needs is judgement. The configured order puts gpt-oss-120b first and the router moves anything
  // out of quota to the back, so this asks the strongest model that can still answer today, then anything that can.
  const storyboard = async (prompt: string) => {
    const messages = [{ role: 'user' as const, content: prompt }];
    const chars = promptSize(messages);
    const { order } = route(clients, usage, { promptChars: chars, tools: false });
    const roomy = [...clients].reverse().filter((client) => !order.includes(client) && client.maxPromptChars >= chars);
    const reply = await complete(messages, { onToken: () => {} }, [...order, ...roomy]);
    usage.record(reply.client.name, reply.usage, reply.quota);
    return reply.text;
  };
  // The bed under a film: a mood and a length in, a finished loop at −23 LUFS out, with its own beats and its own
  // credit. The cache is on a real disk beside the voice model's, never a tmpfs.
  const music = fake ? fakeMusic : createMusic({ cacheDir: resolve(root, 'app/.cache') });
  // Moving pictures, two ways round: made here on this machine, slowly and without limit, or asked of the free Hugging
  // Face Spaces, quickly and out of a daily quota. B-roll tries this machine first; a talking head can only be made
  // out there. Either way a scene that cannot be made falls back in plain words.
  const local = fake ? fakeLocalClips : localClips();
  const online = fake ? fakeClips : createClips();
  // B-roll is made here first, because it is unlimited and nobody is waiting on a particular face. Somebody speaking
  // on camera is asked of the free Spaces and of nothing else: they are the only thing that can move a real mouth to
  // a real recording, and a drawn person whose mouth does not match the words is the one thing this studio will not
  // make. When they have nothing left the film is faceless and says so.
  const clips = orderedClips({ broll: [local, online], presenter: [online] });
  if (!fake) console.log('clips · here:', local.ready() ?? `ready (about ${MINUTES_EACH} minutes each)`, '· online:', online.ready() ?? 'ready');
  const media = createMedia({
    dir: workspace,
    store,
    makers: {
      imagegen: pictures,
      voicegen: voices,
      videogen: fake ? [fakeVideosOf({ stage: () => store.loadStage() })] : [hyperframesVideos({
        dir: workspace, images: filmPictures, voices: voices[0], think: storyboard, clips, local, lipsync: online, music,
        // Real photographs and footage somebody took: Pexels when the founder has put a free key in .env, then
        // Openverse and Wikimedia Commons, which need no key. Anything nobody has photographed is drawn.
        stock: photoLibrary(process.env, fetch, resolve(root, 'app/.cache/stock')),
        cacheDir: resolve(root, 'app/.cache'),
        // The studio's eyes: a drawn picture is looked at before it is used, and the long-form look's stills are cut
        // into planes by depth. Two small models, fetched once, run on the processor; nothing breaks without them.
        sight: createSight(sightDir(resolve(root, 'app/.cache'))),
        forbidden: [workspace, root],
        stage: () => store.loadStage(),
        // `media` is read inside these, never at the moment they are made, so the studio can ask the card that asked it.
        assets: (cardId) => media.assetsOf(cardId),
        // A wired image studio's own pictures, newest first: a wire is the founder saying "use these".
        pictures: async (cardId) => (await media.read(cardId)).results.map((one) => ({ path: one.path, prompt: one.prompt })),
        // A wired voice studio's recordings, newest first, with who read each: its newest can be a line of the film.
        recordings: async (cardId) => (await media.read(cardId)).results.map((one) => ({ path: one.path, prompt: one.prompt, ...(one.speaker ? { speaker: one.speaker } : {}) })),
        fileOf: (path) => store.pathOf(path),
        readDoc: (id) => store.readDoc(id),
        readFile: (path) => store.readFileBytes(path),
        browser: { shots: (raw, want, signal) => browser.shots(raw, want, signal), where: (session) => browser.where(session) },
      })],
    },
  });
  return { media, filmPictures, local };
}
