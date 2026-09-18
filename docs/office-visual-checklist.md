# Office visual checklist

Walk this list against the screenshots that `pnpm office:shot <outDir>` writes, before calling a visual change done.
The shot named in parentheses is the one that proves the line. `office:shot` rebuilds the viewer first — if you
looked at a PNG produced any other way, you were looking at an older build.

SP9 rewrote this list. The office is one open-plan campus on a single isometric plane, drawn as soft flat-shaded
vector art; there are no floors, no elevator and no pixel tiles, so every line that was about those is gone rather
than reworded. What replaced them are the lines the campus can get wrong: a zone's accent, the hour's light falling
on the plane and not only on the glass, a body walking through a partition, and type that has to stay crisp while
everything under it is drawn at a fraction of a pixel.

## The campus

- [ ] An empty company asks its one question on a centred card, over the office, with the input already focused (`01-first-run`)
- [ ] `0` fits the whole campus: every zone in one frame, the plane reading as one floor rather than as tiles, and no desk-name ribbon at that zoom (`09a-campus-day`)
- [ ] A zone view is about that zone: the whole zone from end to end, no desk cut at either edge, and the campus around it still legible (`04-dev`, `07-ops`)
- [ ] The four division accents are told apart at a glance, and the shared rooms wear the neutral rather than borrowing one (`09a-campus-day`, `03-exec`, `14-sales`)
- [ ] Partitions read as glass and rail, not as walls: a zone is bounded without being boxed in (`04-dev`, `06-research`)
- [ ] Every screen has a title on a plate of its own rather than floating on a partition (`04-dev`, `11-terminal`)
- [ ] Every screen says more than its title: a head and the lines under it, in the space the anchor gives it (`04-dev`, `07-ops`)
- [ ] Text is crisp at every zoom the scenes use: labels are UI type on soft plates, never drawn into the world's own scale (`03-exec`, `08-board`)
- [ ] No text is drawn outside a plate or a bezel — screens, signs and bubbles all have a frame around them (`04-dev`, `11-terminal`)
- [ ] Sibling desks are told apart at the zoom names appear at: the Revenue row is not a column of "Sales …" (`14-sales`, `11-terminal`)
- [ ] No zone plate overlaps a speech bubble (`08-board`, `17-pantry`)

## The light

- [ ] A zone view is daylight unless the scene is about night (`03-exec`, `04-dev`, `05-qa`, `06-research`, `07-ops`)
- [ ] Dusk paints the campus and not only the sky: the floor, the walnut and the faces all warm with the hour (`09c-campus-dusk`)
- [ ] Night is one picture — plane, glass and minimap together, with no daylight square left in a corner (`09b-campus-night`)
- [ ] Lamps are lit only where someone is working or talking; the rest of the plane stays dark (`09-night`)
- [ ] A screen's caption is lit exactly when the screen it names is (`04-dev`, `09-night`)
- [ ] Shadows all fall the same way, from the one warm light at the top-left (`09a-campus-day`, `07-ops`)
- [ ] Amber `#E6A93C` appears only on attention items: the LIVE badge, the caret, badge counts, the minimap viewport (`10-browser-live`, `09a-campus-day`)

## The people

- [ ] A person has a real silhouette: hair, outfit and a face, distinct per role family (`08-board`, `17-pantry`)
- [ ] Nobody walks through a partition or a desk — every route in the run is one the router found (`02-campus` route lines in the log)
- [ ] The walk is eased, not stepped: nothing in the motion snaps to a cell (`04-dev` under reduced motion, which leaves the walk and drops the easing)
- [ ] The owner sits in the board chair with the "You" label, and the advisors wear glasses (`08-board`)
- [ ] Two people at the pantry counter read as a conversation: both bubbles up, neither over a plate (`17-pantry`)
- [ ] A name plate carries its division's chip, and the chip is the colour that division's zone wears (`07-ops`, `14-sales`)

## The chrome

- [ ] The zone rail names every zone it lists, and the current one is marked (`09a-campus-day`, `04-dev`)
- [ ] The minimap agrees with the camera: the viewport rectangle is where the main view actually is (`04-dev`, `14-sales`)
- [ ] Tab reaches every control and each one shows the focus ring (`13-stack`)
- [ ] Both themes meet WCAG contrast on body text and on every control (`12-light-theme`, `13-stack`)
- [ ] No white flash when the theme switches — the page is painted in the new theme before the first frame (`12-light-theme`)
- [ ] The tray and the browser render identically at the same size (`02-campus`, compared against the tray window)

## The overlay against the office (kept from the 2026-09-11 fix wave)

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
- [ ] The replay transport — date, play/pause, scrub, speed, the Space/arrows hint — is on the screen only in replay mode (`01-first-run` and every zone shot show none)
- [ ] Every wall screen is a mounted object: a bezel, a lit top edge and a shadow seating it, in both themes (`05-qa`, `12-light-theme`)
- [ ] No zone plate is half-eaten by the rail: each is whole, or absent while its zone is off the screen (`04-dev`, `06-research`, `13-stack`)

## Decisions and Messages (added by SP8, 2026-09-13)

- [ ] A decision is made in the office: the reader shows the note as written, and the action bar is at the foot of it with one amber affirmative (`15-decisions`)
- [ ] The action bar never scrolls out of the reader, whatever the length of the note (`15-decisions`)
- [ ] The pressure test is a section of the reader, titled once (`15-decisions`)
- [ ] The key that does the same thing is on the button that does it, and reads on an amber fill (`15-decisions`)
- [ ] Messages is two panes when the sheet has the room: the thread list left, one conversation right (`16-messages`)
- [ ] A participant chip is the person's own colour with white on it, at 4.5:1, in both themes (`16-messages`)
- [ ] An open conversation shows its newest turn, not its oldest (`16-messages`)
- [ ] A live meeting carries one LIVE mark in the list and one in the conversation header — no third amber thing on the screen (`16-messages`)

## The office the owner arranges (added by SP9b, 2026-09-18)

The campus is the owner's to move, staff and wire, so these lines are about the marks that say so: what can be
picked up, what is in flight, where a line runs and what it means. A control has to hold its contrast at every
hour — a resting line is scenery and dims with the room, a selected one and a port ring are painted over the
hour, like the desk lamps.

- [ ] A line between two desks reads as a line at a glance, on the floor under everything that stands (`18-wired-campus`)
- [ ] Peer and access are told apart without a legend: one solid, one dashed, both bowed the same way (`18-wired-campus`, `concept-sp9b-12`)
- [ ] A selected line is unmistakable — accent, its casing under the dashes rather than through them, and the ⓧ on its own midpoint (`21-edge-selected`, `concept-sp9b-12`)
- [ ] The lines do not bury the office: at the campus fit they read as wiring behind the furniture, not as a net over it (`18-wired-campus`)
- [ ] Every line still reads at night, and the port rings with it: a control is painted over the hour, a resting line dims with the room (`22-wired-night`)
- [ ] Each of the five things the owner can add is an object in the room, not an icon on a map — a kiosk stands, a board leans, a note is propped (`18b-resources`, `concept-sp9b-12`)
- [ ] A thing's name is on a plate over its own middle, at the same weight a screen's title is (`18b-resources`)
- [ ] A station's glyph says its family at 20 px and is not a padlock, a badge or an emoji (`20-dock-open`, `18b-resources`)
- [ ] A thing being dragged is visibly in the air: the shadow grows, the footprint below it shows where it lands (`19-dragging`)
- [ ] A blocked landing is red at a glance, on the thing that is in the way (`19b-dragging-blocked`)
- [ ] The dock is one frosted plate above the time strip, six glyphs, labels on hover, nothing else added to the screen (`20-dock-open`)
- [ ] The selection plate hangs beside what it names and says what it is in words, never as an id (`21-edge-selected`)
- [ ] A hire asked for from the dock stands as a ghost desk marked "Hiring …" and seats nobody until Decisions says so (`20-dock-open`)
