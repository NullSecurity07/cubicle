import type { Attention } from './model.ts';

// What is left of an approval whose turn died with the app: the tool it was for, so the app can tell when the same
// thing has since been done, and a few plain words about the call for the founder to read. The `event` itself is let
// go — an email's whole body and every argument have no business outliving the turn they belonged to.
export type Lapsed = Attention & { tool?: string; about?: string };
