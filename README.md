# WatchTogether

Browser extension that synchronizes video playback on any site that has an HTML
video element. Two people join the same room and either of them can pause, play
or seek — the other's video follows along.

Playback state travels over a WebSocket to a small Cloudflare Worker relay. A
default one is built in; you can also deploy your own (see [server/](server/)).
Peers agree a key directly with each other and encrypt everything they
exchange, so the relay forwards sealed bytes it cannot read and stores nothing.
It is never told the room code either, only a hash of it. Exactly what is
transmitted and stored is spelled out in [PRIVACY.md](PRIVACY.md).

## How to use

1. Optionally deploy your own relay (see below) and put its address into the
   extension: popup → **Settings** → **Relay server** → Save. Without one the
   built-in relay is used.
2. One person presses **Create a room** and shares the room code
   (e.g. `ABC-DEF-GHI`) — there is a Copy button next to it.
3. The other presses **Join with a code**, types it in, and presses **Connect**.
4. Sync is off until you turn it on. Open the page with the video, click the
   extension icon there and pick **This page** (just that tab) or **All
   tabs** (every tab you open the popup on from then on). The peers row shows
   green traffic while the page you are on is syncing, and a quiet dashed
   link when you are connected but it is not. Picking a mode is when the
   browser asks for access — **This page** for that one site, **All tabs**
   for every site; allow it and the mode survives reloads, and All tabs then
   reaches every page with a video even where you never opened the popup.
   Decline, and nothing changes — the previous setting stays. Nothing is
   granted at install.

Under **Settings** you can also give yourself a name, which is shown to the
person you connect with (it travels inside the encrypted channel, so the relay
never sees it), and pin the popup to light or dark instead of following the
system.

Room codes are case-insensitive and the dashes are cosmetic, so `abc-def-ghi` and
`ABCDEFGHI` both work.

## The relay

`server/` is a Cloudflare Worker with one Durable Object per room, using
hibernatable WebSockets so idle rooms cost nothing. Deploying it:

```sh
cd server
npm install
npx wrangler login
npx wrangler deploy
```

See [server/README.md](server/README.md) for the message protocol and cost
notes. It fits inside the Workers Free plan for personal use, and unlike some
free tiers there is no inactivity pausing — a relay nobody used for a month
still answers.

## Development

```sh
./build.sh
```

Produces `build/chrome/` (load unpacked at `chrome://extensions`) and
`build/firefox/` (load at `about:debugging`), and packages each as
`web-ext-artifacts/watch_together-<version>-{chrome,firefox}.zip`, ready to
upload to the stores. The version in the filename comes from the manifest.
Both browsers run the same `src/background.js`; only the manifest differs.

## For reference

* [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
* [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
* [mdbootstrap](https://github.com/mdbootstrap/material-design-for-bootstrap)
