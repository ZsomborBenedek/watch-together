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
// All four survive end-to-end encryption, because they constrain the envelope
// rather than the contents. 512 characters leaves room for an encrypted frame
// (~180 bytes) without revisiting this.
const MAX_CLIENTS = 4;
const MAX_MESSAGE_CHARS = 512;

// Over-limit messages are dropped rather than closing the socket: scrubbing a
// video can burst `seeked` events, and losing the session over that would be
// worse than the traffic it saves.
const RATE_WINDOW_MS = 10000;
const RATE_MAX_MESSAGES = 20;

// Longer than any film, so a real viewer never trips it, while still bounding
// how long a parasitic connection can be held open.
const MAX_SESSION_MS = 6 * 60 * 60 * 1000;

// A live client pings every 20s, so silence this long means the socket is
// dead and its slot should go back to the room.
const STALE_SOCKET_MS = 5 * 60 * 1000;

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

        return new Response(null, { status: 101, webSocket: client });
    }

    webSocketMessage(ws, message) {
        // Binary frames and oversized payloads are not part of the protocol.
        if (typeof message !== 'string') return;
        if (message.length > MAX_MESSAGE_CHARS) return;
        if (!this.withinRateLimit(ws)) return;

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
    announcePeers(leaving) {
        const sockets = this.state.getWebSockets().filter(s => s !== leaving);
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

        const id = env.ROOMS.idFromName(code);
        return env.ROOMS.get(id).fetch(request);
    }
};
