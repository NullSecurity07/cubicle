# The website

The product's marketing page: one `index.html`, one `style.css`, one `theme.js` and the pictures in `media/`. There
is no framework and no build step, so any static file server can host the folder as it is.

## Serve it locally

```
cd site && python3 -m http.server 7532
```

Then open http://localhost:7532. Any other static server works the same way.

## Refresh the pictures

Every picture on the page is taken from the app itself, so the site never drifts from the product. The script seeds
a made-up company in a throwaway workspace, starts the app on its own ports with the fake model, and writes WebP
files into `media/`:

```
cd app && pnpm site:shots
```

It never touches your own workspace, keys or running app. `SITE_SHOTS_PORT` moves its pair of ports (7530 for the
page, 7531 for the api). Desktop gives the whole stage for the top of the page and a crop of each card for the parts
below it. Phone gives the same views as a phone shows them. The app has one theme, dark, so the same pictures appear
in both of the site's themes.

A crop's size follows the layout of the app. After a refresh, check that the `width` and `height` on each `<img>`
and `<source>` still match its file, so the page keeps its place while pictures load.

## Remake the film at the top

The loop at the top of the page is made by the app's own Video studio, not by hand. The script starts the app on
its own ports (7670 and 7671, or `SITE_FILM_PORT` and the one after it) with the real models and a throwaway
workspace. It puts a project card on the stage holding the product as a visitor meets it: the README, this page's
copy, its colours and typeface, the mark and the screenshots above. It wires that card to a Video studio and asks
for a 20 second film in the product's own look, with captions, so it reads with the sound off.

```
cd app && pnpm site:film
```

It needs real keys in the `.env` at the top of the repository: Groq or Gemini for the storyboard, and Cloudflare
for the pictures. The narrator runs on this machine. To spend the free quota once, it makes a draft first, kept in
`.shots/hero-draft.mp4`, and then the full film from the same storyboard. If today's free pictures are already
spent, it stops and says so rather than making a film of plain textures. It writes `media/hero.mp4` without a sound
track, since the page plays it muted, and re-encodes it to 720p when it is over 2 MB. It also writes the poster to
`media/hero.webp` and the film's credits to `media/hero-credits.txt`, and prints them.

A visitor who asked their system for less motion sees the poster only, and nothing of the film is fetched.

## Publish it

The site goes to Cloudflare Pages, as a project named `cubicle`:

```
site/publish.sh --check   # lists the account's Pages projects, to prove the token works
site/publish.sh           # creates the project the first time, then deploys
```

The script reads `CLOUDFLARE_ACCOUNT_ID` and a token from the `.env` at the top of the repository, and nothing else
from it. The token is `CLOUDFLARE_PAGES_TOKEN` when that is set, and `CLOUDFLARE_API_TOKEN` otherwise. It uploads a
clean copy of the page, the stylesheet, the script and `media/`, so this README, the script and `.shots/` stay on
your machine. Under the hood it is `npx wrangler pages deploy <copy> --project-name cubicle --branch main`.

The token needs one permission: **Account, Cloudflare Pages, Edit**, scoped to your account. It covers listing,
creating and deploying. A token made only for Workers AI pictures does not have it, and wrangler answers with
"Authentication error [code: 10000]". Make one in the Cloudflare dashboard under My Profile, API Tokens, with that
single permission, and put it in `.env` as `CLOUDFLARE_PAGES_TOKEN`, so the pictures keep their own narrow token.
The site is then at `https://cubicle.pages.dev`, or at the name Cloudflare gives if that one is taken.

## Change the name

The product's name is a working title. It lives in one constant at the top of `theme.js`, which fills every element
marked `data-name` and the tab title. The elements also hold the name as text, for a reader without scripts, so
search `index.html` for `data-name` when the name changes for good.

## Colours and type

The colours come from the app's own `app/src/theme.css`: the same blue for a wire and the same amber for what waits
on the founder. Dark is the default, as in the app. The light theme follows the system, and the button in the
header overrides it; that choice is kept in the visitor's browser only. The typeface is Inter, the one the app
ships, under the SIL Open Font License.

Checks worth running after a change: one `h1`, no horizontal scroll at 390 pixels wide, no console errors, and text
contrast of at least 4.5:1 in both themes. `.shots/` is ignored by git and is the place for screenshots of the page.
