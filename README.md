# Founder accelerator (working title)

A canvas where a founder works with a small workforce of people, each in their own room. The founder stays the
operator: people speed the founder up and propose, the founder decides. Nothing runs while the app is closed.

## What is built

- **The stage**: cards on a canvas, wires between them. A wire is access; a person reads only what is wired to them.
- **Talking rooms**: each room is a chat with that person, with tools — docs and files, web search and read, a
  browser card, email, sandboxed code, a project card with a coding agent, consults between people, a task board
  with background runs and repeats, and memory.
- **Studios** (2026-09-19): three cards that make things, driven by the founder from the card and by a wired
  person with `generate_image`, `generate_voice` and `generate_video`. **Image studio** draws from a few words.
  **Voice studio** says a line in one of 28 voices, on this machine. **Video studio** turns a brief into a
  marketing film, a product explainer or a phone reel: a model fills a validated flat storyboard, our TypeScript
  writes the composition, the other two studios draw and speak it, and headless Chrome renders it frame by frame.
  Everything made lands in `workspace/files/media/` and can be downloaded or put on the stage.
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
  three seconds without something arriving on it. Put a free **Pexels** key in `PEXELS_API_KEY` and real
  photographs come first, with the photographer, the page and the licence written down beside every file.
- **An editor, not a slideshow** (2026-09-20): the narration is read in **one go** for the whole film, so the
  voice rises and falls the way somebody talking does, and then it is listened back to — every word's exact place
  is measured. A deterministic editor turns that into a shot list: cuts land on the phrase boundaries the speaker
  actually left, shot lengths are drawn from the look's own distribution rather than a constant, a punch-in
  happens on a stressed word and nowhere else, the payoff gets the one long hold, and a film carries at most five
  sounds, each on a cut frame. Captions are set the way they are in the work this format grew out of — a tenth of
  the frame high, in capitals, with a black stroke, one to three words at a time and one of them the word the line
  turns on. There is no grain and no vignette over any of it: a grade belongs to a look that declares one as its
  format, on the pictures and never over the type.
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
- **Operator views** (2026-09-19): Focus mode (`F` or the header button; a card fills the window); Needs you (dock
  bell, `N`); Messages (`M`); Decisions (`D`; one markdown file per decision in `workspace/decisions/`); Recall (a
  `recall` tool for people, a search for the founder, by meaning, on a local model; a person finds only what their
  wires let them read); the command bar (Ctrl-K or `/`; patterns first, never a model guess); first-run missions,
  ticked from workspace facts; and `?` for the shortcuts.

## Run it

`cd app && pnpm install && pnpm dev`, then open http://localhost:7420. Keys go in `.env` at the repository root:
`GROQ_API_KEY`, `GEMINI_API_KEY`, and optionally `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY` —
more keys mean more free quota for Auto. Your data lives in `workspace/`, which is not in git. The first search
downloads a 23 MB embedding model into `app/.cache/recall/`.

The studios are free, and nothing in them needs a key. **Pictures** are asked for in three places in turn. First
Cloudflare Workers AI (FLUX.1 schnell), which answers in about four seconds: `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`, from a free Cloudflare account — the token needs the **Workers AI Read** permission, or the
call comes back 401. It covers hundreds of pictures a day, and `STAGE_IMAGE_MODEL` points at another Workers AI
model. When that day is spent, **this machine draws them itself** and never runs out: Z-Image-Turbo quantised to
four bits (Apache-2.0) with a Qwen3-4B text encoder, driven by the same stable-diffusion.cpp the local clips use.
The first picture downloads 6.5 GB once into `~/.cache/stage-video-models/pictures/` (the card shows the progress)
and then each one takes about 55 seconds on a laptop with a 4 GB graphics card — 1024×1024, 768×1344 or 1344×768,
four steps, with the weights held in system memory because the card is too small for them. It needs a Vulkan driver
and about 9 GB of memory free. Last come the free Hugging Face demos, which need no account and have the smallest
allowance of the three. `STAGE_IMAGE_BACKEND=local` keeps every picture on this machine, `cloud` never uses it, and
`STAGE_NO_LOCAL_IMAGES=1` turns the local one off. **Real photographs** are optional and take one free key:
`PEXELS_API_KEY` from pexels.com/api, 200 searches an hour, every file cached in `app/.cache/stock/` with the
photographer, the page and the licence written down beside it. A photograph of a person is b-roll and never the
film's own speaker, because the licence forbids implying an endorsement nobody gave. **Voices** need no key at all: Kokoro-82M runs on this
machine's processor, and the first line spoken downloads the 310 MB model into `app/.cache/voice/` (the card
shows the progress); `GEMINI_API_KEY` is the fallback if it will not load. **Music** needs no key and no account:
Openverse is searched anonymously (20 searches a minute, 200 a day, which is far more than a founder will use) and
each track is kept in `app/.cache/music/`; `STAGE_NO_MUSIC_SEARCH=1` turns the search off entirely and every bed is
written here, `FREESOUND_API_KEY` adds a second library if you have a free key, and `STAGE_MUSIC_SEED` pins the
dice so a re-render of one film gets the same bed. **Somebody on camera** is the one thing the studio will not fake. A person speaks in a film only where something
can move their mouth to the actual recording, which today means the free Hugging Face Spaces and an `HF_TOKEN`;
with nothing able to, the film becomes the faceless edit and the card says the two ways to get a real one — your
own footage, or the token. A drawn person whose mouth moves to a separate voice is the fastest way to make a film
read as generated, and there is no switch for it. **Word timings** are measured rather than guessed: the narration
is read in one go and `hyperframes transcribe` (whisper.cpp, already a dependency, nothing leaves the machine)
says where each word falls, so every cut, punch-in and caption lands on a word. It builds itself the first time
and needs `cmake` on the path — `uv tool install cmake` puts one there without root; without it the film still
renders and the card says the timings were worked out from the sentences instead.
**Films** need no key either, only
Chrome and ffmpeg, which the browser card and the app already rely on; they render locally, a minute or so for
a short one. The voice runtime adds about 500 MB to `node_modules`, and each film is a few MB in
`workspace/files/media/`.

Desktop window: `cd app && pnpm shell:build` once, then `pnpm shell`. `pnpm shell:check` is the in-window self-test.

## Checks and security

`cd app && pnpm gate` runs typecheck, unit tests and the browser journeys, and reports their real exit code. Run
`pnpm check:providers` after any change to the tools, and `pnpm check:media` after any change to the studios: it
makes one real picture, one spoken line, one two-scene film, one real fetched music bed and one written here, and
prints what each backend still needs.

The api listens on 127.0.0.1 only and answers only the app's own page: Host, Origin and fetch-metadata checks in
`app/server/guard.ts`. Scripts must send `x-stage-token` with the value of `STAGE_API_TOKEN`.

## Where things are

The earlier product, CUBICLE v2, is archived at tag `v2-final`, branch
`archive/v2`, with its documents under `docs/archive/v2/`.

## Known gaps

- No git remote, so `workspace/` has no copy off this machine.
- Only the keys that are set are used.
- No installer yet.
- The desktop window may not play a film or a recording: WebKitGTK needs GStreamer's "good" plugins, which this
  machine lacks (`sudo pacman -S gst-plugins-good` on Arch). The browser plays them, and every card offers a
  download.
