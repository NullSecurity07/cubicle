import { SHAPES, type Card } from '../../shared/model.ts';
import { MOODS } from '../media/audio.ts';
import type { MediaJobs } from '../media/jobs.ts';
import { AI_LAYOUTS, FRAMES, LAYOUTS, parseSpec, PURPOSES, type Layout } from '../media/video.ts';
import { DEFAULT_VOICE, isVoice, VOICES } from '../media/voice.ts';
import { LOOKS, PACES } from '../media/templates/index.ts';
import { wired } from '../prompt.ts';
import { text, type Tool, type ToolContext } from './registry.ts';

// Words a founder uses when they mean "put a picture in it". A person that hears them and calls the video tool
// with no picture has not disobeyed — it has not noticed — so the tool notices for it and hands over what the
// wired image studio has. The founder should not have to learn which of two calls carries a picture.
const MEANS_A_PICTURE = /\b(picture|image|photo|photograph|portrait|face|headshot|selfie|the one you (?:just )?(?:made|drew|generated)|that image|this image)\b/i;
export const meansAPicture = (said: string): boolean => MEANS_A_PICTURE.test(said);

// The studio of one kind the founder wired to this person. Nothing else on the stage is theirs to drive.
const studio = (context: ToolContext, kind: Card['kind']) => {
  const cards = (context.stage.cards ?? []).filter((one) => one.kind === kind);
  const [id] = wired(context.stage, context.roomId, cards.map((one) => one.id));
  return cards.find((one) => one.id === id);
};

// The scenes in a storyboard that would go out to somebody else's machine and spend their daily quota. A clip made
// here costs only this computer's time, so it is not one of these; a talking head always is, because there is no
// local way to make one whose licence allows a founder to sell anything with it.
export const spendingScenes = (scenes: unknown, localReady = false): Layout[] =>
  (Array.isArray(scenes) ? scenes : []).map((one) => (one as { layout?: unknown })?.layout)
    .filter((layout): layout is Layout => typeof layout === 'string' && AI_LAYOUTS.has(layout as Layout))
    .filter((layout) => layout === 'presenter' || !localReady);

// Pictures and spoken words, made in the studio cards the founder connected to this person. Free and local to this
// machine's account, so nothing waits for the founder's yes; the per-turn caps are what keep a person from making all day.
// `localClipsReady` says whether the moving pictures would be made here; when they would, nothing goes out and
// nothing is spent, so the founder is not asked.
export function mediaTools(media: MediaJobs, localClipsReady: () => boolean = () => false): Tool[] {
  // The last thing the founder said to this person, which is where "use that image" lives.
  const lastAsk = async (context: ToolContext): Promise<string> => {
    const said = await context.store.readChat(context.roomId).catch(() => []);
    return [...said].reverse().find((one) => one.role === 'user')?.text ?? '';
  };
  return [{
    name: 'generate_image',
    perTurn: 4,
    description: 'Make a picture from a description, in the image studio connected to your room. Write the prompt as a whole scene: subject, setting, style, light. '
      + 'The picture appears on the card and in your reply, and the file stays in the shared files.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The whole scene to draw' },
        shape: { type: 'string', enum: [...SHAPES], description: 'The shape of the picture; square when left out' },
      },
      required: ['prompt'],
    },
    ready: () => media.ready('imagegen'),
    async run(args, context) {
      const card = studio(context, 'imagegen');
      if (!card) throw new Error('no image studio is connected to your room. Ask the founder to add one from the dock and draw a wire to it.');
      const shape = typeof args.shape === 'string' && (SHAPES as readonly string[]).includes(args.shape) ? args.shape : 'square';
      // The card hears the job from the server itself, so the founder and this person see the same picture appear once.
      const made = await media.make(card, { prompt: text(args, 'prompt', 2000), shape }, { signal: context.signal });
      // The path, said plainly, because the next thing somebody asks for is usually a film with this picture in it
      // and a person cannot pass on a link they were only shown.
      return {
        text: `Made the picture. It is saved at ${made.path} — pass that path to generate_video in "images" to put it in a film.`
          + `\n\n![${made.prompt.replace(/[[\]]/g, '')}](/api/files/${made.path})`,
        effect: { kind: 'media-made', id: card.id },
      };
    },
  }, {
    name: 'generate_voice',
    perTurn: 2,
    description: 'Say something out loud in the voice studio connected to your room, and get back a sound file. '
      + 'Write the words exactly as they should be spoken, with the punctuation that gives them their rhythm. '
      + 'The recording appears on the card and in your reply, and the file stays in the shared files.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The words to say, exactly as they should be spoken' },
        voice: { type: 'string', enum: VOICES.map((voice) => voice.id), description: `Which voice says them; ${DEFAULT_VOICE} when left out` },
      },
      required: ['text'],
    },
    ready: () => media.ready('voicegen'),
    async run(args, context) {
      const card = studio(context, 'voicegen');
      if (!card) throw new Error('no voice studio is connected to your room. Ask the founder to add one from the dock and draw a wire to it.');
      const voice = isVoice(args.voice) ? args.voice : DEFAULT_VOICE;
      const made = await media.make(card, { prompt: text(args, 'text', 5000), voice }, { signal: context.signal });
      return { text: `Said it.\n\n[${made.prompt.replace(/[[\]]/g, '').slice(0, 80)}](/api/files/${made.path})`, effect: { kind: 'media-made', id: card.id } };
    },
  }, {
    name: 'generate_video',
    perTurn: 1,
    description: 'Make a short narrated video in the video studio connected to your room. The simplest call is a "brief" alone — say what the film is for, how long, '
      + 'and who it is for, and the studio\'s own director works out the shape, the look, the pace, the music and every scene. '
      + 'Write "scenes" yourself only when you want a particular storyboard; then each scene needs a layout, the words on screen and the line spoken over it. '
      + 'What goes on screen is a headline of a few words, never the sentence being spoken. Everything specific a film says — a feature, a number, a name — has to come out of what is wired to the card and be quoted in "source"; anything else is cut before it renders. '
      + 'Rendering takes a few minutes, so call this once. '
      + 'To put a picture in the film, draw it with generate_image first and pass the path it gives back in "images"; pictures already in the wired image studio are used without being asked for. '
      + 'The card lists what it is drawing on — the founder\'s own footage, screenshots of the product — under names you can put in "asset".',
    parameters: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'What the film is for, in a sentence or two. Enough on its own: the director reads the length, the shape, the look and the pace out of it.' },
        title: { type: 'string', description: "The film's title, a few words" },
        scenes: {
          type: 'array',
          description: 'Optional. The scenes in order, when you want to write the storyboard yourself. Open with a title or a hook and end with an outro, a cta or a logo.',
          items: {
            type: 'object',
            properties: {
              layout: {
                type: 'string', enum: [...LAYOUTS],
                description: 'title, stat and logo need heading; statement, hook, quote, cta and outro need text; bullets, checklist and steps need bullets; '
                  + 'compare needs exactly two bullets; picture needs image_prompt; device and footage need asset; clip needs clip_prompt; presenter needs say and portrait_prompt',
              },
              heading: { type: 'string', description: 'The title, the list heading, the one big figure, the wordmark, where to go, or who said the quote' },
              text: { type: 'string', description: 'The sentence on screen, or the caption over a picture' },
              bullets: { type: 'array', items: { type: 'string' }, description: 'Two to five short lines; for compare, exactly two — the before and the after' },
              labels: { type: 'array', items: { type: 'string' }, description: 'The two words over a compare scene, such as Before and After' },
              image_prompt: { type: 'string', description: 'The whole scene to draw, for a picture scene' },
              bg_prompt: { type: 'string', description: 'A picture to draw full-bleed behind the words of any other scene, so no scene is a flat colour' },
              emphasis: { type: 'string', description: 'The one word in "text" that carries the line; it is set in the accent colour' },
              source: { type: 'string', description: 'A short quotation, word for word, out of the wired material that this scene\'s claim rests on. A feature, number or name that cannot be quoted is cut before the film is rendered.' },
              asset: { type: 'string', description: 'The name of a screenshot or a file already on the card, for a device or footage scene — or the file path of a picture generate_image gave you' },
              frame: { type: 'string', enum: [...FRAMES], description: 'What a device scene shows the screenshot in' },
              clip_prompt: { type: 'string', description: 'Three to five seconds of moving b-roll to make, for a clip scene' },
              portrait_prompt: { type: 'string', description: 'Who is on screen, for a presenter scene' },
              seconds: { type: 'number', description: 'How many seconds of a clip or a piece of footage to use' },
              start: { type: 'number', description: 'How far into a piece of footage the scene starts' },
              mute: { type: 'boolean', description: "Whether a footage scene's own sound is silenced; true when left out" },
              say: { type: 'string', description: 'One or two sentences spoken over this scene' },
            },
            required: ['layout'],
          },
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Pictures the film must use, as the file paths generate_image gave you, or the word "latest" for the newest picture in the wired image studio. '
            + 'Draw the picture first and pass its path here; the film shows it rather than drawing something like it, and a picture with somebody in it becomes the person on camera.',
        },
        format: { type: 'string', enum: [...SHAPES], description: 'The shape of the film; tall for a phone reel, wide for a screen' },
        look: { type: 'string', enum: [...LOOKS], description: 'creator is bold kinetic captions for a phone reel, editorial is a serif and pictures, neon is tech, clean is typographic, sketch is hand-drawn, brand takes the wired product\'s own colours' },
        purpose: { type: 'string', enum: [...PURPOSES], description: 'What the film is for; the director reads it from the brief when it is left out' },
        length: { type: 'number', description: 'How many seconds the film should run' },
        pace: { type: 'string', enum: [...PACES], description: 'calm holds each scene, punchy cuts fast for a reel' },
        music: { type: 'string', enum: [...MOODS], description: "The mood of the bed under it, or none. It plays only if the founder dropped a music file on the card" },
        captions: { type: 'boolean', description: 'Whether the spoken words are captioned on screen, word by word' },
        narrate: { type: 'boolean', description: 'Whether the spoken lines are recorded; true when left out' },
        sfx: { type: 'boolean', description: 'Whether the cuts and the entrances carry sound; true when left out' },
      },
      required: [],
    },
    ready: () => media.ready('videogen'),
    // Everything else a studio makes is free and local. A clip or a talking head is neither: it spends a small daily
    // quota on somebody else's machine, so the founder says yes to those and to nothing else.
    async approval(args, context) {
      const card = studio(context, 'videogen');
      const spent = spendingScenes(args.scenes, localClipsReady());
      if (!card || !spent.length) return null;
      if (card.kind === 'videogen' && card.ai === 'off') return null;
      return `Make ${spent.length} AI ${spent.length === 1 ? 'scene' : 'scenes'} (${spent.join(', ')}) in the video studio? Those are the only part of a film that is not free.`;
    },
    async run(args, context) {
      const card = studio(context, 'videogen');
      if (!card) throw new Error('no video studio is connected to your room. Ask the founder to add one from the dock and draw a wire to it.');
      // Every picture this film is to use, by path. What was passed, plus — when the founder's own words asked for
      // a picture and nothing was passed — whatever the wired image studio has drawn.
      const drew = studio(context, 'imagegen');
      const newest = async () => (drew ? (await media.read(drew.id).catch(() => null))?.results?.[0]?.path : undefined);
      const named = (Array.isArray(args.images) ? args.images : []).map((one) => String(one ?? '').trim()).filter(Boolean);
      const heard = named.length ? [] : meansAPicture(await lastAsk(context)) ? ['latest'] : [];
      const images: string[] = [];
      for (const one of [...named, ...heard]) {
        if (one.toLowerCase() !== 'latest') { images.push(one); continue; }
        const path = await newest();
        if (path) images.push(path);
      }
      // A storyboard somebody wrote is kept; a brief alone goes to the studio's own director, which is the better of
      // the two roads and the one a person should usually take.
      const written = Array.isArray(args.scenes) && args.scenes.length;
      const brief = typeof args.brief === 'string' && args.brief.trim() ? args.brief.trim()
        : typeof args.title === 'string' && args.title.trim() ? args.title.trim() : '';
      if (!written && !brief) throw new Error('say what the film is about in "brief", or write the "scenes" yourself.');
      const spec = written ? parseSpec({ title: args.title || brief.slice(0, 60), scenes: args.scenes, music: args.music, captions: args.captions, sfx: args.sfx, pace: args.pace }) : undefined;
      const settings = card.kind === 'videogen' ? card : undefined;
      const made = await media.make(card, {
        prompt: written ? (brief || spec!.title) : brief,
        ...(spec ? { spec } : {}),
        format: args.format ?? settings?.format, look: args.look ?? settings?.look,
        purpose: args.purpose ?? settings?.purpose, length: typeof args.length === 'number' ? args.length : settings?.length,
        pace: spec?.pace ?? args.pace ?? settings?.pace, music: spec?.music ?? args.music ?? settings?.music,
        captions: spec?.captions ?? (typeof args.captions === 'boolean' ? args.captions : undefined),
        sfx: spec?.sfx ?? (typeof args.sfx === 'boolean' ? args.sfx : undefined), narrate: args.narrate !== false,
        // The switch on the card is the founder's, not the person's: a film only spends the quota when it is on.
        ai: settings?.ai ?? 'auto', address: settings?.address, voice: settings?.voice,
        // Who asked, so the film can reach the things wired to them, and whatever pictures they are holding.
        roomId: context.roomId, ...(images.length ? { images: [...new Set(images)] } : {}),
      }, { signal: context.signal });
      return { text: `Made the film.\n\n[${made.prompt.replace(/[[\]]/g, '')}](/api/files/${made.path})`, effect: { kind: 'media-made', id: card.id } };
    },
  }];
}
