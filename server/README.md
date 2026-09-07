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

Clients open `wss://<host>/room/<ROOM_ID>`, where `ROOM_ID` is the first half
of `PBKDF2-SHA256(code, salt="watch-together/room", 600k iterations)` in hex;
the second half never leaves the browser and salts the session key derivation.
Peers exchange the code between themselves; only the derived id is ever
transmitted. The stretching matters: the code has ~45 bits of entropy, so with
a plain hash the relay could either enumerate the code offline from the room
id, or substitute its own handshake keys and grind the code out of a captured
frame afterwards. Stretched, each guess costs 600k hashes on both routes.

| Direction | Message | Meaning |
|---|---|---|
| server → client | `{"t":"peers","n":2}` | Room population changed. `n >= 2` means a peer is present. |
| client → server | `{"t":"hello","k":"<base64 P-256 public key>"}` | Handshake offer, relayed to the other peers. |
| client → server | `{"t":"state","v":"<base64 iv+ciphertext>"}` | AES-GCM sealed playback state; relayed verbatim. |
| client → server | `ping` | Heartbeat. Auto-answered with `pong` without waking the DO. |

### Encryption

Both peers send `hello` when the room reaches two, derive a shared secret with
ECDH P-256, and fold the stretched room code into HKDF alongside it. A passive
relay faces the Diffie–Hellman problem; an active one substituting its own
public keys would also have to produce a code it never saw, at a full PBKDF2
stretch per guess. Keys are ephemeral per connection, so a reconnect
renegotiates and a finished session cannot be reopened afterwards.

State is sealed with AES-GCM and carries a monotonic per-connection counter,
so a relay that records a valid ciphertext cannot replay an old pause or seek
later — stale counters are dropped. A typical frame is ~210 characters and a
pathological one ~310, both comfortably inside the 512 limit below.

### Limits

Each is set just above what video sync needs, so the relay is not useful as a
general-purpose message bus. All of them constrain the envelope rather than the
contents, so they keep working even though payloads are encrypted end to end.

| Limit | Value | Real usage |
|---|---|---|
| Clients per room | 2 | 2 |
| Message size | 512 chars | ~110 |
| Message rate | 20 per 10s per socket | a handful per session |
| Connects per IP | 20 per minute | a handful per hour |
| Session lifetime | 6 hours | one film |
| Stale socket | closed after 60s of silence | pings every 20s |

The connect limit runs in the front worker, before a Durable Object is created
or billed, so refused traffic costs nothing. It is per-IP and deliberately
approximate (counted per Cloudflare location) — an abuse valve, not accounting.

Messages must also parse as one of the two client frames above, with exactly
the documented fields and base64 values of plausible length. The relay still
cannot read the sealed contents; it checks grammar, not payloads. This keeps
it from carrying free-form bytes for anyone treating it as a message bus, and
it stops a malicious peer from injecting spoofed server messages such as
`peers` announcements.

Over-limit messages are dropped rather than closing the socket, since scrubbing
a video can burst `seeked` events. Dead sockets are swept when the room next
sees activity, which returns their slot before the capacity check — an idle room
is hibernated and has nothing to reclaim. Because heartbeats are auto-answered
without waking the object, a Durable Object alarm also runs the sweep every
30 seconds while sockets remain, so a client that only pings cannot outlive
the session cap, and a dead socket is reclaimed within about 90 seconds.
That bound matters: while a dead socket is still counted the room looks full,
so the client that lost it is refused when it reconnects and its partner
keeps seeing a peer that is gone.

## Costs

Comfortably inside the Workers Free plan for personal use: 100k requests/day
(one per WebSocket *connection*, not per message) and 13k Durable Object
GB-seconds/month. Hibernation means a room with nobody talking is not billed
for wall-clock time.
