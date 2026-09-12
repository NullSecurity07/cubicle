# Office visual checklist

Walk this list against the screenshots that `pnpm office:shot <outDir>` writes, before calling a visual change done.
The shot named in parentheses is the one that proves the line; `01`, `10`–`13` come from the overlay plan, `02`–`09`
from the tower visual plan. `office:shot` rebuilds the viewer first — if you looked at a PNG produced any other way,
you were looking at an older build.

- [ ] An empty company asks its one question on a centred card, over the office, with the input already focused (`01-first-run`)
- [ ] Text is crisp at zoom 1, 2, 3 and 4: every glyph is uniform pixel blocks, no half-pixel blur (`03-f1`, `08-board`)
- [ ] No text is drawn outside a bezel — screens, signs and bubbles all have a frame around them (`03-f1`, `11-terminal`)
- [ ] A floor view is about that floor: the whole floor from end to end, no room cut at either edge, and the rest of the tower dimmed behind it (`03-f1`, `06-f4`)
- [ ] The four floors are distinguishable by carpet and skirting tint, by day (`03-f1`, `04-f2`, `05-f3`, `06-f4`)
- [ ] …and at night, when the tint reads through the darkness (`09-night`)
- [ ] `0` fits the whole tower: four floors, the lobby and the street in one frame, the sky outside the building reading as sky and not as another floor, and no desk-name ribbon at that zoom (`09a-tower-day`)
- [ ] …and that same fit at night is tinted as one picture — building, sky and minimap together, with no daylight square left in a corner (`09b-tower-night`)
- [ ] Every screen has a title, on a plate of its own rather than floating on the wall (`03-f1`, `11-terminal`)
- [ ] Every screen says more than its title: a head and the lines under it, in the space the anchor gives it (`03-f1`, `06-f4`)
- [ ] The surround reads as sky at every hour, and never as a slab of red — and it holds a sun or a moon (`09c-tower-dusk`, `09a-tower-day`, `09b-tower-night`)
- [ ] A floor view is daylight unless the scene is about night: the carpets, windows and sky are the day palette (`03-f1`, `04-f2`, `05-f3`, `06-f4`)
- [ ] A screen's caption is lit exactly when the screen it names is (`04-f2`, `05-f3`)
- [ ] The tower elevation names its floors, and drops the minimap it would only duplicate (`09a-tower-day`)
- [ ] The elevator car reads as an object riding the shaft, with a landing in the same frame (`07-elevator`)
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

## The overlay against the office (added by the 2026-09-11 fix wave)

Each of these lines exists because a delivered screenshot showed the opposite.

- [ ] The selected segment is filled with the accent and its ink reads on it — on the time bar and inside a sheet, in both themes (`01-first-run`, `12-light-theme`)
- [ ] The first-run card dims the office behind it, and it is the only first-contact message on the screen: no coach mark beside it (`01-first-run`)
- [ ] No panel, sheet, reader or viewer overruns the time bar: Live and Replay are whole and legible under every presentation (`10-browser-live`, `11-terminal`, `12-light-theme`, `13-stack`)
- [ ] No panel covers the minimap or its M toggle at 1280 × 800 — an open sheet stops above them (`12-light-theme`)
- [ ] A live browser stream's counter moves: `seq N` is not 0 after frames have arrived, and the rate reads beside it (`10-browser-live`)
- [ ] The browser viewer's box is the frame's own shape: no band of dead black beside or above the picture (`10-browser-live`)
- [ ] The terminal viewer is as tall as its output, not a fixed box two thirds empty (`11-terminal`)
- [ ] One header row per viewer: the agent, the host, the seq and the rate are printed once (`10-browser-live`)
- [ ] "Talk to the CEO" is the only amber fill in the top bar; the approvals pill is accent text on a surface, and at zero it is absent rather than a grey "0 to approve" (`01-first-run` has none, `10-browser-live` has one)
- [ ] A freshly opened sheet has no focus ring inside it: focus lands on the panel and Tab moves in (`12-light-theme`)
- [ ] The replay transport — date, play/pause, scrub, speed, the Space/arrows hint — is on the screen only in replay mode (`01-first-run` and every floor shot show none)
- [ ] Every wall screen is a mounted object: a bezel, a lit top edge and a shadow seating it on the wall, in both themes (`05-f3`, `12-light-theme`)
- [ ] No room sign is half-eaten by the floor rail: each is whole, or absent while its room is off the screen (`03-f1`, `05-f3`, `13-stack`)
- [ ] Sibling desks are told apart at the zoom labels appear at: the Dev row is not a column of "Product …" (`11-terminal`, `14-sales`)
