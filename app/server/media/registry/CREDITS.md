# Registry graphics — where they came from, and under what terms

The files in `items/` are blocks and components from the **HyperFrames registry**
(<https://github.com/heygen-com/hyperframes>, directory `registry/`), copyright HeyGen and the HyperFrames
contributors, published under the **Apache License 2.0** (<https://www.apache.org/licenses/LICENSE-2.0>).

They were installed with `hyperframes add <name>` (CLI 0.8.55) on 2026-09-20 by
`scripts/vendor-hyperframes.ts` and are kept here **exactly as the CLI wrote them**: `manifest.json` holds the
SHA-256 of every file and a test fails if one is edited by hand. That is deliberate. Apache-2.0 asks that a changed
file says it was changed, so the files are not changed: what a film needs different — its own words, its own frame
size, no CDN links — is substituted by the adapters in `index.ts` each time a film is put together, in the copy
that goes into the film and nowhere else.

| item | kind | used for |
| --- | --- | --- |
| `caption-pill-karaoke` | component | captions of the clean and brand packs |
| `caption-highlight` | component | captions of the creator pack |
| `caption-kinetic-slam` | component | captions of the neon pack |
| `whip-pan` | block | the act-break transition of the creator pack |
| `zoom-through-transition` | component | the act-break transition of the neon pack |
| `flash-through-white` | block | the act-break transition of the clean and brand packs |
| `count-up` | component | the figure on a stat scene |
| `animated-bar-chart` | component | the columns of a chart scene whose labels are short |

What the adapters leave out of a film, because it would send a render to the network: the Google Fonts links
(Poppins, Anton, Montserrat, Space Mono, Bebas Neue, JetBrains Mono, Lato) and the jsDelivr copy of GSAP. The films
set their captions in the typefaces already bundled in `templates/vendor/` (see `templates/assets/CREDITS.md`)
and load the GSAP that is bundled beside them.

To refresh: `pnpm vendor:hyperframes`, then `npx vitest run server/media/registry`.
