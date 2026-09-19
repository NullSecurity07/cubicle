import { SHAPES, type Card } from '../../shared/model.ts';
import type { MediaJobs } from '../media/jobs.ts';
import { wired } from '../prompt.ts';
import { text, type Tool, type ToolContext } from './registry.ts';

// The studio of one kind the founder wired to this person. Nothing else on the stage is theirs to drive.
const studio = (context: ToolContext, kind: Card['kind']) => {
  const cards = (context.stage.cards ?? []).filter((one) => one.kind === kind);
  const [id] = wired(context.stage, context.roomId, cards.map((one) => one.id));
  return cards.find((one) => one.id === id);
};

// Pictures, made in the studio card the founder connected to this person. Free and local to this machine's account,
// so nothing waits for the founder's yes; the per-turn cap is what keeps a person from drawing all day.
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
  }];
}
