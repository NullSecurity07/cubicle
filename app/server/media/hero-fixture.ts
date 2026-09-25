// The site's hero film as the studio last directed it (2026-09-25, draft then full), kept so the rules that were
// written against it can be tested against it. Every fault in `build-feat-hero-3` is visible in here: the hook is
// its own spoken line set large with captions under it, the promise asks for a lock over a data diagram, and the
// close is the critic's old fallback, "Try it this week".
import type { Material } from './director.ts';
import type { Scene, Spec } from './spec.ts';

export const HERO_BRIEF = 'A 20 second marketing film for the top of the product website, made to be understood with the sound off: '
  + 'a canvas where a small team of AI people works beside a founder; wires are access, so each person reads only what '
  + 'is wired to them; nothing leaves the machine. Calm and confident, show the product itself, end on the promise, '
  + 'then close with the call to action "Get it, free, on your own machine."';

export const HERO_MATERIAL: Material = {
  pitch: 'A company of your own, on your own machine. A canvas where a small team of AI people works beside you.',
  lines: [
    'README of cubicle:\nRooms hold people. Wires carry context. A board holds the work and the founder runs it.\nWire them to what they may read, and they draft, research, film and follow up.\nYou decide, and nothing leaves your computer that you did not wire.',
  ],
  assets: [{ name: 'screen-repo-1', kind: 'screen', what: 'the stage' }], using: ['cubicle project'], brand: { colours: ['#4e8cff'], name: 'cubicle' },
};

export const HERO_SCENES: Scene[] = [
  { layout: 'hook', text: 'Wire them to what they may read', say: 'Wire them to what they may read, and they draft, research.', emphasis: 'launching', source: 'Wire them to what they may read, and they draft, research, film and follow up.' },
  { layout: 'picture', text: 'AI team beside founder', say: 'A small AI team works beside me, drafting.', image_prompt: 'A sleek digital canvas on a laptop screen shows tiny glowing AI figures gathered around a founder avatar, collaborative atmosphere.' },
  { layout: 'device', heading: 'Your AI Dashboard', say: 'They film, edit, and follow up automatically.', asset: 'screen-repo-1', frame: 'laptop' },
  { layout: 'picture', say: 'You decide, and nothing leaves your computer that you did not wire.', image_prompt: 'A lock icon floats over a stylized data flow diagram on a screen, symbolizing privacy and control.', source: 'You decide, and nothing leaves your computer that you did not wire.' },
  { layout: 'cta', text: 'Try it this week', say: 'Try it this week.' },
];
export const heroSpec = (scenes: Scene[] = HERO_SCENES): Spec => ({ title: 'Private AI Team on Your Machine', scenes: scenes.map((one) => ({ ...one })) });
