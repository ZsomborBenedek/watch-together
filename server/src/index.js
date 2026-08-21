'use strict';

// Watch Together relay.
//
// One Durable Object per room code. The DO is a dumb fan-out switch: whatever
// one client sends is forwarded verbatim to every other client in the room.
// It never parses or stores the payload, so the server learns nothing about
// what anyone is watching beyond message sizes and timing.

const MAX_CLIENTS = 8;
const MAX_MESSAGE_BYTES = 4096;

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

        if (this.state.getWebSockets().length >= MAX_CLIENTS) {
            return new Response('room is full', { status: 403 });
        }

        const [client, server] = Object.values(new WebSocketPair());

        // Hibernatable: the DO can be evicted between messages and the socket
        // stays open, so an idle room costs nothing.
        this.state.acceptWebSocket(server);
        this.announcePeers();

        return new Response(null, { status: 101, webSocket: client });
    }

    webSocketMessage(ws, message) {
        // Binary frames and oversized payloads are not part of the protocol.
        if (typeof message !== 'string') return;
        if (message.length > MAX_MESSAGE_BYTES) return;

        this.sendAll(message, ws);
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
