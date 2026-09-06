# WatchTogether

Browser extension that synchronizes video playback on any site that has an HTML
video element. Two people join the same room and either of them can pause, play
or seek — the other's video follows along.

Playback state travels over a WebSocket to a small Cloudflare Worker relay that
you deploy yourself (see [server/](server/)). Peers agree a key directly with
each other and encrypt everything they exchange, so the relay forwards sealed
bytes it cannot read and stores nothing. It is never told the room code either,
only a hash of it.

## How to use

1. Optionally deploy your own relay (see below) and put its address into the
   extension: popup → **Settings** → **Relay server** → Save. Without one the
   built-in relay is used.
2. One person presses **Create** and reads out the room code (e.g. `ABC-DEF-GHI`).
3. The other presses **Join**, types the code, and presses Connect.
4. Once both are in, visiting the same site with any video keeps playback in
   sync. Use the toggle at the bottom to sync **This page** only, **All tabs**,
   or turn it **Off**.

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
`build/firefox/` (load at `about:debugging`, or package with
`web-ext build --source-dir build/firefox`). Both browsers run the same
`src/background.js`; only the manifest differs.

## For reference

* [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
* [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
* [mdbootstrap](https://github.com/mdbootstrap/material-design-for-bootstrap)
