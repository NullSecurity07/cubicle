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
  three looks, word-by-word captions, sound on the cuts, and a music bed ducked under the narration. Nothing about
  a film leaves this machine except what you wired to it.
- **Moving shots** (2026-09-19): switch on *AI clips* and a film can hold real b-roll and a talking head. B-roll is
  drawn **on your own machine** — stable-diffusion.cpp and Wan2.1-1.3B through Vulkan, about three minutes a clip,
  nothing sent anywhere, no limit on how many; the model (5.8 GB) is fetched once. When this computer cannot do it,
  and for talking heads either way, free Hugging Face Spaces make them out of a small daily quota. Whatever fails
  falls back in plain words: a clip becomes a drawn still with a slow push, a presenter becomes the line said over
  the words.
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

The studios are free too, and only the pictures need a key. **Pictures** come from Cloudflare Workers AI
(FLUX.1 schnell): `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, from a free Cloudflare account — the token
needs the **Workers AI Read** permission, or the call comes back 401. It covers hundreds of pictures a day, and
`STAGE_IMAGE_MODEL` points at another Workers AI model. **Voices** need no key at all: Kokoro-82M runs on this
machine's processor, and the first line spoken downloads the 310 MB model into `app/.cache/voice/` (the card
shows the progress); `GEMINI_API_KEY` is the fallback if it will not load. **Films** need no key either, only
Chrome and ffmpeg, which the browser card and the app already rely on; they render locally, a minute or so for
a short one. The voice runtime adds about 500 MB to `node_modules`, and each film is a few MB in
`workspace/files/media/`.

Desktop window: `cd app && pnpm shell:build` once, then `pnpm shell`. `pnpm shell:check` is the in-window self-test.

## Checks and security

`cd app && pnpm gate` runs typecheck, unit tests and the browser journeys, and reports their real exit code. Run
`pnpm check:providers` after any change to the tools, and `pnpm check:media` after any change to the studios: it
makes one real picture, one spoken line and one two-scene film, and prints what each backend still needs.

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
