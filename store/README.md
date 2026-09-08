# Chrome Web Store images

Everything the store listing needs, generated from a real session rather than
mocked up:

| File | Size | Use |
|---|---|---|
| `screenshot-1-in-sync.png` … `screenshot-5-light-dark.png` | 1280×800 | Listing screenshots, in that order |
| `promo-small-440x280.png` | 440×280 | Small promo tile (required) |
| `promo-marquee-1400x560.png` | 1400×560 | Marquee promo tile (optional) |

All are 24-bit PNG with no alpha channel, which is what the store requires.

## Regenerating

```sh
../build.sh                                        # unpacked extension in build/chrome
python3 -m http.server 8080 --directory ../demo &   # serves demo/index.html + demo.mp4
npm install
npm run build                                       # capture, then compose
```

`capture.js` launches two separate Chrome for Testing profiles with the
extension loaded, has Alice create a room and Bob join it over the real relay,
turns on All tabs in both popups, then pauses both demo pages on the same
frame and captures the popup states and pages at 2×. It runs headed, since
Chrome only fires tab activation in a real window. Sync needs the all-sites
access a user grants through Chrome's own permission prompt, which puppeteer
cannot press, so the script loads a copy of the build (`profiles/extension`)
whose manifest carries that grant; the scripts and popup in it are untouched.
`compose.js` lays the captures out as HTML, renders each image with headless
Chrome and flattens it with sharp.

Text and layout changes only need the compose step, and it can be limited to
the images whose name contains an argument:

```sh
npm run compose -- private        # just screenshot-4-private.png
npm run compose -- promo          # both promo tiles
```

Big Buck Bunny (`demo/demo.mp4`) is gitignored; `demo/README.md` says how to
rebuild it.

## What is in the images, and why it is safe to publish

* **Video frames** are from Big Buck Bunny, © 2008 Blender Foundation,
  licensed CC BY 3.0. Attribution with the licence URL is printed on every
  screenshot that shows a frame. Repeat it in the store description too:
  *"Screenshots show Big Buck Bunny © 2008 Blender Foundation, CC BY 3.0."*
* **Browser frame** is drawn by `compose.js`: no Chrome UI, logo or the word
  "Chrome" appears, which the store's promo guidelines ask for.
* **Address bar** shows `example.com`, a domain reserved by IANA for exactly
  this purpose, so no real site is implied.
* **Fonts**: composed text and the promo tiles use Inter (SIL Open Font
  License, loaded from Google Fonts at render time). The popup captures use
  whatever the extension renders with on the machine that runs the script.
* **Names** are Alice and Bob; no real people, no emoji glyphs from any
  platform's emoji font.
* **Icon and popup** are the extension's own artwork.
