# Founder accelerator (working title)

A canvas where a founder works with a small workforce of people, each in their own room. The founder stays the
operator: people speed the founder up and propose, the founder decides. Nothing runs while the app is closed.

## What is built

Everything here works today, one line each:

- **The stage**: cards on a canvas, and a wire between two of them is access; a person reads only what is wired to
  them.
- **Rooms**: a chat with each person, who works with tools and answers from what their wires let them read.
- **Docs and files**: shared documents on the stage, pinned ones everybody reads, and a files folder people read and
  write.
- **Two model habits caught by the loop**: small models were seen rewriting a whole shared document to change one
  section, and ending a turn with tool calls and no words. So a person changes one section with `replace_section`, a
  rewrite that would drop most of a document's sections or text is refused (unless it asks to replace the whole), and a
  silent turn is asked once more for two or three sentences, then answered from its tool receipts.
- **Tools**: web search and reading, a browser card (signed in to your own accounts if you like), email, sandboxed
  code, consults between people, and whole pieces of work handed to a colleague.
- **Studios**: an Image, a Voice and a Video studio that draw, speak and cut a film from a brief, on this machine
  where they can; see [docs/studios.md](docs/studios.md).
- **Site studio**: a one-page website made from what is wired to it, checked by rules, and handed over as a folder.
- **Coder card**: OpenCode running in one project folder, driven from the card or by a wired person after you say yes,
  with a code map beside it.
- **Leads**: a light CRM card, a column a stage, that imports a spreadsheet, exports CSV, nudges you about leads gone
  quiet, and finds new ones with OpenOutreach; sending stays with you.
- **Interview and Survey**: a customer call recorded with consent and transcribed on this machine, and a Sean Ellis
  survey scored against 40%.
- **Competitor card**: a rival's pages watched, every change on a timeline, and a stale read in amber.
- **Metrics**: a north star and six more numbers, pasted or typed, with every sum worked out in TypeScript.
- **Runway**: cash, burn, months left and up to three scenarios drawn over 24 months.
- **Deck**: slides made from what is wired to the card, as PDF and PowerPoint, and edited by notes.
- **Frameworks**: seventeen ready teams on four shelves (Find out, Build and sell, Run the company, Raise), each
  placed in one press, kept current with the app, forged from your notes, and scored by its own evals.
- **Skills**: sixteen built in, more written by the people as they learn, switched on and off by you.
- **Memory and recall**: each person keeps a few notes of their own, and Recall searches everything by meaning on this
  machine.
- **Playbook**: what the company learned, as skills a person reads before the work they fit.
- **Decisions**: proposed by people, made by you, one markdown file each.
- **Boards and runs**: task boards whose tasks run in the background, on schedules typed in words, one task starting
  the next.
- **Needs you**: every yes the app waits for, in one list, with a standing yes you can take back.
- **Phone and voice**: Telegram to reach you and be reached, your own voice in the app, and each person's voice when
  they speak.
- **Dashboard**: today's five, your tokens, your teams and what was made this week, on one screen.
- **Health and backup**: every dependency checked in plain words, and a backup of everything you wrote, to a USB drive
  or a synced folder if you like.
- **Keys**: every key the app knows, set, missing or failing, pasted from the window into `.env`.

### More about the newer pieces

- **Leads** (2026-09-24): a light CRM on the stage, in the shape Twenty uses and without Twenty. One card holds the
  people you might sell to, a column a stage from New to Customer, each with their company, a fit score and notes;
  add one by hand, move it, and take the list away with Copy as CSV. **Import** takes a spreadsheet the other way:
  paste its rows or drop a CSV on the card, and before anything lands it says which columns it read (a name, or a
  first and a last, the company, email, LinkedIn, title, site and notes, under whatever headers the tool that made it
  used), shows the first rows as they will land, and which rows it will leave out and why. A work address stands in
  for a missing company, someone already on the card is not added twice, and the card says how many were added,
  already there and skipped. A person wired to the card adds, scores (with
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
  use, and **Download PPTX** beside it, because an investor who asks for "the deck, editable" means PowerPoint: the
  same slides in the same look's colours and typefaces, charts as real charts, speaker notes where a presenter looks
  for them, each source at the foot. A critic that is rules, not a model, keeps one idea a slide and a headline under
  nine words, lets a number on only when the wired material states it, puts "No numbers yet." on traction unless a
  Metrics card is wired, and names an amount on the ask only when your brief does. Notes under the deck ("merge 2
  and 3, drop 5, slide 4: say it for a buyer") remake only the slides they touch, as the next version beside the
  last. A person wired to the card can `make_deck`, `edit_deck` and `read_deck`.
- **Site studio** (2026-09-25): a one-page website made on this machine, because a founder needs a page to point
  people at long before they need a web designer. Write what the site is for and where its button goes (a link or an
  email in the brief), pick a look (clean, editorial, or brand, which takes a wired project's colours, typeface and
  logo), and press **Make**. It is made from what is wired to the card: documents, notes, a project's README, a
  Metrics card, and pictures (a picture card, or an Image studio, which then draws the pictures the page asks for).
  The page is our own HTML and CSS with no script on it: hero, problem, how it works, proof, pricing, questions and a
  closing call to action. The card shows it at a laptop's width and a phone's side by side. A critic that is rules,
  not a model, holds it to one H1, a button above the fold on a 390 px phone, text contrast of 4.5:1 (a brand colour
  that cannot be read is moved just far enough, and words over a picture get a measured wash), a page under 500 KB,
  and every claim traced to a wired doc or the Metrics card; a claim nobody wired is cut, not softened. Each version
  is a folder, `workspace/sites/<card>/v<n>/` with `index.html`, `style.css` and `media/`. **Download folder** gives
  it as a zip for any static host, and **Open in browser card** opens it on the stage. Nothing is hosted; publishing
  is your own step. Notes ("shorter hero, drop pricing, button: Book a demo") remake only the sections they touch, as
  the next version beside the last. A person wired to the card can `make_site`, `edit_site` and `read_site`.
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
- **Interview** (2026-09-25): a customer conversation is the best evidence a founder has, and it usually ends up
  as three half-remembered lines. The card is named for the person, their company and the day, and records nothing
  until you tick that they agreed to be recorded (several places require every party to agree). Then press the red
  button, with a level meter and a clock, or drop a recording from the call app; a call on headphones is only heard
  that way. The transcript fills in with a time on every line, and each time plays the call from there. **Nothing
  leaves the machine**: the sound and the transcript live in `workspace/interviews/`, written down by whisper.cpp
  (`hyperframes transcribe`, base.en; about 3 to 7 s a minute of talk on this box when it is quiet) with the
  microphone's Whisper as the fallback; `STAGE_INTERVIEW_MODEL` picks another whisper.cpp model. A person wired to
  the card reads one line about it each turn and the transcript only with `read_interview`, which can also look for
  one subject. **Write insights** asks that person, with the `story-interview` skill, for the pains, the workaround,
  quotes with their times and any sign they would pay, in a doc the card makes beside itself; wire the Customer
  discovery team's Interviews doc to the card and the insights go there instead.
- **Survey** (2026-09-25): the Sean Ellis question ("how would you feel if you could no longer use it?") is the
  quickest honest read on product-market fit, and a founder should not need a survey tool's dashboard to score it.
  The card starts from PMF (the four Sean Ellis questions), NPS or a blank, and the questions edit in place. The app
  answers only its own page, so it hosts no form: **Copy questions** gives a plain list for an email, and **Copy for
  Tally / Forms** a numbered list with each field's kind and choices, to build the form in Tally or Google Forms.
  Their CSV export comes back by paste or drop; columns are matched to questions by their words (and the Sean Ellis
  and NPS columns by their answers when the header was reworded), and the card says how many rows came in, which
  were skipped and why, and which columns it did not use. The same file imported twice adds nothing. Results show the
  share very disappointed against the **40% benchmark** (never rounded up, and "too few to trust" under 30 answers),
  the segment that would miss it most (from "who would most benefit"), the reasons the very disappointed give and what
  the somewhat disappointed ask for, clustered by shared words, and NPS. **Every number is counted in
  `shared/survey.ts`**, never by a model. A wired person reads a two-line summary each turn and the raw answers with
  `read_survey`; **Write summary** asks them for a doc. The Product-market fit engine team now lands with a Survey
  card wired to its survey runner and segment reader. The answers live in `workspace/surveys/<card>.jsonl`.
- **A site read whole, and a page watched** (2026-09-24): `crawl_site` reads a competitor's site in one go, 15
  pages two links deep unless a person asks for more (at most 40, three deep), two at a time and gently, and obeys
  its robots.txt. It gives a map of the pages and quotes the five that best answer your question; every page's text
  goes into `files/crawls/` for later. `watch_page` asks you first, then reads one page every six hours **while the
  app is open** and never while it is closed. A change comes to that person's conversation and to Needs you, with
  the lines that changed; numbers alone (dates, counters) do not count. A person watches at most ten pages, and the
  side panel shows them with a Stop button. The `watch-a-competitor` skill puts both together.
- **Competitor card** (2026-09-25): a quiet competitor and a competitor nobody looked at for a week look the same,
  so each rival gets a card that says which. Name them and give their site; the card offers their home, pricing and
  changelog pages to watch, and "Watch" starts the same six-hourly watch `watch_page` does, owned by the person wired
  to the card (or by you when nobody is). Every change lands on the card's timeline with the lines that changed and
  the wired person's two lines on what it means (asked in their own voice, once per change; a fixed line in fake mode).
  "Last read" turns amber when the pages have not been read for seven hours, because watches only run while the app is
  open. "Crawl now" reads the whole site into `files/crawls/`. The card keeps no store of its own: it joins the watches
  in `workspace/watch/` by address, and a watch now keeps its last 24 changes. A wired person reads one dated line per
  card, like "Competitor Acme (acme.com): 3 changes this month, latest 2026-09-22 pricing page: Pro $29 → $39."
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
- **Today's five, follow-up nudges and the monthly update** (2026-09-25): a founder opening the app should know in
  one glance what the morning is for, and a lead who replied should never wait a week because nobody remembered.
  The dashboard and the Telegram note now open on **Today's five**: five things ranked by a fixed table (a person
  waiting on your OK, then cash running short, then a lead waiting, a number to look at, decisions, failed runs, due
  repeats, and suggestions last, each plus a little for every day it has waited). No model picks them, so they never
  invent work and cost nothing. Resting on one says why it is there; the cross puts it away until tomorrow
  (`GET /api/today`, `workspace/today.json`). A lead in Contacted with nothing written for five days, or in Replied or
  Meeting for three, gets a quiet dot on the Leads card and one line in Needs you ("Ana at Acme replied 4 days ago.
  Draft a reply?"); its button has the wired person draft it with the evidence-outreach skill, and you send it. One
  nudge per lead per stage, never for New or Fit, and dismissable. The same half-minute look writes down every stage
  move (`workspace/nudges/leads.json`), which is what lets the **monthly investor update** say what moved: "Add the
  monthly investor update" in the command bar puts "Draft the September update" on your board, repeating on the first
  weekday of each month (board repeats now read "every month at 9"). Its person uses the monthly-update skill and
  one tool, gather_month, which returns the month in dated lines read straight from the stores: decisions decided,
  tasks done, lead moves, each number with its change, runway left. Every line names its card, only wired cards are
  read, and the skill forbids any number that did not come back from it. The update lands as a doc; you send it.
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
- **Built-in teams stay current** (2026-09-25): a fix to a shipped team's briefs is worthless if workspaces that copied
  it earlier never see it, so on every start a copy you never touched (its content still one the app once shipped, per
  `app/frameworks/shipped.json`, written by `pnpm frameworks:ledger`) is swapped for today's team, and a copy you
  changed stays yours with a quiet "An update is available" and a Take the update press in the Frameworks panel. The
  replaced copy goes to `workspace/trash/`; teams already on the stage keep the briefs they were placed with.
- **Shelves and search** (2026-09-25): seventeen teams in one scroll is a list nobody reads, so the Frameworks panel
  groups them by the stage of the company they serve (Find out, Build and sell, Run the company, Raise; your own go
  under More) and a search box above narrows them by any word of the name, what the team is for, or its shelf.
  A framework names its shelf in its own file as `stage`, which is not part of what makes a copy yours.
- **Keys** (2026-09-25): the hardest first step was opening `.env` in an editor. The Keys panel (the command bar:
  Keys, api keys, env) lists every name the app reads: each model key straight from `models.json`, then the service
  keys under the Health rows that ask for them (Email, Making clips, Real photographs, More music, Finding leads,
  Phone). A row says set, missing or failing, where to make one, and how many spare keys sit beside it. Paste a
  value and it goes into the `.env` the app reads, the rest of the file kept as you wrote it; once saved, a key is
  never shown again, only that it is set and its last four characters. A key the app reads only when it starts says
  "start the app again to use it", and "Check model keys" asks each model for one word and marks any key that
  failed. Only the app's own window may write keys: a script holding the launch token may not.
- **Backups off this machine** (2026-09-25): a backup on the same disk as the work is no help the day the disk is
  gone. Health's **Back up to…** offers the drives mounted for you and the synced folders you have (Dropbox,
  Nextcloud, OneDrive, Google Drive, pCloud, Syncthing, MEGA, iCloud), takes any other folder by its path, makes it
  and writes to it once before keeping it, and writes it into `.env` as `STAGE_BACKUP_DIR` so the next start uses it
  too. The Dashboard's health group opens with the day of the last backup and where it went, in amber when there is
  none or it is more than a week old.

## Run it

`cd app && pnpm install && pnpm dev`, then open http://localhost:7420. Keys go in `.env` at the repository root:
open Keys from the command bar and paste them there, or edit the file by hand.
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
with its pictures taken from the app by `app/scripts/site-shots.ts` (`pnpm site:shots`). The film at the top of it is
made by the app's own Video studio, from a project card holding the site and this README, by
`app/scripts/site-film.ts` (`pnpm site:film`, real keys). `site/publish.sh` puts it on Cloudflare Pages. `site/README.md`
says how to serve, refresh and publish it.

## Known gaps

- No git remote. `workspace/` has a copy off this machine only once Health's "Back up to…" points the backups at a
  USB drive or a synced folder.
- Only the keys that are set are used.
- No installer yet.
- The desktop window may not play a film or a recording: WebKitGTK needs GStreamer's "good" plugins, which this
  machine lacks (`sudo pacman -S gst-plugins-good` on Arch). The browser plays them, and every card offers a
  download.
