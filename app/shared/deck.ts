// A deck: a short run of slides made from a brief and whatever the founder wired to the card, printed to PDF on this
// machine. The card only says what was asked for; what came out lives in a sidecar the server owns,
// `workspace/decks/<cardId>.json`, one version per make or per set of notes, each with its own slides.

export const DECK_PURPOSES = ['pitch', 'update', 'sales', 'demo-day'] as const;
export type DeckPurpose = (typeof DECK_PURPOSES)[number];
export const DECK_LOOKS = ['clean', 'editorial', 'brand'] as const;
export type DeckLook = (typeof DECK_LOOKS)[number];
export const PURPOSE_NAMES: Record<DeckPurpose, string> = { pitch: 'Pitch', update: 'Investor update', sales: 'Sales', 'demo-day': 'Demo day' };
export const LOOK_NAMES: Record<DeckLook, string> = { clean: 'Clean', editorial: 'Editorial', brand: 'Brand' };

export const SLIDE_SHAPES = ['title', 'problem', 'solution', 'market', 'traction', 'team', 'ask', 'chart', 'quote', 'list'] as const;
export type SlideShape = (typeof SLIDE_SHAPES)[number];

// One slide. `figure` is the one number a slide may carry, set large; `source` says where every number on the slide
// came from, and a slide with a number and no source is not made. `notes` are the speaker's, never on the slide.
export type Slide = {
  id: string; shape: SlideShape; headline: string; lines: string[];
  figure?: { value: string; label: string }; picture?: string; notes?: string; source?: string;
};

// One make of the deck. The first comes from the brief; each later one from notes on the one before it (`from`).
// `said` is what the studio did, in the founder's words ("merged 2 and 3; kept 6 of 7 slides").
export type DeckVersion = {
  version: number; at: number; title: string; slides: Slide[]; pdf: string; html: string; pptx?: string;
  brief?: string; notes?: string; from?: number; said?: string[]; look: DeckLook; purpose: DeckPurpose;
};
export type Deck = {
  state: 'idle' | 'making' | 'failed'; log: string[]; problem?: string;
  // The newest version's slides, kept at the top for anybody who only wants the current deck.
  slides: Slide[]; versions: DeckVersion[];
};
// What the card hears on the one live feed: the whole sidecar after every change, and `rev` only ever grows.
export type DeckEvent = { deck: Deck; rev: number; hint?: string | null };
export const deckChannel = (cardId: string) => `deck:${cardId}`;
export const EMPTY_DECK: Deck = { state: 'idle', log: [], slides: [], versions: [] };

export const isPurpose = (value: unknown): value is DeckPurpose => (DECK_PURPOSES as readonly unknown[]).includes(value);
export const isLook = (value: unknown): value is DeckLook => (DECK_LOOKS as readonly unknown[]).includes(value);
export const isShape = (value: unknown): value is SlideShape => (SLIDE_SHAPES as readonly unknown[]).includes(value);

// The one line a slide is called by, on a thumbnail and in a person's outline.
export const SHAPE_NAMES: Record<SlideShape, string> = {
  title: 'Title', problem: 'Problem', solution: 'Solution', market: 'Market', traction: 'Traction', team: 'Team', ask: 'The ask', chart: 'Chart', quote: 'Quote', list: 'List',
};
