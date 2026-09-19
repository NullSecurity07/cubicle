import { SHAPES, type Card } from '../../shared/model.ts';
import type { MediaJobs } from '../media/jobs.ts';
import { DEFAULT_VOICE, isVoice, VOICES } from '../media/voice.ts';
import { wired } from '../prompt.ts';
import { text, type Tool, type ToolContext } from './registry.ts';

// The studio of one kind the founder wired to this person. Nothing else on the stage is theirs to drive.
const studio = (context: ToolContext, kind: Card['kind']) => {
  const cards = (context.stage.cards ?? []).filter((one) => one.kind === kind);
  const [id] = wired(context.stage, context.roomId, cards.map((one) => one.id));
  return cards.find((one) => one.id === id);
};

// Pictures and spoken words, made in the studio cards the founder connected to this person. Free and local to this
// machine's account, so nothing waits for the founder's yes; the per-turn caps are what keep a person from making all day.
export function mediaTools(media: MediaJobs): Tool[] {
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
  }];
}
