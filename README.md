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
  six looks, word-by-word captions, sound on the cuts, and a music bed ducked under the narration. Nothing about
  a film leaves this machine except what you wired to it.
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
`STAGE_NO_LOCAL_IMAGES=1` turns the local one off. **Voices** need no key at all: Kokoro-82M runs on this
machine's processor, and the first line spoken downloads the 310 MB model into `app/.cache/voice/` (the card
shows the progress); `GEMINI_API_KEY` is the fallback if it will not load. **Music** needs no key and no account:
Openverse is searched anonymously (20 searches a minute, 200 a day, which is far more than a founder will use) and
each track is kept in `app/.cache/music/`; `STAGE_NO_MUSIC_SEARCH=1` turns the search off entirely and every bed is
written here, `FREESOUND_API_KEY` adds a second library if you have a free key, and `STAGE_MUSIC_SEED` pins the
dice so a re-render of one film gets the same bed. **Somebody on camera** is drawn here too when the free Spaces have nothing left: the same local video model, asked
for a person talking to camera in the words the portrait was drawn from — moving, gesturing and blinking, about
three minutes a scene and at most twelve minutes a film. Animating the founder's *exact* picture was measured at
twenty minutes for two seconds on this hardware, so it is behind `STAGE_LOCAL_I2V=1` rather than on by default.
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
