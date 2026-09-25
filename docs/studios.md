# The studios

Three cards on the stage make things: the **Image studio** draws from a few words, the **Voice studio** says a line,
and the **Video studio** turns a brief into a film. This is how each of them works and why. Setting them up (the
free keys that help, and what each one downloads the first time) is under "Run it" in the [README](../README.md).

- **Studios** (2026-09-19): three cards that make things, driven by the founder from the card and by a wired
  person with `generate_image`, `generate_voice` and `generate_video`. **Image studio** draws from a few words.
  **Voice studio** says a line in one of 28 voices, on this machine. **Video studio** turns a brief into a
  marketing film, a product explainer or a phone reel: a model fills a validated flat storyboard, our TypeScript
  writes the composition, the other two studios draw and speak it, and headless Chrome renders it frame by frame.
  Everything made lands in `workspace/files/media/` and can be downloaded or put on the stage. A finished film
  (not a draft) also gets a `<film>.mlt` that Shotcut or Kdenlive opens, with its pictures and sound in
  `<film>.parts/` beside it, so a founder can move a cut by hand.
  A wired **Voice studio** narrates the film in its own voice (OmniVoice clones and designs too, credits included) unless the video card's Narrator is set, which wins;
  "Using:" names it ("the voice of the Voice studio, Sarah"), and a line the studio already recorded in that voice is reused word for word.
- **What a film is made of** (2026-09-19): the Video studio builds from what is really there. Wire a **project
  card** to it and it reads that folder read-only — the README, the landing copy, the CSS variables, the typeface,
  the logo — and can wear the product's own colours (the `brand` look); wire a **link** or **browser** card, or
  type a **Product address**, and it photographs the real pages at desktop and phone size and puts the shots in
  phone, laptop and browser mockups; wired **notes**, **documents** and **pictures** are material too. Drop your
  own video, photographs or a music track on the card and it edits around them. Seventeen scene shapes, two paces,
  seven looks — including **documentary**, the long-form register: a serif on a letterboxed frame, held shots, and
  a measured grade that is the film's declared format rather than a filter laid over it — word-by-word captions,
  and a music bed ducked under the narration. Nothing about a film leaves this
  machine except what you wired to it.
- **A picture a cut** (2026-09-20): the narration is recorded and measured *before* anything is drawn, the film is
  cut against it, and only then is a picture asked for — **one per shot**, written from the phrase actually being
  spoken while that shot is on screen. A deterministic critic reads them before a single call is spent: it throws
  out a picture that could illustrate any sentence (there is a banned list, headed by the hand-holding-a-phone shot
  that filled a whole reel), a picture that repeats another one's subject, a picture that shares no word with its
  own line and names no stand-in for it, and any picture that asks a picture model to write — which it cannot do.
  The framing is dealt out rather than requested, so a film cuts between a wide, a medium and a detail instead of
  six medium shots of the same thing. Then the still that came back is **looked at**: the brightness where the type
  will sit is measured and the scrim is solved for the lightest wash that gets the words over 4.5:1, so a white
  wall gets a wash and a dark doorway gets almost nothing; a graded look whose picture came back too dark to see a
  subject in is lifted rather than ungraded. Type has floors now — a headline is never under 8% of a wide frame or
  6% of a tall one, a support line never under 3.2%, nothing at all under 2.6% — and a still frame never holds past
  three seconds without something arriving on it, while the opening changes picture inside two and a half
  whatever the pace. Put a free **Pexels** key in `PEXELS_API_KEY` and real
  photographs come first, with the photographer, the page and the licence written down beside every file.
  A film has **one person in it** at most — a fixed look draws the same stranger every time it is asked for one,
  and four shots of a stranger nobody introduced is the same fault as no picture change at all. And a film over
  fifteen seconds with a number, a list or a comparison in its script now carries a **graphic**: a chart drawn in
  the page, bars growing and figures counting up, rather than four bullet points held over a blurred field. A
  list arrives a line at a time rather than all at once, a scene whose own words reach the caption band keeps
  its words and drops its captions — never two systems of type in one part of the frame — and a letterboxed
  film measures its type against the picture you can see rather than against the file.
- **An editor, not a slideshow** (2026-09-20): the narration is read in **one go** for the whole film, so the
  voice rises and falls the way somebody talking does, and then it is listened back to — every word's exact place
  is measured. A deterministic editor turns that into a shot list: cuts land on the phrase boundaries the speaker
  actually left, shot lengths are drawn from the look's own distribution rather than a constant, a punch-in
  happens on a stressed word and nowhere else, the payoff gets the one long hold, and a film carries at most five
  sounds, each on a cut frame. Captions are set the way they are in the work this format grew out of — a tenth of
  the frame high, in capitals, with a black stroke, one to three words at a time and one of them the word the line
  turns on. There is no grain and no vignette over any of it: a grade belongs to a look that declares one as its
  format, on the pictures and never over the type.
- **A camera, not a slide** (2026-09-24): every picture and clip scene is taken at a **size** (extreme close-up to
  extreme wide), through a **lens** (24 to 135) and with a **move** out of a fixed table of twenty-one — push in,
  pan, tilt, truck, pedestal, crash zoom, whip pan, a parallax arc across the depth planes, and five that only a
  real clip can make (orbit, tracking, handheld, drone pull back, crane up). The storyboard may name any of them;
  the studio deals what it leaves out, so no two neighbours move alike, the quiet looks stay on slow moves, the
  feed looks get the fast ones, and the payoff holds on a slow push. A move on a still is a few keyframes on a box
  around the picture, so the look's own push and the editor's punch-in still run inside it; a move asked of a clip
  is said to the clip model in words. The critic takes a close-up off a wide lens, breaks three shots in a row of
  one size, and turns an orbit asked of a still into the nearest move a still can make, and says so on the card.
  A lens is said in the picture's words as focus and distance, never as anybody's name.
- **Notes, not a new film** (2026-09-24): a finished film keeps a record beside it, `<film>.film.json`: the
  storyboard it was rendered from, every shot's picture in the parts folder with a hash of what made it, and where
  each line sits in the one reading. Write notes under the film — "drop shot 2, trim shot 3 to 4 seconds, swap the
  picture in shot 5 for the office" — and press **Edit**. The plain notes are read without asking anybody; the rest
  go to one small model call that may answer only with the eleven edits the studio knows (trim, drop, move, a new
  picture, a new line, new words on screen, pace, look, music, captions, voice). A note it cannot read comes back as
  "I could not read", and nothing is guessed. Then only what the notes touch is made again: a kept line is cut out
  of the old reading with its own breath and word timings, a new line is said on its own and laid in, a picture is
  drawn again only when the note asks for one or the look changes, and the bed is kept unless the music changed or
  the film moved by more than a tenth. The card says what it kept ("kept 6 of 8 pictures, 7 of 8 lines; drew 2
  pictures, said 1 line"), and the new version lands beside the old one as `<film>-v2.mp4` with its own parts,
  `.mlt`, record and credits line. A trimmed shot never cuts its line short: it holds for the line and says so.
  People wired to the studio have the same thing as `edit_video`.
- **A director, not a form** (2026-09-19): every picker on the card starts on **Auto**, and a brief on its own is
  enough. The studio reads what the brief actually asks for — what it is for, who is watching, how long, how fast,
  what it should sound like, whether somebody is on camera — then decides an angle, a hook and one line of visual
  direction every picture in the film shares, writes the storyboard against that, and only then hands it to a
  **critic** that knows what a film is: a headline on screen and never the narration, a hook at the front and a
  call to action at the back of a reel, four different shapes at the least, a number set as a figure, a list set as
  a list, no scene held longer than a breath, and something to look at on every one. The model gets two goes at its
  own work and after that the rules mend it themselves, so a film is always made. Every decision is said on the card
  in plain words as it happens. Six looks: **creator** (bold kinetic captions, a condensed face shouting, an acid
  accent, a progress bar, phone safe zones), **editorial** (a serif and photographs), **neon**, **clean**,
  **sketch** and **brand**; real cuts between scenes — whip pan, zoom-through, mask wipe, match cut on the beat —
  and every scene with nothing of its own gets a full-bleed picture drawn for it, or a drifting mesh of the film's
  own colours when there is no picture maker. Never a flat rectangle again.
- **Moving shots** (2026-09-19): switch on *AI clips* and a film can hold real b-roll and a talking head. B-roll is
  drawn **on your own machine** — stable-diffusion.cpp and Wan2.1-1.3B through Vulkan, about three minutes a clip,
  nothing sent anywhere, no limit on how many; the model (5.8 GB) is fetched once. When this computer cannot do it,
  and for talking heads either way, free Hugging Face Spaces make them out of a small daily quota. Whatever fails
  falls back in plain words: a clip becomes a drawn still with a slow push, a presenter becomes the line said over
  the words.
- **Music and sound, found or made** (2026-09-19): a film scores itself, with nothing to drop on the card and no key
  to fetch. The studio searches **Openverse** for public-domain music (CC0 or the Public Domain Mark), checks each
  candidate's stated licence against a short list of terms a founder may *sell* a film under, fetches the one it
  picks once into `app/.cache/music/` and writes down its title, author, licence and address in an index and a
  `CREDITS.md` beside it — so the second film works with the network unplugged, and a year later you can still say
  where the music came from. Nothing non-commercial, no-derivatives, share-alike or simply unstated is ever used,
  and a track whose licence asks for a credit says so on the card. When there is no network, no match or no ffmpeg,
  the bed is **written here instead** — chords, bass and light percussion synthesised a sample at a time, seven
  moods, at broadcast bed level so the narration ducking has room. It never fails for want of a network. Whooshes,
  risers and impacts are synthesised the same way, and owe nobody anything.
- **Two voices, one of them borrowed** (2026-09-24): the Voice studio has a second engine, **OmniVoice**, off
  until you switch it on in the card ("Engine") or set `STAGE_OMNIVOICE=1`. It designs a voice from a few words
  ("older man, low pitch, british accent"), clones one from a 5 to 20 second recording dropped on the card, and
  speaks over 600 languages. Its code is Apache-2.0, but its **weights are CC-BY-NC 4.0: what it makes may not be
  sold**, and a film or an ad for your company counts as selling. So every file it makes carries a
  `<file>.credits.txt` saying so and a "non-commercial" mark on the card, a film is read by Kokoro unless you pick
  OmniVoice as its narrator by hand (and then its credits say so too), and a person can use it only where you
  switched it on. Only clone a voice you have permission to use. The first switch-on sets it up in
  `app/.cache/omnivoice/` with `uv` (Python 3.12, about 4 GB of packages and 3.3 GB of weights, once); it runs on
  the graphics card when about 2.4 GB is free and on the processor otherwise (about eight seconds of work a second
  of speech here, with Ollama holding the card), and lets go of the card after five idle minutes. See
  `app/server/media/omnivoice/CREDITS.md`.
- **A film is never silently worse** (2026-09-25): the site's own hero film came back with four faults, and each
  one is now a rule. A narrated film is as long as its reading and a beat to close on, never padded to the length
  asked for — the hero was stretched from fifteen seconds to twenty and held one caption for the last eight; the card
  says the real length instead, and a calm film is handed enough words to come close. A picture that comes back as a
  near-uniform white or black frame is drawn once more and, blank again, left out, so the scene sits on the look's
  own ground with its words; a calm film dips through that ground at an act break rather than flashing white. A claim
  that is in the founder's brief is grounded as surely as one in the material, and every film ends on a scene whose
  shape is its closing line, on the look itself, never on a picture of something else. Captions keep the script's
  casing and its sentences, and are grouped by phrase from the measured timings — never "ai people works beside".
