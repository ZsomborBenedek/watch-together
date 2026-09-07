'use strict';

// Watch Together relay.
//
// One Durable Object per room code. The DO is a dumb fan-out switch: whatever
// one client sends is forwarded verbatim to every other client in the room.
// It never parses or stores the payload, so the server learns nothing about
// what anyone is watching beyond message sizes and timing.

// Envelope limits. Each is set just above what video sync actually needs: a
// real state frame is ~110 characters and arrives a handful of times per
// session. The narrower the accepted behaviour, the less this relay is worth
// to anyone looking for a general-purpose message bus — which is a more
// durable defence than gating the door, since it removes the prize rather
// than taxing access to it.
//
// All of them survive end-to-end encryption, because they constrain the
// envelope rather than the contents. 512 characters leaves room for an
// encrypted frame (~180 bytes) without revisiting this.
// The handshake negotiates a single pairwise key, so a room is exactly two
// people: a third socket could never join the conversation, only break the
// key agreement for the two who had one.
const MAX_CLIENTS = 2;
const MAX_MESSAGE_CHARS = 512;

// Over-limit messages are dropped rather than closing the socket: scrubbing a
// video can burst `seeked` events, and losing the session over that would be
// worse than the traffic it saves.
const RATE_WINDOW_MS = 10000;
const RATE_MAX_MESSAGES = 20;

// Longer than any film, so a real viewer never trips it, while still bounding
// how long a parasitic connection can be held open.
const MAX_SESSION_MS = 6 * 60 * 60 * 1000;

// A live client pings every 20s, so three missed beats means the socket is
// dead and its slot should go back to the room. This has to be short: until
// the dead socket is reclaimed the room looks full, so the very client that
// lost it is refused when it reconnects, and its partner is told a peer is
// still there. Five minutes of that is what made sessions feel haunted.
const STALE_SOCKET_MS = 60 * 1000;

// Heartbeats are answered by the runtime without waking this object, so a
// socket that only pings would never be seen by an activity-driven sweep and
// could outlive every limit above. The alarm is the wake-up path that keeps
// the limits honest, and it bounds how late a dead socket is noticed: worst
// case is STALE_SOCKET_MS plus one alarm period. Each wake is one billed
// request; at this rate a room open all day costs ~2,900 of the free plan's
// 100,000.
const SWEEP_ALARM_MS = 30 * 1000;

// The extension only ever says two things here ('ping' is answered by the
// runtime before it reaches us): a hello carrying one P-256 public key, and a
// sealed state frame. The relay stays blind to content — these checks are
// grammar, not inspection — but refusing to carry free-form bytes is most of
// what makes it worthless as a general-purpose message bus.
const HELLO_KEY_CHARS = 88;  // a 65-byte uncompressed P-256 point in base64
const STATE_MIN_CHARS = 40;  // 12-byte iv + 16-byte tag + a little payload
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function isBase64(value, min, max) {
    return typeof value === 'string' &&
        value.length >= min && value.length <= max &&
        value.length % 4 === 0 &&
        BASE64_PATTERN.test(value);
}

function conformsToProtocol(message) {
    let parsed;
    try {
        parsed = JSON.parse(message);
    } catch (e) {
        return false;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return false;
    }
    // Exactly the documented fields; extra ones would be room to smuggle in.
    if (Object.keys(parsed).length !== 2) return false;
    if (parsed.t === 'hello') {
        return isBase64(parsed.k, HELLO_KEY_CHARS, HELLO_KEY_CHARS);
    }
    if (parsed.t === 'state') {
        return isBase64(parsed.v, STATE_MIN_CHARS, MAX_MESSAGE_CHARS);
    }
    return false;
}

export class Room {
    constructor(state, env) {
        this.state = state;

        // Answered by the runtime without waking a hibernating DO, so clients
        // can heartbeat cheaply. The extension relies on this: WebSocket
        // traffic is also what keeps Chrome's service worker from being
        // evicted mid-session.
        this.state.setWebSocketAutoResponse(
            new WebSocketRequestResponsePair('ping', 'pong')
        );
    }

    async fetch(request) {
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('expected a websocket upgrade', { status: 426 });
        }

        // Reclaim slots from dead sockets first, or a crashed peer locks its
        // partner out of their own room until the socket eventually times out.
        // close() only starts the closing handshake, so the swept sockets are
        // still listed here — count what sweep reports as live instead.
        const live = this.sweep();

        if (live.length >= MAX_CLIENTS) {
            return new Response('room is full', { status: 403 });
        }

        const [client, server] = Object.values(new WebSocketPair());

        // Hibernatable: the DO can be evicted between messages and the socket
        // stays open, so an idle room costs nothing.
        this.state.acceptWebSocket(server);

        // Rate and lifetime counters live in the attachment because instance
        // memory does not survive hibernation.
        const now = Date.now();
        server.serializeAttachment({ opened: now, windowStart: now, count: 0, seen: now });

        this.announcePeers();

        await this.scheduleSweep();

        return new Response(null, { status: 101, webSocket: client });
    }

    // Keeps an alarm pending for as long as the room has sockets, so limits
    // are enforced even when nothing but auto-answered heartbeats arrive.
    async scheduleSweep() {
        if (await this.state.storage.getAlarm() === null) {
            await this.state.storage.setAlarm(Date.now() + SWEEP_ALARM_MS);
        }
    }

    async alarm() {
        const live = this.sweep();
        if (live.length > 0) {
            await this.state.storage.setAlarm(Date.now() + SWEEP_ALARM_MS);
        }
    }

    webSocketMessage(ws, message) {
        // Binary frames and oversized payloads are not part of the protocol.
        if (typeof message !== 'string') return;
        if (message.length > MAX_MESSAGE_CHARS) return;
        // Junk still counts against the sender's allowance, so a client
        // spraying malformed frames rate-limits itself.
        if (!this.withinRateLimit(ws)) return;
        if (!conformsToProtocol(message)) return;

        this.sweep();
        this.sendAll(message, ws);
    }

    // Fixed window per socket. Returns false for messages over the allowance,
    // which are then dropped; the socket itself is left alone.
    withinRateLimit(ws) {
        const now = Date.now();
        const state = ws.deserializeAttachment() ||
            { opened: now, windowStart: now, count: 0, seen: now };

        if (now - state.windowStart > RATE_WINDOW_MS) {
            state.windowStart = now;
            state.count = 0;
        }
        state.count++;
        state.seen = now;
        ws.serializeAttachment(state);

        return state.count <= RATE_MAX_MESSAGES;
    }

    // Closes sockets that have outlived a plausible session or gone silent,
    // and returns the ones still live. Runs on activity only: an idle room is
    // hibernated and costs nothing, so there is nothing there to reclaim.
    sweep() {
        const now = Date.now();
        const live = [];
        for (const socket of this.state.getWebSockets()) {
            const state = socket.deserializeAttachment();
            if (!state) {
                live.push(socket);
                continue;
            }

            // Heartbeats are auto-answered without waking this object, so the
            // runtime timestamp is the only evidence a quiet socket is alive.
            const auto = this.state.getWebSocketAutoResponseTimestamp(socket);
            const lastSeen = Math.max(state.seen || 0, auto ? auto.getTime() : 0);

            const expired = now - state.opened > MAX_SESSION_MS;
            const stale = now - lastSeen > STALE_SOCKET_MS;
            if (expired || stale) {
                try {
                    socket.close(1000, expired ? 'session expired' : 'connection stale');
                } catch (e) {
                    // Already closing; the close handler will tidy up.
                }
            } else {
                live.push(socket);
            }
        }
        return live;
    }

    webSocketClose(ws) {
        this.announcePeers(ws);
    }

    webSocketError(ws) {
        this.announcePeers(ws);
    }

    // Tell everyone how many clients are in the room. The extension treats
    // n >= 2 as "connected" and n < 2 as "waiting for the other peer".
    // Counted from sweep(), not the raw socket list: a socket that sweep has
    // just told to close is still listed until the handshake completes, and
    // counting it would tell a joiner a peer is present when nobody is.
    announcePeers(leaving) {
        const sockets = this.sweep().filter(s => s !== leaving);
        const message = JSON.stringify({ t: 'peers', n: sockets.length });
        for (const socket of sockets) {
            this.trySend(socket, message);
        }
    }

    sendAll(message, exclude) {
        for (const socket of this.state.getWebSockets()) {
            if (socket === exclude) continue;
            this.trySend(socket, message);
        }
    }

    trySend(socket, message) {
        try {
            socket.send(message);
        } catch (e) {
            // Socket died between getWebSockets() and send(); the close
            // handler will clean up after it.
        }
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/health') {
            return new Response('ok');
        }

        const match = url.pathname.match(/^\/room\/([A-Za-z0-9-]{4,32})$/);
        if (!match) {
            return new Response('not found', { status: 404 });
        }

        // Codes are shared out loud and typed by hand, so treat case and
        // grouping dashes as cosmetic: "abc-def" and "ABCDEF" are one room.
        const code = match[1].replace(/-/g, '').toUpperCase();

        // A viewer opens a handful of sockets an hour; dozens a minute from
        // one address is someone farming rooms. Checked before the Durable
        // Object exists, so refused traffic costs nothing. Fails open when
        // the binding is missing: this is an abuse valve, not authentication,
        // and a misconfigured deploy should degrade, not lock everyone out.
        if (env.CONNECTS) {
            const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
            const { success } = await env.CONNECTS.limit({ key: ip });
            if (!success) {
                return new Response('too many connections', { status: 429 });
            }
        }

        const id = env.ROOMS.idFromName(code);
        return env.ROOMS.get(id).fetch(request);
    }
};
