# Privacy Policy

**Watch Together** — last updated 2026-09-07

Watch Together is a browser extension that keeps a video in sync between two
people. This page describes what it sends, what it stores, and who can see it.

## What the extension sends

While you are in a room with sync turned on, the extension sends your friend a
small state message whenever a video on your page plays, pauses or seeks. Each
one contains:

- the **hostname** of the site the video is on (for example `example.com`), so
  your friend's copy syncs only a matching site — never the full page address
- whether the video is **playing or paused**, and its **current position**
- the `id` attribute of the video element and the *length* of its source
  address — not the address itself

If you set a display name under Settings, it is sent to your friend too. It is
optional and limited to 24 characters.

Nothing else leaves your browser. The extension does not send page titles,
full URLs, anything you type, or anything about tabs that are not being synced.

## Encryption

Everything above is end-to-end encrypted. When two people join a room, their
browsers agree a key directly with each other (ECDH P-256, then HKDF and
AES-GCM). The relay server in between forwards sealed bytes it cannot decrypt.

The relay is not even told your room code. The extension derives the room's
address from the code with a deliberately slow hash (PBKDF2, 600,000
iterations), so the code — the only thing that would let anyone derive the
key — never reaches the server.

## The relay server

By default the extension connects to `wss://relay.watch-together.net`, a
Cloudflare Worker whose complete source is in this repository under
[`server/`](server/). It forwards messages between the two people in a room
and does nothing else: it does not parse, log or store any message. It
enforces size and rate limits on the sealed messages and refuses a third
connection to a room.

As with any internet service, Cloudflare's network sees your IP address in
order to deliver the connection.

If you would rather not use the default relay, you can deploy the same Worker
yourself and enter its address under **Settings → Relay server**.

## What is stored on your device

The extension keeps the following in your browser's extension storage, on
your device only:

- your current room and connection state
- your sync mode (Off / This page / All tabs), which tabs are syncing, and your appearance setting
- your display name, and your friend's display name for the current session
- the relay address, if you set one

None of this is sent anywhere except as described above. Uninstalling the
extension removes all of it.

## What we do not do

- **No accounts.** There is nothing to sign up for.
- **No analytics**, telemetry or crash reporting.
- **No third-party services** other than the relay.
- **No advertising**, and nothing is sold or shared with anyone.

## Contact

Questions or concerns: open an issue at
<https://github.com/ZsomborBenedek/watch-together/issues>.
