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
  Everything made lands in `workspace/files/media/` and can be downloaded or put on the stage. A finished film
  (not a draft) also gets a `<film>.mlt` that Shotcut or Kdenlive opens, with its pictures and sound in
  `<film>.parts/` beside it, so a founder can move a cut by hand.
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
- **Leads** (2026-09-24): a light CRM on the stage, in the shape Twenty uses and without Twenty. One card holds the
  people you might sell to, a column a stage from New to Customer, each with their company, a fit score and notes;
  add one by hand, move it, and take the list away with Copy as CSV. A person wired to the card adds, scores (with
  the `icp-fit` skill), notes and moves leads, and **Draft first message** asks them for one built on evidence.
  `find_leads` asks you first and then runs **OpenOutreach** on this machine (`uvx openoutreach find`), which only
  finds: plain finding spends nothing, and verified email lookups are the one thing that costs credits (one each, 40
  free). The app never runs OpenOutreach's sending verbs. **Sending stays with you**, in the mail card, and a lead
  is marked contacted only by you, or by an email you said yes to.
- **Deck** (2026-09-25): slides made on this machine, because a founder rewrites a deck every week and should not
  have to open a slide editor to do it. Write what the deck is for, pick what it is for (pitch, investor update,
  sales, demo day) and a look (clean, editorial, or brand, which takes a wired project's colours, typeface and logo),
  and press **Make**. It is made from what is wired to the card: documents, notes, a project's README and a Metrics
  card. The slides land as a strip of thumbnails with **Download PDF**, printed by the same headless Chrome the films
  use; there is no PowerPoint file. A critic that is rules, not a model, keeps one idea a slide and a headline under
  nine words, lets a number on only when the wired material states it, puts "No numbers yet." on traction unless a
  Metrics card is wired, and names an amount on the ask only when your brief does. Notes under the deck ("merge 2
  and 3, drop 5, slide 4: say it for a buyer") remake only the slides they touch, as the next version beside the
  last. A person wired to the card can `make_deck`, `edit_deck` and `read_deck`.
- **Metrics** (2026-09-25): the few numbers a founder steers by, on the stage where people can read them. One card
  holds a north star, large, with how it moved since last week (or month) and a line of the last twelve, and up to
  six more numbers beneath it. Paste a table or drop a `.csv` or `.json` file, a date then one column a number or
  one row a reading; the card says which rows it skipped and why. Or type today's value into the row at its foot.
  Every point says where it came from when you hover it. **Every sum is worked out in TypeScript**, never by a
  model: the change, the percentage, how many periods in a row, and whether a target is on pace. A person wired to
  the card reads a dated summary of it on every turn and more with `read_metrics`; `propose_target` puts a suggested
  target in Needs you for you to accept or decline, and `log_metric` writes a number **only after you say yes**,
  naming who wrote it. Needs you also brings up a number that reached its target, got worse three periods in a row,
  or has had no entry for two. The readings live in `workspace/metrics/<card>.json`.
- **Runway** (2026-09-25): a single burn number is a spreadsheet; what a founder wants is "how long do we have, and
  what if we hire in January". The card holds cash and the day it was counted, then what goes out and comes in each
  month (a label, an amount, start and end months, growth for revenue), and reads back burn, **months left** and the
  day cash runs out. Up to three scenarios sit beside Base as tabs, each a set of changes (add a flow, drop a Base
  one, a one-off sum such as a raise), and each is drawn as a line of cash over 24 months. Every number is plain
  TypeScript in `shared/runway.ts`, never a model, and **Export CSV** gives the same numbers to any spreadsheet. A
  bank statement can be pasted as CSV: it is grouped by payee on this machine and nothing counts until you tick it.
  Under six months the months turn amber, under three red, and Needs you says so once per crossing. A wired person
  reads a one-line summary and `read_runway`, and may only suggest (`propose_flow`, `propose_scenario`); you accept
  or decline on the card. The numbers reach that person's model, so the card says which one and offers to keep them
  on this machine's. It is not accounting: no taxes, no accruals.
- **A site read whole, and a page watched** (2026-09-24): `crawl_site` reads a competitor's site in one go, 15
  pages two links deep unless a person asks for more (at most 40, three deep), two at a time and gently, and obeys
  its robots.txt. It gives a map of the pages and quotes the five that best answer your question; every page's text
  goes into `files/crawls/` for later. `watch_page` asks you first, then reads one page every six hours **while the
  app is open** and never while it is closed. A change comes to that person's conversation and to Needs you, with
  the lines that changed; numbers alone (dates, counters) do not count. A person watches at most ten pages, and the
  side panel shows them with a Stop button. The `watch-a-competitor` skill puts both together.
- **Operator views** (2026-09-19): Focus mode (`F` or the header button; a card fills the window); Needs you (dock
  bell, `N`); Messages (`M`); Decisions (`D`; one markdown file per decision in `workspace/decisions/`); Recall (a
  `recall` tool for people, a search for the founder, by meaning, on a local model; a person finds only what their
  wires let them read); the command bar (Ctrl-K or `/`; patterns first, never a model guess); first-run missions,
  ticked from workspace facts; and `?` for the shortcuts.
- **Dashboard** (2026-09-24): one screen for the founder's day (Ctrl-D, the dock's four-square chip, or "dashboard",
  "home" or "today" in the command bar). Today: what needs you, tasks running and due, pages that changed, decisions to
  make, replies to read, and the leads pipeline by stage. Tokens and health: fourteen days of tokens, each provider's
  allowance left today, the week by person and by tool, and the health checks. Teams: every framework, placed or not,
  with its last eval, a Place or Open button, the skills used this week, and the notes people kept on their own. Made
  this week: the studios' pictures, voices and films, with their credits. Every row opens the room, card or panel it
  came from. It reads the stores the app already keeps (`GET /api/dashboard`, the `dashboard` slice) and refreshes
  itself when any of them change.
- **Thirteen more teams on the shelf** (2026-09-25): a founder's recurring jobs deserve a team that already knows how,
  so the Frameworks panel now ships thirteen more, each built from one note in the library and each person holding to
  what they must never do (invent a number, send, post, or write from an empty doc). **LinkedIn content system** is
  the owner's own notes, kept word for word: a buyer researcher, a post writer (five CPIO posts a week through the
  pre-publishing checklist), a distributor, a scorekeeper who fills the weekly scorecard only from pasted numbers, and
  outbound, who drafts soft DMs and keeps the Leads card; the LinkedIn card is only read, and the founder presses
  every button. The other twelve come from the 2026-09-25 research, their notes citing every source by link:
  **Weekly metrics**, **Customer discovery**, **Investor update**, **Product-market fit engine**, **Seed round prep**,
  **Pre-mortem**, **Pricing and unit economics**, **Traction channels**, **Hiring scorecard**, **Positioning**,
  **Working backwards** and the **One-page plan**. A shelf test checks every team's briefs against its own note's
  headings, and that whoever is told to use the board, the leads, a browser or a colleague is wired to it.

## Run it

`cd app && pnpm install && pnpm dev`, then open http://localhost:7420. Keys go in `.env` at the repository root.
One key is enough to start and two are better: Auto asks them in the order below, and when one is out of its free
allowance for the day the next one answers. Every key here is free. Your data lives in `workspace/`, which is not in
git. The first search downloads a 23 MB embedding model into `app/.cache/recall/`.

| Provider | Free, as its own page said on 2026-09-24 | Key from | Asks for | In `.env` |
| --- | --- | --- | --- | --- |
| Groq | 1,000 requests a day for each model; gpt-oss and Qwen are counted apart, so one key is two days' worth | console.groq.com/keys | email | `GROQ_API_KEY` |
| Cerebras | 1M tokens a day, 5 a minute, for each model; gpt-oss and Qwen apart again | cloud.cerebras.ai | email | `CEREBRAS_API_KEY` |
| Gemini | 1,000 requests a day on Flash Lite; sees pictures | aistudio.google.com/apikey | a Google account | `GEMINI_API_KEY` |
| NVIDIA | Kimi K2.6, 40 a minute, no daily cap; for trying things out and building, not for serving customers | build.nvidia.com | email and a phone number | `NVIDIA_API_KEY` |
| Z.ai | GLM-4.7 Flash, no published cap, but one request at a time | z.ai | email | `ZAI_API_KEY` |
| Vercel | $5 of credit a month; buying any credit ends the free part | vercel.com, AI Gateway | a Vercel account | `AI_GATEWAY_API_KEY` |
| Cloudflare | 10,000 neurons a day, about 130k tokens out on Llama 4 Scout; sees pictures | dash.cloudflare.com, Workers AI | an account, and its account id | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Ollama cloud | gpt-oss 120B, one request at a time; not the models on this machine | ollama.com/settings/keys | email | `OLLAMA_API_KEY` |
| SambaNova | 20 requests a day, so it answers last | cloud.sambanova.ai | email | `SAMBANOVA_API_KEY` |
| Mistral | Mistral Small, 60 a minute on the free plan | console.mistral.ai | email and a phone number | `MISTRAL_API_KEY` |
| OpenRouter | 50 requests a day across all its free models; Gemma 4 31B, sees pictures | openrouter.ai/keys | email | `OPENROUTER_API_KEY` |

On this machine `GROQ_API_KEY` and `GEMINI_API_KEY` are set, and the Cloudflare token and account id the pictures
already use make Cloudflare answer too; `OPENROUTER_API_KEY` is there but empty. Health says how many are set and
which names would bring the rest, and `pnpm check:providers` asks each one once and prints `OK`, `NO KEY` or what it
said. A second key for the same provider goes in as `GROQ_API_KEY_2`, a third as `_3`. The limits the app works to
are in `app/server/models.json`, and a provider's own headers and refusals overrule them.

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

**Finding leads** is optional and needs OpenOutreach's own settings in the same `.env`; a person who asks for leads
is told which of these are still missing, and the app hands only these to OpenOutreach, read fresh on every run:
`OPENOUTFIND_PRODUCT_DOCS` (a file describing what you sell), `OPENOUTFIND_CAMPAIGN_TARGET` (a file describing who
buys it), `OPENOUTFIND_AI_MODEL` (the model that judges each candidate, e.g. a Groq or Gemini model id),
`OPENOUTFIND_LLM_API_KEY` (that model's key), `OPENOUTFIND_BETTERCONTACT_API_KEY` (BetterContact, where the
candidates come from; the free tier has 40 credits), `OPENOUTFIND_OPERATOR_EMAIL` and `OPENOUTFIND_OPERATOR_COUNTRY`
(who is running it), and `OPENOUTFIND_ACCEPT_LEGAL_NOTICE` (your own acceptance of its legal notice, which the app
never gives for you). It runs through `uvx`, so `uv` must be installed.

### Connect Twenty

The Leads card needs nothing else. If you want a full CRM beside it, run your own **Twenty** and the card mirrors
itself there: every lead becomes a Person at a Company, each note becomes a Twenty note, and the stage becomes a
**Cubicle stage** field the app adds once. Change a stage, a title, an email or a LinkedIn link in Twenty and the
card follows within two minutes. Give somebody a Cubicle stage in Twenty and they join your first Leads card. A
person deleted in Twenty stays on the card and is put back there; you delete here. When both sides changed, the
later change wins, and the console says which. The app never starts Twenty for you.

Twenty needs Docker and about **2 GB of memory** (four containers; 1.6 GB on the live check). Put this in a folder
of its own as `docker-compose.yml`, pinned to the version the app was tested with:

```yaml
name: twenty
x-env: &env
  PG_DATABASE_URL: postgres://postgres:${PG_DATABASE_PASSWORD}@db:5432/default
  SERVER_URL: http://localhost:3000
  REDIS_URL: redis://redis:6379
  STORAGE_TYPE: local
  ENCRYPTION_KEY: ${ENCRYPTION_KEY}
services:
  server:
    image: twentycrm/twenty:v2.42.4
    volumes: [server-local-data:/app/packages/twenty-server/.local-storage]
    ports: ["127.0.0.1:3000:3000"]
    environment: { <<: *env, NODE_PORT: 3000 }
    depends_on: { db: { condition: service_healthy }, redis: { condition: service_healthy } }
    healthcheck: { test: curl --fail http://localhost:3000/healthz, interval: 5s, timeout: 5s, retries: 20 }
    restart: always
  worker:
    image: twentycrm/twenty:v2.42.4
    volumes: [server-local-data:/app/packages/twenty-server/.local-storage]
    command: ["yarn", "worker:prod"]
    environment: { <<: *env, DISABLE_DB_MIGRATIONS: "true", DISABLE_CRON_JOBS_REGISTRATION: "true" }
    depends_on: { db: { condition: service_healthy }, server: { condition: service_healthy } }
    restart: always
  db:
    image: postgres:16
    volumes: [db-data:/var/lib/postgresql/data]
    environment: { POSTGRES_DB: default, POSTGRES_USER: postgres, POSTGRES_PASSWORD: "${PG_DATABASE_PASSWORD}" }
    healthcheck: { test: pg_isready -U postgres -h localhost -d postgres, interval: 5s, timeout: 5s, retries: 10 }
    restart: always
  redis:
    image: redis
    command: ["--maxmemory-policy", "noeviction"]
    healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 5s, timeout: 5s, retries: 10 }
    restart: always
volumes: { db-data: {}, server-local-data: {} }
```

Beside it, a `.env` with the two secrets it needs, each made once and kept: `PG_DATABASE_PASSWORD=` followed by
the output of `openssl rand -hex 16`, and `ENCRYPTION_KEY=` followed by the output of `openssl rand -base64 32`.
Then `docker compose up -d`. The first start downloads about 2 GB and takes two or three minutes. Open
http://localhost:3000, sign up with an email and a password, and name your workspace. Make a key in **Settings →
MCP & APIs → API → Create API key**, with the Admin role, since the app adds one field. Copy it at once: Twenty
shows it only then. Put these two lines in the app's `.env`:

```
TWENTY_URL=http://localhost:3000
TWENTY_API_KEY=the key you copied
```

Start the app again. The Leads cards go over within half a minute. `pnpm health` says whether Twenty answers, and a
Leads card says so in one quiet line while it does not. Twenty's own compose file is in its repository under
`packages/twenty-docker/`.

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
`archive/v2`, with its documents under `docs/archive/v2/`. The product's website is a plain static page in `site/`,
with its pictures taken from the app by `app/scripts/site-shots.ts`; `site/README.md` says how to serve and refresh it.

## Known gaps

- No git remote, so `workspace/` has no copy off this machine.
- Only the keys that are set are used.
- No installer yet.
- The desktop window may not play a film or a recording: WebKitGTK needs GStreamer's "good" plugins, which this
  machine lacks (`sudo pacman -S gst-plugins-good` on Arch). The browser plays them, and every card offers a
  download.
