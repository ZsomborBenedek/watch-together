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

### Limits

Each is set just above what video sync needs, so the relay is not useful as a
general-purpose message bus. All four constrain the envelope rather than the
contents, so they keep working if payloads are ever encrypted end to end.

| Limit | Value | Real usage |
|---|---|---|
| Clients per room | 4 | 2 |
| Message size | 512 chars | ~110 |
| Message rate | 20 per 10s per socket | a handful per session |
| Session lifetime | 6 hours | one film |
| Stale socket | closed after 5 min of silence | pings every 20s |

Over-limit messages are dropped rather than closing the socket, since scrubbing
a video can burst `seeked` events. Dead sockets are swept when the room next
sees activity, which returns their slot before the capacity check — an idle room
is hibernated and has nothing to reclaim.

## Costs

Comfortably inside the Workers Free plan for personal use: 100k requests/day
(one per WebSocket *connection*, not per message) and 13k Durable Object
GB-seconds/month. Hibernation means a room with nobody talking is not billed
for wall-clock time.
