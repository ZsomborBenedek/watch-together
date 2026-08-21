# WatchTogether

Browser extension that synchronizes video playback on any site that has an HTML
video element. Two people join the same room and either of them can pause, play
or seek — the other's video follows along.

Playback state travels over a WebSocket to a small Cloudflare Worker relay that
you deploy yourself (see [server/](server/)). The relay forwards bytes between
peers and stores nothing.

## How to use

1. Deploy the relay once (see below) and put its `wss://` URL into the
   extension: popup → **Relay server** → paste → Save.
2. One person presses **Create** and reads out the room code (e.g. `ABC-DEF`).
3. The other presses **Join**, types the code, and presses Connect.
4. Once both are in, visiting the same site with any video keeps playback in
   sync. Use the toggle at the bottom to sync **This Page** only, **All** tabs,
   or turn it **Off**.

Room codes are case-insensitive and the dash is cosmetic, so `abc-def` and
`ABCDEF` both work.

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
