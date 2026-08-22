'use strict';

// Playback state travels over a WebSocket to a Cloudflare Worker relay
// (see server/). This file is shared by both browsers: Chrome loads it as an
// MV3 service worker, Firefox as a background script.

// Replace this after deploying your own relay, or set it at runtime from the
// popup (Relay server), which overrides this value.
const DEFAULT_RELAY_URL = 'wss://watch-together-relay.example.workers.dev';

// Ambiguous glyphs (O/0, I/1) are omitted — codes get read aloud and typed by hand.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 9;

// Also keeps Chrome's service worker alive: WebSocket activity resets the
// idle timer, so a session never dies from the 30s eviction.
const HEARTBEAT_MS = 20000;
// Retries are silent for a moment, then the message stops being "retrying"
// and starts pointing at the setting most likely to be wrong.
const RELAY_HINT_AFTER = 3;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// Domain separation, so the value the relay is given and the key the peers
// derive cannot be confused for one another.
const ROOM_ID_INFO = 'watch-together/room';
const SESSION_KEY_INFO = 'watch-together/session/v1';

// The code holds only ~45 bits of entropy, so everything derived from it is
// stretched. That closes two attacks at once: the relay walking back from the
// room id it is shown to the code, and a key-substituting MITM grinding codes
// offline against a captured frame — each guess now costs 600k hashes rather
// than one. The cost is paid once per connection.
const CODE_STRETCH_ITERATIONS = 600000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let socket = null;
let roomCode = null;
let leaving = false;
let heartbeatTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

// Ephemeral per connection: a reconnect renegotiates rather than reusing.
let keyPair = null;
let sessionKey = null;
let keySalt = null;
let helloSent = false;
let helloReceived = false;

// Frames carry a per-connection counter, because AES-GCM authenticates a
// replayed recording just as happily as a fresh frame: without this, a relay
// could re-apply an old pause or seek at a moment of its choosing.
let sendCounter = 0;
let recvCounter = 0;

// Opening a socket is asynchronous — key generation, room id derivation and a
// storage read all happen before the socket exists. Anything that tears a
// connection down bumps this, so a call still working through those steps can
// tell its result is no longer wanted and drop it instead of leaving an
// orphaned socket holding a slot in the room.
let connectionGeneration = 0;
let connecting = false;

let syncEnabled = false;
let syncMode = 'none';
let syncTabId = null;

chrome.runtime.onInstalled.addListener(function () {
    console.log('Watchtogether extension installed!');
    chrome.storage.local.set({
        roomCode: null,
        state: 'start',
        connected: false,
        sync: 'none'
    });
});

// A Chrome service worker that was evicted mid-session comes back with no
// socket, so rebuild it from what the popup last stored.
chrome.runtime.onStartup.addListener(restoreSession);
restoreSession();

function restoreSession() {
    if (socket || connecting) return;
    chrome.storage.local.get(['roomCode', 'state', 'sync', 'syncTabId'], function (result) {
        if (socket || connecting) return;
        if (result.state !== 'session' || !result.roomCode) return;
        // The in-memory sync mode died with the previous worker, and writing
        // an unchanged value back to storage fires no onChanged event, so it
        // has to be rebuilt here or every frame is dropped until the user
        // toggles the setting.
        restoreSyncMode(result.sync, result.syncTabId);
        openSocket(result.roomCode);
    });
}

// Like the storage listener, but for a worker restarting mid-session:
// 'page' mode keeps the tab it was bound to instead of re-picking whichever
// tab happens to be active now.
function restoreSyncMode(stored, storedTabId) {
    let mode = stored;
    if (mode === true) mode = 'all';
    if (mode === false || mode == null) mode = 'none';
    if (mode === 'page' && typeof storedTabId === 'number') {
        syncMode = 'page';
        syncEnabled = true;
        syncTabId = storedTabId;
        chrome.tabs.onUpdated.addListener(onTabUpdated);
        chrome.tabs.onRemoved.addListener(onTabRemoved);
        return;
    }
    syncVids(mode);
}

/* ------------------------------- relay ---------------------------------- */

function generateCode() {
    const bytes = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(bytes);
    let code = '';
    for (const byte of bytes) {
        code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
    return code;
}

// Displayed in groups of three (ABC-DEF-GHI); the relay ignores the dashes.
function formatCode(code) {
    return code.match(/.{1,3}/g).join('-');
}

function relayUrlFor(roomId) {
    return new Promise(resolve => {
        chrome.storage.local.get('relayUrl', function (result) {
            const base = (result.relayUrl || DEFAULT_RELAY_URL).replace(/\/+$/, '');
            resolve(base + '/room/' + roomId);
        });
    });
}

/* ----------------------------- end-to-end crypto ------------------------- */

// Ephemeral ECDH per connection, so a session's traffic becomes undecryptable
// the moment both peers drop their keypairs — a code leaked later cannot
// retroactively open it.
async function newKeyPair() {
    return crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits']
    );
}

// One stretch of the code yields both code-derived values: the name the relay
// is addressed by, and the salt folded into the session key. Splitting one
// PBKDF2 block is as strong as two separate stretches — the halves are
// mutually unpredictable, so the room id the relay sees tells it nothing
// about the salt — at half the derivation cost. The code itself never leaves
// the browser.
async function deriveRoomSecrets(code) {
    const material = await crypto.subtle.importKey(
        'raw', textEncoder.encode(code), 'PBKDF2', false, ['deriveBits']
    );
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            hash: 'SHA-256',
            salt: textEncoder.encode(ROOM_ID_INFO),
            iterations: CODE_STRETCH_ITERATIONS
        },
        material,
        256
    ));
    return { roomId: toHex(bits.slice(0, 16)), keySalt: bits.slice(16) };
}

// ECDH gives secrecy against anyone reading the handshake; folding the
// stretched code into HKDF means an *active* relay cannot simply substitute
// its own public keys, because it would also have to produce a code it never
// saw — and testing each guess costs a full stretch, not one hash.
async function deriveSessionKey(peerPublicRaw) {
    const peerKey = await crypto.subtle.importKey(
        'raw', peerPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );
    const shared = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: peerKey }, keyPair.privateKey, 256
    );
    const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: keySalt,
            info: textEncoder.encode(SESSION_KEY_INFO)
        },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

async function encryptState(content) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, sessionKey, textEncoder.encode(JSON.stringify(content))
    ));
    const packed = new Uint8Array(iv.length + sealed.length);
    packed.set(iv);
    packed.set(sealed, iv.length);
    return toBase64(packed);
}

async function decryptState(payload) {
    const packed = fromBase64(payload);
    const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: packed.slice(0, 12) }, sessionKey, packed.slice(12)
    );
    return JSON.parse(textDecoder.decode(plain));
}

function toHex(bytes) {
    let hex = '';
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
    return hex;
}

function toBase64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/* ------------------------------- handshake ------------------------------- */

// Both peers are told when the room reaches two, so both offer at once and
// each answers with what it already sent. One round trip, no roles.
async function sendHello(generation) {
    if (!socket || socket.readyState !== WebSocket.OPEN || !keyPair) return;
    const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    if (generation !== connectionGeneration) return;
    helloSent = true;
    socket.send(JSON.stringify({ t: 'hello', k: toBase64(new Uint8Array(raw)) }));
}

async function onHello(encodedKey, generation) {
    // One hello per connection: a repeat (a relay replaying the handshake)
    // must not re-derive the key and reset the replay counters with it.
    if (helloReceived || !keyPair || typeof encodedKey !== 'string') return;
    let derived;
    try {
        derived = await deriveSessionKey(fromBase64(encodedKey));
    } catch (error) {
        // A teardown mid-derivation throws too; that is not a failure worth
        // reporting against whatever session replaced this one.
        if (generation !== connectionGeneration) return;
        console.log('key agreement failed', error);
        chrome.storage.local.set({ connectionError: 'Could not secure the connection.' });
        return;
    }

    // The connection this hello arrived on may be gone by now; a key derived
    // for it must not be attached to whatever replaced it.
    if (generation !== connectionGeneration) return;
    if (helloReceived) return;
    helloReceived = true;
    sessionKey = derived;
    sendCounter = 0;
    recvCounter = 0;

    // Only now can anything actually be exchanged, so this is the honest
    // moment to call the session connected.
    chrome.storage.local.set({ connected: true, connectionError: null });
    chrome.storage.local.set({ sync: 'all' });

    // Covers the peer that was already waiting when we arrived and therefore
    // missed the announcement that prompted our own offer.
    if (!helloSent) await sendHello(generation);
}

async function openSocket(code) {
    closeSocket();
    const generation = connectionGeneration;
    connecting = true;
    leaving = false;
    // Callers pass either the stored display form (ABC-DEF) or a raw code.
    roomCode = code.replace(/-/g, '').toUpperCase();

    // Nothing survives a reconnect: new keys, and no key until the peer has
    // answered the handshake.
    sessionKey = null;
    helloSent = false;
    helloReceived = false;
    const pair = await newKeyPair();

    // The relay is addressed by a stretched hash of the code, so the code
    // itself — the one thing that would let it derive the key — never
    // reaches it.
    const secrets = await deriveRoomSecrets(roomCode);
    const url = await relayUrlFor(secrets.roomId);

    // Superseded while we were preparing: never open the socket at all, and
    // leave the globals — `connecting` included — to whoever superseded us.
    if (generation !== connectionGeneration) {
        return;
    }
    keyPair = pair;
    keySalt = secrets.keySalt;

    // Distinguishes a relay that was never reachable from one that dropped a
    // working session; the two need different explanations.
    let opened = false;

    let ws;
    try {
        ws = new WebSocket(url);
    } catch (error) {
        console.log('relay url is not usable', error);
        connecting = false;
        chrome.storage.local.set({ connectionError: String(error) });
        return;
    }
    socket = ws;
    connecting = false;

    ws.addEventListener('open', function () {
        opened = true;
        reconnectAttempts = 0;
        chrome.storage.local.set({ connectionError: null });
        startHeartbeat();
        console.log('joined room', code);
    });

    ws.addEventListener('message', function (event) {
        // A replaced socket can still drain buffered messages; they belong to
        // the session that is over, not this one.
        if (ws !== socket) return;
        onRelayMessage(event.data, generation)
            .catch(error => console.log('relay message failed', error));
    });

    ws.addEventListener('close', function () {
        if (ws !== socket) return;
        stopHeartbeat();
        socket = null;
        chrome.storage.local.set({ connected: false });
        if (!leaving) {
            // Otherwise an unreachable relay is indistinguishable from a peer
            // who simply has not arrived yet, and the popup waits forever.
            reportConnectionTrouble(opened);
            scheduleReconnect();
        }
    });

    ws.addEventListener('error', function () {
        // 'close' always follows, which is where reconnection is handled.
        console.log('relay socket error');
    });
}

async function onRelayMessage(data, generation) {
    if (data === 'pong') return;

    let message;
    try {
        message = JSON.parse(data);
    } catch (e) {
        console.log('invalid relay data', e);
        return;
    }

    if (message.t === 'peers') {
        if (message.n >= 2) {
            await sendHello(generation);
        } else {
            // The peer is gone and their key with them; the next one to arrive
            // negotiates afresh.
            sessionKey = null;
            helloSent = false;
            helloReceived = false;
            chrome.storage.local.set({ connected: false });
        }
        return;
    }

    if (message.t === 'hello') {
        await onHello(message.k, generation);
        return;
    }

    if (message.t === 'state' && syncEnabled) {
        // Before the handshake lands there is no key, and nothing sent to us
        // could have been readable anyway.
        if (!sessionKey) return;
        try {
            const frame = await decryptState(message.v);
            if (generation !== connectionGeneration) return;
            // A counter at or below what we have seen is a replayed
            // recording, not news from the peer.
            if (typeof frame.n !== 'number' || frame.n <= recvCounter) return;
            recvCounter = frame.n;
            console.log(frame.s);
            chrome.storage.local.set({ videoState: frame.s });
        } catch (error) {
            // Wrong key, or a payload that was not written by our peer.
            console.log('could not decrypt peer state', error);
        }
    }
}

function reportConnectionTrouble(hadConnected) {
    let message;
    if (hadConnected) {
        message = 'Connection lost — reconnecting…';
    } else if (reconnectAttempts >= RELAY_HINT_AFTER) {
        // Broken after the first sentence so the popup keeps its width
        // instead of stretching to fit one long line.
        message = 'Could not reach the relay server.\nCheck it under Relay server, or use your own.';
    } else {
        message = 'Cannot reach the relay server — retrying…';
    }
    chrome.storage.local.set({ connectionError: message });
}

function scheduleReconnect() {
    if (reconnectTimer || leaving || !roomCode) return;
    const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
        RECONNECT_MAX_MS
    );
    reconnectAttempts++;
    reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        if (!leaving && roomCode) openSocket(roomCode);
    }, delay);
}

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(function () {
        if (socket && socket.readyState === WebSocket.OPEN) socket.send('ping');
    }, HEARTBEAT_MS);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

function closeSocket() {
    connectionGeneration++;
    connecting = false;
    // Dropping the keypair is what makes this session unreadable afterwards.
    sessionKey = null;
    keySalt = null;
    helloSent = false;
    helloReceived = false;
    keyPair = null;
    stopHeartbeat();
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (socket) {
        const ws = socket;
        socket = null;
        try { ws.close(); } catch (e) { /* already closing */ }
    }
}

/* ------------------------------ sessions -------------------------------- */

function newSession() {
    const code = generateCode();
    chrome.storage.local.set({
        roomCode: formatCode(code),
        state: 'session',
        connected: false
    });
    openSocket(code);
}

function joinSession(code) {
    const normalized = code.replace(/-/g, '').toUpperCase();
    // Checked against the generating alphabet, not just A-Z0-9: a code with
    // O, I, 0 or 1 in it can never match a generated one, and rejecting it
    // here beats waiting in a room nobody else can be in.
    const wellFormed = normalized.length === CODE_LENGTH &&
        [...normalized].every(char => CODE_ALPHABET.includes(char));
    if (!wellFormed) {
        chrome.storage.local.set({
            connectionError: 'Room codes are ' + CODE_LENGTH + ' characters, like ABC-DEF-GHI.'
        });
        return;
    }
    chrome.storage.local.set({
        roomCode: formatCode(normalized),
        state: 'session',
        connected: false
    });
    openSocket(normalized);
}

function leaveSession() {
    leaving = true;
    roomCode = null;
    reconnectAttempts = 0;
    closeSocket();
    syncEnabled = false;
    syncMode = 'none';
    syncTabId = null;
    chrome.storage.local.set({
        roomCode: null,
        state: 'start',
        connected: false,
        sync: 'none',
        connectionError: null
    });
}

async function sendState(content) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    // Nothing goes out in the clear, so a half-finished handshake means the
    // update is dropped rather than downgraded.
    if (!sessionKey) return;
    const frame = { n: ++sendCounter, s: content };
    socket.send(JSON.stringify({ t: 'state', v: await encryptState(frame) }));
}

/* ----------------------------- tab syncing ------------------------------ */

function syncVids(mode) {
    syncMode = mode;
    chrome.tabs.onActivated.removeListener(onTabActivated);
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
    chrome.tabs.onRemoved.removeListener(onTabRemoved);

    if (mode === 'all') {
        syncEnabled = true;
        injectContentScript();
        chrome.tabs.onActivated.addListener(onTabActivated);
        chrome.tabs.onUpdated.addListener(onTabUpdated);
    } else if (mode === 'page') {
        syncEnabled = true;
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (tabs.length === 0) return;
            const tab = tabs[0];
            if (!tab.url || !tab.url.startsWith('http')) return;
            syncTabId = tab.id;
            chrome.storage.local.set({ syncTabId: tab.id });
            chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['src/content.js']
            }, _ => {
                let e = chrome.runtime.lastError;
                if (e !== undefined) console.log(_, e);
            });
            chrome.tabs.onUpdated.addListener(onTabUpdated);
            chrome.tabs.onRemoved.addListener(onTabRemoved);
        });
    } else {
        syncEnabled = false;
        syncTabId = null;
    }
}

function injectContentScript() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs.length === 0) return;
        const tab = tabs[0];
        if (!tab.url || !tab.url.startsWith('http')) return;
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['src/content.js']
        }, _ => {
            let e = chrome.runtime.lastError;
            if (e !== undefined) console.log(_, e);
        });
    });
}

function onTabActivated(activeInfo) {
    injectContentScript();
}

function onTabUpdated(tabId, changeInfo, tab) {
    if (changeInfo.status !== 'complete') return;
    if (!tab.url || !tab.url.startsWith('http')) return;
    if (syncMode === 'page' && tabId !== syncTabId) return;
    chrome.scripting.executeScript({
        target: { tabId },
        files: ['src/content.js']
    }, _ => {
        let e = chrome.runtime.lastError;
        if (e !== undefined) console.log(_, e);
    });
}

function onTabRemoved(tabId) {
    if (tabId === syncTabId) {
        syncTabId = null;
        chrome.storage.local.set({ sync: 'none', syncTabId: null });
    }
}

/* ------------------------------ messaging ------------------------------- */

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request.action === 'newSession') {
        newSession();
    } else if (request.action === 'joinSession') {
        joinSession(request.roomCode);
    } else if (request.action === 'leaveSession') {
        leaveSession();
    } else if (request.action === 'relayChanged') {
        // Reopen the same room against the newly configured relay.
        if (roomCode) {
            chrome.storage.local.set({ connected: false });
            openSocket(roomCode);
        }
    } else if (request.action === 'sendState') {
        if (!syncEnabled) return;
        if (syncMode === 'page' && sender.tab?.id !== syncTabId) return;
        sendState(request.content).catch(error => console.log('send failed', error));
    }
});

chrome.storage.onChanged.addListener(function (changes, namespace) {
    for (var key in changes) {
        if (key === 'sync') {
            let val = changes[key].newValue;
            if (val === true) val = 'all';
            if (val === false || val == null) val = 'none';
            syncVids(val);
        }
    }
});
