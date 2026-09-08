'use strict';

// Playback state travels over a WebSocket to a Cloudflare Worker relay
// (see server/). This file is shared by both browsers: Chrome loads it as an
// MV3 service worker, Firefox as a background script.

// The public relay. Users can point at a different one from the popup
// (Relay server), which overrides this value.
const DEFAULT_RELAY_URL = 'wss://relay.watch-together.net';

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

// Display names are optional, travel only inside the encrypted channel, and
// are capped so a frame carrying one stays well inside the relay envelope.
const NAME_MAX_LENGTH = 24;

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
// Peer public keys already accepted on this connection. A hello carrying one
// of these is a repeat (a relay replaying the handshake) and must not
// re-derive the key and reset the replay counters with it — not even after a
// "peers: 1" announcement, which a relay can fake. A hello carrying a key not
// in here is a new peer: one whose dead socket the relay reclaimed at the
// moment they reconnected, without ever announcing the room emptying in
// between. Every reconnect generates a fresh keypair, so a key is never
// legitimately seen twice.
//
// The set is capped, since hellos are relay-controlled. Evicting old keys
// would hand a relay the replay back — evict the real one, replay it — so an
// overflow reconnects instead: a fresh keypair makes every hello recorded
// so far worthless, and the set starts empty. A real peer reconnecting even
// once a minute for a whole film stays well inside the cap.
const peerKeysSeen = new Set();
const MAX_PEER_KEYS = 512;

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

// Sync is opt-in and per tab. The mode is the user's standing choice:
//   none — nothing syncs
//   page — one tab: the one the popup was on when This page was chosen
//   all  — every tab the popup is opened on, until it closes or Off
// The only site access is activeTab: the click that opens the popup grants
// it for that tab, so a tab can only ever join by that click. Nothing is
// asked for at install, and nothing is injected anywhere else.
let syncMode = 'none';
const syncedTabs = new Set();
// The tab the popup is open on, for as long as it is open (it holds a port).
let popupTabId = null;

// Site access is asked for on the mode buttons, never at install: This page
// asks for that site, All tabs for every site. Without the broad grant, All
// tabs means every tab the popup is opened on; with it, every page with a
// video, opened or not — the way it worked before.
const ALL_SITES = ['http://*/*', 'https://*/*'];
let allSitesGranted = false;

function refreshAllSitesGranted() {
    chrome.permissions.contains({ origins: ALL_SITES }, function (granted) {
        allSitesGranted = !!granted;
    });
}
refreshAllSitesGranted();

// The pattern the popup asks access for on a given page; null where nothing
// can be synced, or where the url is not visible to us at all.
function sitePatternOf(url) {
    let parsed;
    try { parsed = new URL(url || ''); } catch (error) { return null; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.protocol + '//' + parsed.hostname + '/*';
}

// Access can be taken away in the browser's extension settings as well as
// granted from the popup. A mode is only ever applied on the access it asked
// for, so losing that access turns the mode off — and tells the synced tabs,
// so they stop now rather than at their next reload.
function dropModeWithoutAccess() {
    syncStateLoaded.then(function () {
        if (syncMode === 'all') {
            chrome.permissions.contains({ origins: ALL_SITES }, function (granted) {
                if (!granted && syncMode === 'all') setSyncMode('none');
            });
        } else if (syncMode === 'page') {
            for (const tabId of [...syncedTabs]) {
                chrome.tabs.get(tabId, function (tab) {
                    // The url is only visible where we still hold access.
                    const pattern = chrome.runtime.lastError || !tab ? null : sitePatternOf(tab.url);
                    if (!pattern) {
                        if (syncMode === 'page') setSyncMode('none');
                        return;
                    }
                    chrome.permissions.contains({ origins: [pattern] }, function (granted) {
                        if (!granted && syncMode === 'page') setSyncMode('none');
                    });
                });
            }
        }
    });
}

chrome.permissions.onRemoved.addListener(function () {
    refreshAllSitesGranted();
    dropModeWithoutAccess();
});

// A mode that needs access is not applied until the access exists. The
// popup asks, but the browser may close it to show the prompt — so the
// answer is taken from the grant event here, not from the popup: allow, and
// the mode goes on even with the popup gone; refuse, and nothing fires, so
// the previous mode simply stays. That is the revert.
let pendingMode = null;

function applyPendingIfGranted() {
    const pending = pendingMode;
    if (!pending) return;
    const origins = pending.mode === 'all' ? ALL_SITES : [pending.pattern];
    chrome.permissions.contains({ origins }, function (granted) {
        if (!granted || pendingMode !== pending) return;
        pendingMode = null;
        setSyncMode(pending.mode, pending.tabId);
    });
}

chrome.permissions.onAdded.addListener(function () {
    refreshAllSitesGranted();
    applyPendingIfGranted();
});

// The background's memory dies with it and comes back empty. Firefox ends an
// idle event page after ~30s, so the very event that needs this — a reload
// of a synced tab — is often what wakes the script; it must not look before
// the stored copy has been read back.
const syncStateLoaded = new Promise(function (resolve) {
    chrome.storage.local.get(['sync', 'syncedTabs'], function (result) {
        syncMode = normalizeMode(result.sync);
        for (const id of result.syncedTabs || []) syncedTabs.add(id);
        resolve();
    });
});

function normalizeMode(value) {
    return value === 'page' || value === 'all' ? value : 'none';
}

chrome.runtime.onInstalled.addListener(function (details) {
    // Fresh installs only. This also fires on update, where the session and
    // sync mode must survive: the reads issued above already returned the old
    // values, so wiping storage here would leave the background connected to
    // a room the popup no longer knows about.
    if (details.reason !== 'install') return;
    console.log('Watchtogether extension installed!');
    chrome.storage.local.set({
        roomCode: null,
        state: 'start',
        connected: false,
        relayOpen: false,
        peerName: null,
        sync: 'none',
        syncedTabs: []
    });
});

// A Chrome service worker that was evicted mid-session comes back with no
// socket, so rebuild it from what the popup last stored.
chrome.runtime.onStartup.addListener(function () {
    // A browser restart renumbers tabs, so last session's ids mean nothing.
    // Only after the stored copy has been read back, or that read lands
    // afterwards and puts them straight back.
    syncStateLoaded.then(function () {
        syncedTabs.clear();
        chrome.storage.local.set({ syncedTabs: [] }, restoreSession);
    });
});
restoreSession();

function restoreSession() {
    if (socket || connecting) return;
    chrome.storage.local.get(['roomCode', 'state'], function (result) {
        if (socket || connecting) return;
        if (result.state !== 'session' || !result.roomCode) return;
        openSocket(result.roomCode);
    });
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

// Loopback is the only place a relay can be served without TLS, so it is the
// only place ws: is correct.
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

// Users give a host, not a URL — "relay.watch-together.net" or
// "localhost:8787". Any scheme they do type is dropped, because whether the
// connection can be plaintext is a property of the host, not a preference.
function normalizeRelayUrl(value) {
    const bare = String(value || '')
        .trim()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
        .replace(/\/+$/, '');
    if (!bare) return null;

    const host = bare.split('/')[0];
    return (LOOPBACK_HOST.test(host) ? 'ws://' : 'wss://') + bare;
}

function relayUrlFor(roomId) {
    return new Promise(resolve => {
        chrome.storage.local.get('relayUrl', function (result) {
            const base = normalizeRelayUrl(result.relayUrl) ||
                normalizeRelayUrl(DEFAULT_RELAY_URL);
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
    if (!keyPair || typeof encodedKey !== 'string' || peerKeysSeen.has(encodedKey)) return;
    if (peerKeysSeen.size >= MAX_PEER_KEYS) {
        console.log('too many handshakes on one connection; renegotiating from scratch');
        openSocket(roomCode);
        return;
    }
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
    if (peerKeysSeen.has(encodedKey)) return;
    peerKeysSeen.add(encodedKey);
    sessionKey = derived;
    sendCounter = 0;
    recvCounter = 0;

    // Only now can anything actually be exchanged, so this is the honest
    // moment to call the session connected.
    chrome.storage.local.set({ connected: true, connectionError: null });
    // Connection and sync meet here only: in All-tabs mode, a popup open on
    // a page when the peers connect means that page joins now.
    syncPopupTab();

    // Covers the peer that was already waiting when we arrived and therefore
    // missed the announcement that prompted our own offer.
    if (!helloSent) await sendHello(generation);

    // Only after our own hello is out: the peer needs it to derive the key
    // this frame is sealed with.
    await sendName(generation);
}

async function openSocket(code) {
    closeSocket();
    const generation = connectionGeneration;
    connecting = true;
    leaving = false;
    // Callers pass either the stored display form (ABC-DEF) or a raw code.
    roomCode = code.replace(/-/g, '').toUpperCase();
    // A fresh socket has no peer key, so it is never connected — including
    // after a worker restart, where the flag from the previous life is still
    // in storage because the old socket's close handler never ran.
    chrome.storage.local.set({ connected: false, relayOpen: false, peerName: null });

    // Nothing survives a reconnect: new keys, and no key until the peer has
    // answered the handshake.
    sessionKey = null;
    helloSent = false;
    peerKeysSeen.clear();
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
        chrome.storage.local.set({ connectionError: null, relayOpen: true });
        startHeartbeat();
        console.log('joined room', code);
    });

    // Handled strictly in arrival order: a hello takes a moment to turn into
    // a key, and the frame right behind it — the peer's name — must not be
    // looked at before that key exists.
    let inbound = Promise.resolve();
    ws.addEventListener('message', function (event) {
        // A replaced socket can still drain buffered messages; they belong to
        // the session that is over, not this one.
        if (ws !== socket) return;
        inbound = inbound
            .then(() => onRelayMessage(event.data, generation))
            .catch(error => console.log('relay message failed', error));
    });

    ws.addEventListener('close', function () {
        if (ws !== socket) return;
        stopHeartbeat();
        socket = null;
        chrome.storage.local.set({ connected: false, relayOpen: false, peerName: null });
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
    // Queued behind a slow key derivation, a message can run after the
    // socket it arrived on has been replaced; it must not touch the new one.
    if (generation !== connectionGeneration) return;
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
            // negotiates afresh. The keys already seen are kept: they are
            // what stops a replayed hello from reopening the old key.
            sessionKey = null;
            helloSent = false;
            chrome.storage.local.set({ connected: false, peerName: null });
        }
        return;
    }

    if (message.t === 'hello') {
        await onHello(message.k, generation);
        return;
    }

    if (message.t === 'state') {
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
            if (typeof frame.name === 'string') {
                // Who we are connected with, as they chose to be called.
                chrome.storage.local.set({ peerName: cleanName(frame.name) || null });
            } else if (syncedTabs.size > 0 && frame.s) {
                console.log(frame.s);
                chrome.storage.local.set({ videoState: frame.s });
            }
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
    peerKeysSeen.clear();
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
    // The one place session teardown reaches into sync.
    setSyncMode('none');
    chrome.storage.local.set({
        roomCode: null,
        state: 'start',
        connected: false,
        relayOpen: false,
        peerName: null,
        connectionError: null
    });
}

async function sendFrame(fields) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    // Nothing goes out in the clear, so a half-finished handshake means the
    // update is dropped rather than downgraded.
    if (!sessionKey) return;
    const frame = Object.assign({ n: ++sendCounter }, fields);
    socket.send(JSON.stringify({ t: 'state', v: await encryptState(frame) }));
}

function sendState(content) {
    return sendFrame({ s: content });
}

// Whitespace-only and control characters are dropped, and the result is
// capped, so what the popup shows is never wider or stranger than a name.
function cleanName(value) {
    return String(value || '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, NAME_MAX_LENGTH);
}

// Sent whenever a key is agreed and again whenever the name changes. An
// empty name is sent too, so clearing it clears it on the other side.
async function sendName(generation) {
    const name = await new Promise(resolve => {
        chrome.storage.local.get('displayName', result => resolve(cleanName(result.displayName)));
    });
    if (generation !== connectionGeneration || !sessionKey) return;
    await sendFrame({ name });
}

/* ----------------------------- tab syncing ------------------------------ */

function storeSyncedTabs() {
    chrome.storage.local.set({ syncedTabs: [...syncedTabs] });
}

function tellTab(tabId, enabled) {
    chrome.tabs.sendMessage(tabId, { action: 'setSyncEnabled', enabled }, function () {
        void chrome.runtime.lastError; // no script there to tell
    });
}

// Injects into a tab and starts syncing it. Only ever works on a tab the
// popup is open on — that click is the activeTab grant — or, in Chrome, on
// the same site after a reload. Anything else fails and the tab is dropped;
// opening the popup on it again is the way back in.
function enableTab(tabId) {
    chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] }, function () {
        const error = chrome.runtime.lastError;
        if (error) {
            console.log('cannot sync tab', tabId, error.message);
            if (syncedTabs.delete(tabId)) storeSyncedTabs();
            return;
        }
        syncedTabs.add(tabId);
        storeSyncedTabs();
        tellTab(tabId, true);
    });
}

function disableTab(tabId) {
    if (syncedTabs.delete(tabId)) storeSyncedTabs();
    tellTab(tabId, false);
}

function disableAllTabs() {
    for (const tabId of syncedTabs) tellTab(tabId, false);
    syncedTabs.clear();
    storeSyncedTabs();
}

// Applies a mode the user chose in the popup, on the tab it was open on.
function setSyncMode(mode, tabId) {
    syncMode = normalizeMode(mode);
    chrome.storage.local.set({ sync: syncMode });
    if (syncMode === 'none') {
        disableAllTabs();
    } else if (syncMode === 'page') {
        // One tab: the one the choice was made on. Choosing This page again
        // from another tab moves the sync there.
        for (const id of [...syncedTabs]) if (id !== tabId) disableTab(id);
        if (typeof tabId === 'number') enableTab(tabId);
    } else if (typeof tabId === 'number') {
        enableTab(tabId);
    }
}

// In All-tabs mode a page the popup is open on joins: when the popup opens
// during a session, and when the peers connect with it already open.
function syncPopupTab() {
    if (popupTabId === null || syncMode !== 'all') return;
    enableTab(popupTabId);
}

// A full page load in a synced tab takes its content script with it; put it
// back. That works wherever the site was allowed, and in Chrome also on the
// same site under activeTab alone. With every site allowed, All tabs also
// reaches pages the popup was never opened on — the url is only visible
// where we hold that access, which is exactly where injecting can work.
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (changeInfo.status !== 'complete') return;
    syncStateLoaded.then(function () {
        if (syncedTabs.has(tabId)) return enableTab(tabId);
        if (syncMode === 'all' && allSitesGranted && roomCode && /^https?:/.test(tab.url || '')) enableTab(tabId);
    });
});

chrome.tabs.onActivated.addListener(function (activeInfo) {
    syncStateLoaded.then(function () {
        if (syncMode !== 'all' || !allSitesGranted || !roomCode) return;
        chrome.tabs.get(activeInfo.tabId, function (tab) {
            if (chrome.runtime.lastError || !tab || !/^https?:/.test(tab.url || '')) return;
            if (!syncedTabs.has(tab.id)) enableTab(tab.id);
        });
    });
});

chrome.tabs.onRemoved.addListener(function (tabId) {
    if (syncedTabs.delete(tabId)) storeSyncedTabs();
    if (popupTabId === tabId) popupTabId = null;
});

/* ------------------------------ messaging ------------------------------- */

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request.action === 'newSession') {
        newSession();
    } else if (request.action === 'joinSession') {
        joinSession(request.roomCode);
    } else if (request.action === 'leaveSession') {
        leaveSession();
    } else if (request.action === 'nameChanged') {
        sendName(connectionGeneration).catch(error => console.log('name send failed', error));
    } else if (request.action === 'relayChanged') {
        // Reopen the same room against the newly configured relay.
        if (roomCode) openSocket(roomCode);
    } else if (request.action === 'requestSyncMode') {
        const usable = (request.mode === 'all' || request.mode === 'page') &&
            typeof request.tabId === 'number' && typeof request.pattern === 'string';
        pendingMode = usable ? { mode: request.mode, tabId: request.tabId, pattern: request.pattern } : null;
    } else if (request.action === 'setSyncMode') {
        pendingMode = null;
        syncStateLoaded.then(function () {
            setSyncMode(request.mode, request.tabId);
        });
    } else if (request.action === 'sendState') {
        syncStateLoaded.then(function () {
            if (!sender.tab || !syncedTabs.has(sender.tab.id)) return;
            sendState(request.content).catch(error => console.log('send failed', error));
        });
    }
});

// The popup holds this port for as long as it is open, so its closing is
// known too — and with it, that no page is being pointed at any more.
chrome.runtime.onConnect.addListener(function (port) {
    if (port.name !== 'popup') return;
    port.onMessage.addListener(function (message) {
        if (!message || message.action !== 'popupOpened') return;
        // Only an http(s) page can be synced; anything else must not be
        // remembered as the popup's tab.
        const usable = typeof message.tabId === 'number' && message.canSync === true;
        popupTabId = usable ? message.tabId : null;
        // A fresh popup means any earlier prompt has been answered by now.
        pendingMode = null;
        // Stored state, not roomCode: a worker restarted a moment ago is
        // still rebuilding the session, and this popup may be why.
        chrome.storage.local.get('state', function (result) {
            syncStateLoaded.then(function () {
                if (result.state === 'session') syncPopupTab();
            });
        });
    });
    port.onDisconnect.addListener(function () {
        popupTabId = null;
    });
});
