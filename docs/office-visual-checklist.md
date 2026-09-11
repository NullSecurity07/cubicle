# Office visual checklist

Walk this list against the screenshots that `pnpm office:shot <outDir>` writes, before calling a visual change done.
The shot named in parentheses is the one that proves the line; `01`, `10`–`13` come from the overlay plan, `02`–`09`
from the tower visual plan. `office:shot` rebuilds the viewer first — if you looked at a PNG produced any other way,
you were looking at an older build.

- [ ] Text is crisp at zoom 1, 2, 3 and 4: every glyph is uniform pixel blocks, no half-pixel blur (`03-f1`, `08-board`)
- [ ] No text is drawn outside a bezel — screens, signs and bubbles all have a frame around them (`03-f1`, `11-terminal`)
- [ ] The four floors are distinguishable by carpet and skirting tint, by day (`03-f1`, `04-f2`, `05-f3`, `06-f4`)
- [ ] …and at night, when the tint reads through the darkness (`09-night`)
- [ ] Every screen has a title (`03-f1`, `10-browser-live`, `11-terminal`)
- [ ] Amber `#e6a93c` appears only on attention items: elevator digits, the LIVE badge, the caret, badge counts (`07-elevator`, `10-browser-live`)
- [ ] Tab reaches every control and each one shows the focus ring (`13-stack`)
- [ ] Both themes meet WCAG contrast on body text and on every control (`12-light-theme`, `13-stack`)
- [ ] The elevator doors are closed while the car is moving (`07-elevator`)
- [ ] No room label overlaps a speech bubble (`08-board`, `04-f2`)
- [ ] No white flash when the theme switches — the page is painted in the new theme before the first frame (`12-light-theme`)
- [ ] Reduced motion still shows walking and the elevator; only the easing disappears (`04-f2`, `07-elevator`)
- [ ] Lamps are lit only in rooms with a working or talking agent; windows show the night tile; the sky is dark (`09-night`)
- [ ] The owner sits in the board chair with the "You" label, and the advisors wear glasses (`08-board`)
- [ ] The tray and the browser render identically at the same size (`02-lobby`, compared against the tray window)
