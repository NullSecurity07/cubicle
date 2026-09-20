import { describe, expect, it } from 'vitest';
import type { Shape } from '../../../shared/model.ts';
import { FORMATS, PACKS, styleSheet, TYPE_FLOOR, typeScale } from './looks.ts';

const SHAPES: Shape[] = ['wide', 'tall', 'square'];

// Which floor each size in the scale answers to. A headline is the one line a scene is about; a support line is
// anything a viewer has to read beside it; everything else still has a floor, because writing set below two and a
// half per cent of a frame is decoration rather than writing.
const HEADLINE = ['hook', 'display', 'heading', 'quote', 'stat', 'titleCard', 'hookCaps', 'displayCaps', 'headingCaps', 'statCaps'] as const;
const SUPPORT = ['lead', 'body', 'step', 'cta', 'icon', 'sideBody', 'mark'] as const;
const LEAST = ['label', 'chip', 'sideLabel'] as const;

describe('the type scale has floors under it', () => {
  it('sets every headline at eight per cent of a wide frame and six of a tall one', () => {
    for (const shape of SHAPES) {
      const { height } = FORMATS[shape];
      for (const pack of PACKS) {
        const type = typeScale(shape, pack);
        for (const which of HEADLINE) {
          expect(type[which] / height, `${shape}/${pack}/${which}`).toBeGreaterThanOrEqual(TYPE_FLOOR.headline[shape] - 0.0005);
        }
      }
    }
  });

  it('sets every support line at three point two per cent, captions or no captions', () => {
    for (const shape of SHAPES) {
      const { height } = FORMATS[shape];
      for (const pack of PACKS) {
        const type = typeScale(shape, pack);
        for (const which of SUPPORT) {
          expect(type[which] / height, `${shape}/${pack}/${which}`).toBeGreaterThanOrEqual(TYPE_FLOOR.support - 0.0005);
        }
      }
    }
  });

  it('sets nothing at all under two point six per cent', () => {
    for (const shape of SHAPES) {
      const { height } = FORMATS[shape];
      for (const pack of PACKS) {
        const type = typeScale(shape, pack);
        for (const which of [...HEADLINE, ...SUPPORT, ...LEAST]) {
          expect(type[which] / height, `${shape}/${pack}/${which}`).toBeGreaterThanOrEqual(TYPE_FLOOR.least - 0.0005);
        }
      }
    }
  });

  it('sets a title card larger than a headline, because it is the film announcing itself', () => {
    for (const shape of SHAPES) {
      const { height } = FORMATS[shape];
      for (const pack of PACKS) {
        const type = typeScale(shape, pack);
        expect(type.titleCard / height, `${shape}/${pack}`).toBeGreaterThanOrEqual(TYPE_FLOOR.title - 0.0005);
        expect(type.titleCard).toBeGreaterThanOrEqual(type.heading);
      }
    }
    expect(styleSheet('tall', 'documentary')).toContain(`.frame--title .display, #root.has-captions .frame--title .display { font-size: ${typeScale('tall', 'documentary').titleCard}px; }`);
  });

  it('is the reason a tall frame no longer sets its labels at two per cent', () => {
    // The proof films failed here: "bullet text is tiny", "a tiny CTA pill", "type small and lost in the frame".
    // On a 1280-high frame those were a 22px eyebrow and a 34px button — 1.7 and 2.6 per cent.
    const tall = typeScale('tall', 'documentary');
    expect(tall.label).toBeGreaterThanOrEqual(Math.round(1280 * 0.026));
    expect(tall.cta).toBeGreaterThanOrEqual(Math.round(1280 * 0.032));
    expect(tall.heading).toBeGreaterThanOrEqual(Math.round(1280 * 0.06));
  });
});

describe('the stylesheet writes the scale out rather than leaving it to a multiplier', () => {
  it('carries the same numbers the scale says, so the floors can be read off the page', () => {
    for (const shape of SHAPES) {
      for (const pack of PACKS) {
        const sheet = styleSheet(shape, pack);
        const type = typeScale(shape, pack);
        expect(sheet, `${shape}/${pack}`).toContain(`.heading { font-family:`);
        expect(sheet, `${shape}/${pack}`).toContain(`font-size: ${type.heading}px;`);
        expect(sheet, `${shape}/${pack}`).toContain(`font-size: ${type.body}px;`);
        expect(sheet, `${shape}/${pack}`).toContain(`font-size: ${type.label}px;`);
      }
    }
  });

  it('leaves nothing a viewer reads on the small-text multiplier that made it small', () => {
    // Everything that used to be `calc(22px * var(--t))` is now a whole number with a floor under it. What is
    // left on a multiplier is the mock address bar drawn inside a browser frame, which is furniture, and the
    // caption line, which is already a tenth of the frame's height by its own rule.
    for (const shape of SHAPES) {
      for (const pack of PACKS) {
        expect(styleSheet(shape, pack), `${shape}/${pack}`).not.toMatch(/font-size: calc\(\d+px \* var\(--t\)\)/);
      }
    }
    const { height } = FORMATS.tall;
    expect(styleSheet('tall', 'creator')).toContain(`.capline { font-size: calc(${Math.round(height * 0.108)}px * var(--s)); }`);
  });
});

describe('the scrim is a variable the shot fills in', () => {
  it('falls back to the pack\'s own number when nothing could look at the picture', () => {
    for (const pack of PACKS) {
      const sheet = styleSheet('tall', pack);
      expect(sheet, pack).toMatch(/\.bg \{ --hold: 0\.\d\d; \}/);
      expect(sheet, pack).toContain('var(--hold)');
    }
  });

  it('lifts a picture in front of a pack\'s grade rather than instead of it', () => {
    expect(styleSheet('wide', 'documentary')).toContain('filter: brightness(var(--raise, 1)) saturate(0.92)');
    expect(styleSheet('wide', 'clean')).toContain('filter: brightness(var(--raise, 1));');
  });
});
