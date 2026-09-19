import { SHAPES, type Card } from '../../shared/model.ts';
import { MOODS } from '../media/audio.ts';
import type { MediaJobs } from '../media/jobs.ts';
import { AI_LAYOUTS, FRAMES, LAYOUTS, parseSpec, type Layout } from '../media/video.ts';
import { DEFAULT_VOICE, isVoice, VOICES } from '../media/voice.ts';
import { LOOKS, PACES } from '../media/templates/index.ts';
import { wired } from '../prompt.ts';
import { text, type Tool, type ToolContext } from './registry.ts';

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
      return { text: `Made the picture.\n\n![${made.prompt.replace(/[[\]]/g, '')}](/api/files/${made.path})`, effect: { kind: 'media-made', id: card.id } };
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
    description: 'Make a short narrated video in the video studio connected to your room. You write the whole storyboard: a title and the scenes in order, '
      + 'each with a layout, the words on screen and the line spoken over it. Rendering takes a few minutes, so plan the whole film before you call this once. '
      + 'The card lists what it is drawing on — the founder\'s own footage, screenshots of the product — under names you can put in "asset".',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: "The film's title, a few words" },
        scenes: {
          type: 'array',
          description: 'The scenes in order. Open with a title or a hook and end with an outro, a cta or a logo.',
          items: {
            type: 'object',
            properties: {
              layout: {
                type: 'string', enum: [...LAYOUTS],
                description: 'title, stat and logo need heading; statement, hook, quote, cta and outro need text; bullets, checklist and steps need bullets; '
                  + 'compare needs exactly two bullets; picture needs image_prompt and text; device and footage need asset; clip needs clip_prompt; presenter needs say and portrait_prompt',
              },
              heading: { type: 'string', description: 'The title, the list heading, the one big figure, the wordmark, where to go, or who said the quote' },
              text: { type: 'string', description: 'The sentence on screen, or the caption over a picture' },
              bullets: { type: 'array', items: { type: 'string' }, description: 'Two to five short lines; for compare, exactly two — the before and the after' },
              labels: { type: 'array', items: { type: 'string' }, description: 'The two words over a compare scene, such as Before and After' },
              image_prompt: { type: 'string', description: 'The whole scene to draw, for a picture scene' },
              asset: { type: 'string', description: 'The name of a screenshot or a file already on the card, for a device or footage scene' },
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
        format: { type: 'string', enum: [...SHAPES], description: 'The shape of the film; tall for a phone reel, wide for a screen' },
        look: { type: 'string', enum: [...LOOKS], description: 'clean is typographic, sketch is hand-drawn, brand takes the wired product\'s own colours' },
        pace: { type: 'string', enum: [...PACES], description: 'calm holds each scene, punchy cuts fast for a reel' },
        music: { type: 'string', enum: [...MOODS], description: "The mood of the bed under it, or none. It plays only if the founder dropped a music file on the card" },
        captions: { type: 'boolean', description: 'Whether the spoken words are captioned on screen, word by word' },
        narrate: { type: 'boolean', description: 'Whether the spoken lines are recorded; true when left out' },
        sfx: { type: 'boolean', description: 'Whether the cuts and the entrances carry sound; true when left out' },
      },
      required: ['title', 'scenes'],
    },
    ready: () => media.ready('videogen'),
    // Everything else a studio makes is free and local. A clip or a talking head is neither: it spends a small daily
    // quota on somebody else's machine, so the founder says yes to those and to nothing else.
    async approval(args, context) {
      const card = studio(context, 'videogen');
      const spent = spendingScenes(args.scenes, localClipsReady());
      if (!card || !spent.length) return null;
      if (card.kind === 'videogen' && !card.ai) return null;
      return `Make ${spent.length} AI ${spent.length === 1 ? 'scene' : 'scenes'} (${spent.join(', ')}) in the video studio? Those are the only part of a film that is not free.`;
    },
    async run(args, context) {
      const card = studio(context, 'videogen');
      if (!card) throw new Error('no video studio is connected to your room. Ask the founder to add one from the dock and draw a wire to it.');
      // What a person wrote is the storyboard itself, so no model is asked to write one again.
      const spec = parseSpec({ title: args.title, scenes: args.scenes, music: args.music, captions: args.captions, sfx: args.sfx, pace: args.pace });
      const settings = card.kind === 'videogen' ? card : undefined;
      const made = await media.make(card, {
        prompt: spec.title, spec, format: args.format ?? settings?.format, look: args.look ?? settings?.look,
        pace: spec.pace ?? settings?.pace, music: spec.music ?? settings?.music,
        captions: spec.captions, sfx: spec.sfx, narrate: args.narrate !== false,
        // The switch on the card is the founder's, not the person's: a film only spends the quota when it is on.
        ai: settings?.ai === true, address: settings?.address, voice: settings?.voice,
      }, { signal: context.signal });
      return { text: `Made the film.\n\n[${made.prompt.replace(/[[\]]/g, '')}](/api/files/${made.path})`, effect: { kind: 'media-made', id: card.id } };
    },
  }];
}
