// A site: one page made from a brief and whatever the founder wired to the card, written as plain HTML and CSS on
// this machine. The card only says what was asked for; what came out lives in a sidecar the server owns,
// `workspace/sites/<cardId>/site.json`, and each version's folder beside it, `workspace/sites/<cardId>/v<n>/`, holds
// the page itself: `index.html`, `style.css` and `media/`. Nothing is hosted; the founder downloads the folder.

export const SITE_LOOKS = ['clean', 'editorial', 'brand'] as const;
export type SiteLook = (typeof SITE_LOOKS)[number];
export const SITE_LOOK_NAMES: Record<SiteLook, string> = { clean: 'Clean', editorial: 'Editorial', brand: 'Brand' };

// The parts a one-page site is made of, in the order a visitor meets them.
export const SECTION_KINDS = ['hero', 'problem', 'how', 'proof', 'pricing', 'faq', 'cta'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];
export const SECTION_NAMES: Record<SectionKind, string> = {
  hero: 'Hero', problem: 'Problem', how: 'How it works', proof: 'Proof', pricing: 'Pricing', faq: 'Questions', cta: 'Call to action',
};

// One section. `figure` is the one number a section may set large, and `source` says where every number in the
// section came from, worked out rather than taken on the model's word. `picture` is what a picture for it would
// show, in words; `image` is the file that picture became, under the version's `media/`. `button` is the words on
// the call to action, on the hero and the last section. A faq line is "Question? Answer".
export type Section = {
  id: string; kind: SectionKind; headline: string; lines: string[];
  figure?: { value: string; label: string }; source?: string; picture?: string; image?: string; button?: string;
};

// One rule the critic holds a page to, and how this page did on it, in words.
export type SiteCheck = { rule: 'one-h1' | 'cta-fold' | 'contrast' | 'weight' | 'claims'; ok: boolean; said: string };
export const CHECK_NAMES: Record<SiteCheck['rule'], string> = {
  'one-h1': 'One headline', 'cta-fold': 'Button above the fold on a phone', contrast: 'Text contrast 4.5:1', weight: 'Page under 500 KB', claims: 'Every claim has a source',
};

// One make of the page. The first comes from the brief; each later one from notes on the one before it (`from`).
// `said` is what the studio did, in the founder's words. `bytes` is the whole folder's weight.
export type SiteVersion = {
  version: number; at: number; title: string; sections: Section[]; look: SiteLook;
  brief?: string; notes?: string; from?: number; said?: string[]; checks: SiteCheck[]; bytes: number; files: string[];
};
export type Site = { state: 'idle' | 'making' | 'failed'; log: string[]; problem?: string; versions: SiteVersion[] };
// What the card hears on the one live feed: the whole sidecar after every change, and `rev` only ever grows.
export type SiteEvent = { site: Site; rev: number };
export const siteChannel = (cardId: string) => `site:${cardId}`;
export const EMPTY_SITE: Site = { state: 'idle', log: [], versions: [] };

export const isSiteLook = (value: unknown): value is SiteLook => (SITE_LOOKS as readonly unknown[]).includes(value);
export const isSectionKind = (value: unknown): value is SectionKind => (SECTION_KINDS as readonly unknown[]).includes(value);

// The two widths a page is looked at: a laptop and a phone, both in CSS pixels, and the height each shows at once.
export const DESKTOP = { width: 1200, height: 780 };
export const PHONE = { width: 390, height: 844 };
