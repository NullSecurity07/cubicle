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
cd app && node scripts/site-shots.ts
```

It never touches your own workspace, keys or running app. `SITE_SHOTS_PORT` moves its pair of ports (7530 for the
page, 7531 for the api). Desktop gives the whole stage for the top of the page and a crop of each card for the parts
below it. Phone gives the same views as a phone shows them. The app has one theme, dark, so the same pictures appear
in both of the site's themes.

A crop's size follows the layout of the app. After a refresh, check that the `width` and `height` on each `<img>`
and `<source>` still match its file, so the page keeps its place while pictures load.

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
