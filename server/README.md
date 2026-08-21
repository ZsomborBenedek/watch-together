# Watch Together relay

A Cloudflare Worker that relays playback state between peers. One Durable
Object per room code, using hibernatable WebSockets so idle rooms cost nothing.

The relay forwards message bytes untouched and keeps no history — it knows how
many sockets are in a room, and nothing about what they contain.

## Deploy

```sh
cd server
npm install
npx wrangler login
npx wrangler deploy
```

`wrangler deploy` prints the public URL, e.g.
`https://watch-together-relay.<your-subdomain>.workers.dev`. Put the `wss://`
form of that into the extension (popup → Relay server), or bake it into
`DEFAULT_RELAY_URL` in `src/background.js`.

Local run: `npx wrangler dev` serves on `http://localhost:8787`, which the
extension reaches as `ws://localhost:8787`.

## Protocol

Clients open `wss://<host>/room/<CODE>`. Codes are case-insensitive and dashes
are ignored, so `ABC-DEF-GHI` and `abcdefghi` are the same room.

| Direction | Message | Meaning |
|---|---|---|
| server → client | `{"t":"peers","n":2}` | Room population changed. `n >= 2` means a peer is present. |
| client → server | `{"t":"state","v":{…}}` | Playback state; relayed verbatim to every other client. |
| client → server | `ping` | Heartbeat. Auto-answered with `pong` without waking the DO. |

Rooms hold at most 8 clients and drop messages over 4096 bytes.

## Costs

Comfortably inside the Workers Free plan for personal use: 100k requests/day
(one per WebSocket *connection*, not per message) and 13k Durable Object
GB-seconds/month. Hibernation means a room with nobody talking is not billed
for wall-clock time.
