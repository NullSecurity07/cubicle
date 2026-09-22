# Evaluating a Startup Idea — First-Time Founder Notes
*Paul Graham / YC-style pressure test. Bullet notes + diagrams you can redraw by hand.*

---

## 0. The mental model behind everything

- YC's entire philosophy in four words: **"Make something people want."**
- Startups don't die from competition. They die because **nobody wanted the thing** (≈ 40%+ of post-mortems) or because they **ran out of money before finding what people wanted**.
- Evaluation is not about predicting success. It's about **finding the fatal flaw early**, when fixing it costs a week instead of a year.
- The evaluator's stance: *skeptical but not cynical*. Assume the idea is wrong and try to prove it. Whatever survives is worth building.

```
   IDEA ──► PRESSURE TEST ──► SURVIVES? ──yes──► BUILD (cheaply)
                                  │
                                  no
                                  │
                                  ▼
                          PIVOT / KILL / REFRAME
                     (cost: days, not months)
```

### Three types of ideas (PG's taxonomy)
| Type | How it arises | Base rate |
|---|---|---|
| **Organic** | You notice a problem in your own life / work | Best. Most big companies (Apple, Google, FB, Airbnb) started here |
| **Made-up / "sitcom"** | You sit down and *try* to think of a startup | Usually plausible-sounding but fake. Nobody actually has the problem |
| **Assigned / trend-chasing** | "X but with AI", "Uber for Y" | Dangerous — you're competing on a crowded axis with no insight |

### PG's three ingredients of a good idea
1. Something the founders **themselves want**
2. That they **can build**
3. That **few others realise is worth doing**

- The third one is the hard one. A good idea often **looks bad** at first — that's *why* nobody else is doing it.
- Draw this:

```
              ┌─────────────────────────┐
              │  Looks like a good idea │
              │        (crowded)        │
   ┌──────────┼──────────┐              │
   │ Actually │  SWEET   │              │
   │ a good   │   SPOT   │              │
   │ idea     │          │              │
   └──────────┼──────────┘              │
              └─────────────────────────┘
   Ideas that ARE good but LOOK bad = where startups win
```

---

## 1. STEP ONE — Find the core assumption

### What it is
- The **one belief** that, if false, makes everything else irrelevant.
- Also called: *the leap of faith assumption*, *the riskiest assumption*, *the load-bearing wall*.
- Must be written as a **falsifiable sentence**, not a hope.

### How to find it
- Write down every assumption you're making (there'll be 5–15).
- For each ask: **"If this turned out to be false, would I still build this?"**
- The first one where the answer is a hard **NO** is your core assumption.
- Alternate test: "What's the thing I'm most afraid to go check?"

### Good vs bad phrasing
| ❌ Too vague | ✅ Falsifiable |
|---|---|
| "People want better budgeting" | "Freelancers earning $3–10k/mo will pay $15/mo to auto-separate tax money" |
| "Restaurants need better software" | "Independent restaurant owners will switch POS to save 2% in fees despite 18-month contracts" |
| "Parents care about their kids' education" | "Parents will trust an app (not a referral) to choose their child's tutor" |

### Diagram — the assumption stack

```
        ┌──────────────────────────────┐
        │   Revenue / growth model     │  ← depends on ↓
        ├──────────────────────────────┤
        │   Distribution channel works │  ← depends on ↓
        ├──────────────────────────────┤
        │   Users adopt & retain       │  ← depends on ↓
        ├──────────────────────────────┤
        │   Users will PAY             │  ← depends on ↓
        ├──────────────────────────────┤
        │ ★ CORE ASSUMPTION ★          │  ← pull this out and
        │ (the pain is real & urgent)  │    the whole stack falls
        └──────────────────────────────┘
```

### Notes
- The core assumption is almost always about **demand**, not technology. "Can we build it?" is rarely the risk. "Will anyone care?" is.
- Founders instinctively test the assumption they're *most confident* in (because it feels good). Test the one you're *least* confident in.
- One assumption. Not three. If you have three, you haven't found the root.

---

## 2. STEP TWO — The three most likely ways it dies

### Rule: specific, not generic
- Generic = applies to any startup. Useless. ("Competition", "hard to get users", "need funding")
- Specific = names a **mechanism** unique to *this* idea, market, and customer.

| ❌ Generic | ✅ Specific |
|---|---|
| "Competition is tough" | "Toast already has this feature buried in settings; they'll surface it the month you get traction" |
| "User acquisition is hard" | "Your buyer is a school principal who makes purchasing decisions once a year in March; miss it and you wait 12 months" |
| "Might not scale" | "Every new city needs 300 supply-side signups before demand-side works, and you have no channel to seed supply" |

### The failure catalogue — where to hunt for your three
Go through each bucket and ask "does this one apply to *my* idea specifically?"

**A. Demand failures**
- Nobody has the problem (made-up idea)
- Problem is real but **not painful enough** to change behaviour
- Problem is real but people **won't pay** (they'll tolerate it)
- Problem exists but only for a **tiny** number of people

**B. Customer-structure failures**
- **Payer ≠ user** (teacher feels pain, district pays; employee wants tool, IT buys)
- **Two-sided market** with no way to seed the first side
- Customer is **too poor** (students, nonprofits, tiny businesses)
- Customer **can't be reached** (no channel, no list, no community)

**C. Distribution failures**
- No natural channel — you'd need paid ads from day one
- **Long sales cycle** vs short runway (enterprise, government, healthcare)
- Relies on virality but product isn't inherently shareable
- Relies on a platform that can cut you off (App Store, Google SEO, Twitter API)

**D. Competition / timing failures**
- Incumbent can **add it as a feature** in one quarter
- Idea has been tried 5× before — and you don't know **why they died**
- Too early: the enabling technology / behaviour isn't there yet
- Too late: market already consolidated

**E. Economics failures**
- Unit economics negative and don't improve with scale
- **CAC > LTV** with no path to fix
- Gross margin structurally low (services in disguise, hardware, logistics)

**F. Execution / founder failures**
- Requires a skill no founder has (deep ML, regulatory, sales)
- Requires **capital before revenue** (hardware, biotech, marketplaces)
- Founders don't actually want to do the unglamorous work the idea requires

### Diagram — the "why hasn't this been done?" fork
Always ask this. The answer sorts ideas fast.

```
   "Why hasn't anyone done this already?"
                    │
       ┌────────────┼────────────────┐
       │            │                │
   "They have,   "Nobody          "Something just
    and died"    thought of it"    changed (tech/law/
       │            │              behaviour)"
       │            │                │
   Find out WHY  Suspicious —    ★ BEST answer ★
   → is it still  usually means   "Why NOW?" is
   true today?    no demand       answered
```

### Diagram — the payer/user grid

```
                      PAYER
                 same    │   different
              ──────────┼──────────────
      USER    ✅ EASY    │  ⚠ HARD
   feels pain  (consumer,│  (edtech, healthtech,
               SMB tools)│   HR tools)
              ──────────┼──────────────
      USER    ⚠ WEIRD   │  ❌ DEAD
   feels no   (why would │  (nobody wants it,
   pain        they pay?)│   nobody pays)
```

### Notes
- Write your three flaws **without rebutting them**. Rebutting is a defence mechanism.
- The flaw you can't answer in one clear sentence is the real one.
- Look up the graveyard: search "[your idea] shut down", "[your idea] post-mortem". Read at least two.

---

## 3. STEP THREE — Is the pain real? (Problem validation)

### The spectrum — draw this and place your idea on it

```
   VITAMIN ──────────── PAINKILLER ──────────── HAIR ON FIRE
   "nice to have"       "solves real pain"     "urgent, will pay
                                               anything, today"
   ┌──────────┐         ┌──────────┐           ┌──────────┐
   │ interest │         │ some pay │           │ they're  │
   │ but no   │         │ retention│           │ already  │
   │ payment  │         │ OK       │           │ hacking a│
   │ no reten.│         │          │           │ solution │
   └──────────┘         └──────────┘           └──────────┘
   ❌ startup           ✅ workable            ★ ideal
```

### PG's "well vs puddle"

```
   PUDDLE (bad)                    WELL (good)
   ───────────────────             ┌───┐
   many people, shallow            │   │   few people,
   interest — "sure, sounds        │   │   DESPERATE need
   nice" — nobody acts             │   │
                                   │   │   ← dig here, then
                                   └───┘     expand outward
   e.g. "app to help people        e.g. Facebook: only Harvard
   be more productive"             students, but ALL of them
                                   used it daily
```

- Start with a **small group that needs you badly**, not a big group that sort-of wants you.
- Must have a **plausible path to expand** from the well (Harvard → Ivies → all colleges → everyone).

### The five tests for real pain
1. **Existing-solution test** — Is anyone solving this badly *right now*? (spreadsheet, intern, duct-tape tool, paying a consultant)
   - Ugly workaround = **strong signal** of real pain
   - No workaround at all = usually **no pain** (people find a way when it hurts)
2. **Money test** — Are they *already spending* money or time on this? How much?
3. **Disappearance test** — If your product vanished tomorrow, would they be angry, or shrug?
4. **Frequency test** — Daily / weekly pain beats annual pain (annual = forgotten between uses)
5. **Urgency test** — Are they looking for a solution *now*, or would they "get to it eventually"?

### How to actually validate — the Mom Test (Rob Fitzpatrick)
- Never ask "would you use this?" — people lie to be polite. Even your mom.
- Ask about their **life and past behaviour**, not your idea:
  - "Walk me through the last time this happened."
  - "What do you do about it today?"
  - "What have you already tried?"
  - "How much does this cost you (time/money) per month?"
  - "Who else has this problem?"
- Compliments are **noise**. Commitments are **signal**:

```
   SIGNAL STRENGTH  (weak → strong)

   "cool idea"  →  "I'd use that"  →  gives email  →  intro to boss
   →  spends 1 hr on a call  →  agrees to pilot  →  PAYS MONEY
        ↑                                                   ↑
    ignore this                                     only this counts
```

### Notes
- Talk to **10–20** potential customers before writing code. Not friends.
- If you can't find 10 people with the problem, that *is* the result.
- "Everyone" is not a customer. If your answer to "who is this for?" is "everyone", you have a puddle.

---

## 4. STEP FOUR — Founder-market fit

### Why this matters most at the early stage
- The idea **will change**. The founder won't. Investors fund the founder's ability to *find* the right idea, not the current one.
- PG: the best ideas come from founders who are "**living in the future**" — they see a problem because they're already where the market is going.

### Acceptable answers to "why you?"
| Type of fit | Example |
|---|---|
| **Lived the problem** | You did the job, felt the pain daily |
| **Unusual access** | You know 200 customers personally / you're in the community |
| **Unfair technical edge** | You can build what others can't in a reasonable time |
| **Contrarian insight** | You know something about the market that most people believe is wrong |
| **Earned secret** | Years in the industry taught you where the bodies are buried |

### Unacceptable answers
- "I'm passionate about it" (passion is not an edge)
- "I noticed the problem" (noticing is cheap; everyone noticed)
- "I've read a lot about the space" (so has your competitor)
- "I'm a great generalist" (not specific)

### Diagram — the fit matrix

```
                  Knows the CUSTOMER deeply
                    low         │   high
                ────────────────┼────────────────
   Can BUILD    ⚠ tech looking │ ★ STRONG FIT
   it           for a problem  │   (rare, fund this)
                ────────────────┼────────────────
   Can't        ❌ tourist      │ ⚠ needs technical
   build it                    │   cofounder — fixable
```

### Related: schlep blindness (PG)
- Founders unconsciously avoid ideas that involve tedious, painful work ("schleps") — sales, regulation, logistics, dealing with banks.
- Result: **the best ideas are often sitting in plain sight**, unclaimed because they look unpleasant.
- Ask: "Is the reason nobody does this that it's *hard and boring*?" If yes → opportunity, *if* you're willing to do the schlep.

### Notes
- Founder-market fit is the most common step founders **skip** because it feels self-indulgent. Don't.
- Solo founders are a yellow flag (not red). Two founders who've worked together before is the strongest signal.
- Be honest: if you have zero fit, the fix is a cofounder or a different idea — not more conviction.

---

## 5. STEP FIVE — The verdict

### Three allowed outcomes — no fourth
| Verdict | Meaning | Typical cause |
|---|---|---|
| **STRONG** | Core assumption plausible, flaws survivable, real pain, founder fits. Build a cheap test *now*. | Organic idea + lived pain + clear well |
| **WEAK** | At least one step fails hard, usually pain or distribution. Don't build as-is. | Vitamin, not painkiller; or no channel |
| **PIVOT REQUIRED** | Pain is real but you're attacking it wrong — wrong customer, wrong wedge, wrong angle. | Payer/user split; too broad; wrong first well |

- **Banned phrase:** "It has potential, but…" — it lets you avoid deciding.
- **The meta-question:** *Would a serious investor fund this as described today* — not the version you'd build with six more months?
- Answer in **one word** before writing anything else. Then justify.

### Diagram — the decision tree

```
   Is the core assumption plausible?
        │
   no ──┴── yes
   │         │
   ❌ WEAK   Is there a real, urgent pain (painkiller+)?
                  │
             no ──┴── yes
             │         │
          ❌ WEAK    Can the 3 flaws be survived/tested cheaply?
                          │
                     no ──┴── yes
                     │         │
                🔄 PIVOT     Does the founder have real fit?
                                  │
                             no ──┴── yes
                             │         │
                     🔄 PIVOT or      ★ STRONG
                     find cofounder
```

### Scoring rubric (optional — for quick triage)
Score each 0–2. Total /10.

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Core assumption | Vague / unfalsifiable | Stated, untested | Stated + early evidence |
| Fatal flaws | Can't answer any | Can answer 1–2 | All 3 have a cheap test |
| Pain level | Vitamin | Painkiller | Hair on fire |
| Founder fit | Tourist | Some access/skill | Lived it + can build |
| Why now | No answer | Plausible | Clear shift (tech/law/behaviour) |

- 8–10 → Strong  · 5–7 → Pivot / needs work  · 0–4 → Weak

---

## 6. Recurring patterns worth memorising

### Tarpit ideas (YC term)
- Ideas that **look great, attract many founders, and reliably fail**. Common ones:
  - Discovery apps ("find things to do this weekend")
  - Social network for [niche]
  - Recipe / meal-planning apps
  - Generic productivity / note-taking
  - Event planning apps
  - "Uber for X" where X has no urgency
- Why they trap people: the *problem is real* but the *pain is shallow*, so everyone recognises it and nobody pays.
- Test: search the idea — if you find 20 dead versions, it's a tarpit.

### "Do things that don't scale" (PG)
- Early on, **manually** recruit users one by one. Airbnb went door-to-door in NYC photographing apartments.
- Manual = fast learning. Automation = premature.
- If you're not willing to do the unscalable thing, you probably don't want it badly enough.

```
   TIME →
   ┌────────────────────────────────────────┐
   │ manual, 1-by-1  │  semi-auto  │  scale │
   │ (learn)         │  (systemise)│ (grow) │
   └────────────────────────────────────────┘
     ↑ most founders skip this and die here
```

### The wedge / expand path
- Don't launch the full vision. Launch the **narrowest useful slice** to the **most desperate users**.

```
        ┌─────────────────────────────┐
        │        FULL VISION          │
        │   ┌─────────────────────┐   │
        │   │    Year 2 expand    │   │
        │   │  ┌───────────────┐  │   │
        │   │  │ ★ WEDGE ★     │  │   │
        │   │  │ (day 1: tiny, │  │   │
        │   │  │  desperate)   │  │   │
        │   │  └───────────────┘  │   │
        │   └─────────────────────┘   │
        └─────────────────────────────┘
```

### Consumer vs B2B quick-check
| | Consumer | B2B |
|---|---|---|
| Pain signal | Daily use, retention | Someone has budget line |
| Death risk | Nobody comes back | Sales cycle > runway |
| Validation | Retention curve | Signed pilot / LOI / payment |
| Payer/user | Usually same | Often different — check |

### Moats — what stops the copycat?
- Network effects (each user makes it better for others)
- Switching costs (data, integrations, habit)
- Proprietary data / distribution
- Brand (rare early)
- **Speed of learning** (the only moat a week-one startup actually has)

---

## 7. Worked examples — recognise the patterns

### Airbnb (2008) — looked bad, was good
- **Core assumption:** strangers will sleep in strangers' homes for money.
- **Flaws (specific):** trust problem both sides; hosts had no way to look credible (bad photos); needed simultaneous supply + demand per city.
- **Pain:** hosts were broke (real, urgent); guests — hotels sold out during events (hair-on-fire in specific windows).
- **Founder fit:** founders *were* the broke hosts — lived the problem. Designers → fixed the photo problem themselves.
- **Verdict then:** most investors said WEAK. Actually STRONG — the "looks bad" quadrant.
- Lesson: the flaw everyone cited (trust) was fixable; the well (event-week demand) was deep.

### Quibi (2020) — looked good, was bad
- **Core assumption:** people want premium 10-minute video on mobile, *and will pay* for it, *and can't get it elsewhere*.
- **Flaws (specific):** YouTube/TikTok already free short-form; no sharing/social features; couldn't cast to TV; launched into lockdown when "on the go" vanished.
- **Pain:** vitamin. Nobody was hacking together a solution to "I need premium short video".
- **Founder fit:** Hollywood execs — great at content, no consumer-mobile intuition, no lived pain.
- **Verdict:** WEAK from day one, hidden by $1.75B and famous names.
- Lesson: capital and credentials don't fix a missing pain.

### Pattern to note
```
   Airbnb:  looked ❌  →  was ✅    (flaws were FIXABLE, pain was DEEP)
   Quibi:   looked ✅  →  was ❌    (flaws were STRUCTURAL, pain was SHALLOW)
```

---

## 8. One-page template — fill this in for any idea

```
IDEA (one sentence): ______________________________________

WHO exactly (the well, not the puddle): _______________________

CORE ASSUMPTION (falsifiable): ______________________________
   → cheapest way to test it: _______________________________

THREE SPECIFIC WAYS IT DIES:
   1. ________________________________  survivable? Y/N  test: ____
   2. ________________________________  survivable? Y/N  test: ____
   3. ________________________________  survivable? Y/N  test: ____

WHY HASN'T THIS BEEN DONE?  □ tried & died  □ nobody thought  □ something changed
   → why NOW: ______________________________________________

PAIN LEVEL:  vitamin ○────○────○ hair on fire
   existing workaround they use today: _____________________
   what it costs them (time/₹/$ per month): _________________
   # real customer conversations done: ____

PAYER = USER?  □ yes  □ no → who pays: _____________________

FOUNDER FIT (circle): lived it / access / technical edge / secret / none
   → in one sentence: _______________________________________

VERDICT (one word first):  STRONG / WEAK / PIVOT
   → because: ______________________________________________
   → next 7-day action: _____________________________________
```

---

## 9. Order of operations — and the trap

- Founders naturally start at **Step 4** (why I'm great) and skip **Step 3** (is the pain real).
- Run it **in order**: assumption → flaws → pain → fit → verdict.
- Do it in writing. Verbal reasoning lets you dodge.
- Repeat every time the idea changes materially — the core assumption moves when the customer moves.

```
   1 ASSUMPTION → 2 FLAWS → 3 PAIN → 4 FIT → 5 VERDICT
        ▲                                        │
        └──────── re-run after every pivot ◄─────┘
```

---

## 10. Reading list (primary sources)
- Paul Graham: *How to Get Startup Ideas*, *Do Things That Don't Scale*, *Schlep Blindness*, *Startup = Growth*, *The 18 Mistakes That Kill Startups*
- YC: *Startup School* (free), *How to Evaluate Startup Ideas* (Kevin Hale), *Tarpit Ideas* (Dalton Caldwell & Michael Seibel)
- Rob Fitzpatrick: *The Mom Test*
- Eric Ries: *The Lean Startup* (leap-of-faith assumptions, build-measure-learn)
- Peter Thiel: *Zero to One* (the "secret" question — what important truth do few people agree with you on?)
