# Watch Together relay

A Cloudflare Worker that relays playback state between peers. One Durable
Object per room code, using hibernatable WebSockets so idle rooms cost nothing.

The relay forwards message bytes untouched and keeps no history. Payloads are
encrypted end to end by the peers, so it cannot read them even if it wanted to:
it sees how many sockets are in a room, how large their frames are and when they
arrive, and nothing else.

It is not even told the room code — clients address rooms by a hash of it, so
the one value that would let the relay derive a session key never reaches it.

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

Clients open `wss://<host>/room/<ROOM_ID>`, where `ROOM_ID` is the first 16
bytes of `SHA-256("watch-together/room|<CODE>")` in hex. Peers exchange the
code between themselves; only its hash is ever transmitted.

| Direction | Message | Meaning |
|---|---|---|
| server → client | `{"t":"peers","n":2}` | Room population changed. `n >= 2` means a peer is present. |
| client → server | `{"t":"hello","k":"<base64 P-256 public key>"}` | Handshake offer, relayed to the other peers. |
| client → server | `{"t":"state","v":"<base64 iv+ciphertext>"}` | AES-GCM sealed playback state; relayed verbatim. |
| client → server | `ping` | Heartbeat. Auto-answered with `pong` without waking the DO. |

### Encryption

Both peers send `hello` when the room reaches two, derive a shared secret with
ECDH P-256, and fold the room code into HKDF alongside it. A passive relay faces
the Diffie–Hellman problem; an active one substituting its own public keys would
also have to produce a code it never saw. Keys are ephemeral per connection, so
a reconnect renegotiates and a finished session cannot be reopened afterwards.

State is sealed with AES-GCM. A typical frame is 188 characters and a pathological
one 284, both comfortably inside the 512 limit below.

### Limits

Each is set just above what video sync needs, so the relay is not useful as a
general-purpose message bus. All four constrain the envelope rather than the
contents, so they keep working even though payloads are encrypted end to end.

| Limit | Value | Real usage |
|---|---|---|
| Clients per room | 2 | 2 |
| Message size | 512 chars | ~110 |
| Message rate | 20 per 10s per socket | a handful per session |
| Session lifetime | 6 hours | one film |
| Stale socket | closed after 5 min of silence | pings every 20s |

Over-limit messages are dropped rather than closing the socket, since scrubbing
a video can burst `seeked` events. Dead sockets are swept when the room next
sees activity, which returns their slot before the capacity check — an idle room
is hibernated and has nothing to reclaim. Because heartbeats are auto-answered
without waking the object, a Durable Object alarm also runs the sweep every
five minutes while sockets remain, so a client that only pings cannot outlive
the session cap.

## Costs

Comfortably inside the Workers Free plan for personal use: 100k requests/day
(one per WebSocket *connection*, not per message) and 13k Durable Object
GB-seconds/month. Hibernation means a room with nobody talking is not billed
for wall-clock time.
