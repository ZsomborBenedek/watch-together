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
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

let socket = null;
let roomCode = null;
let leaving = false;
let heartbeatTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

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
    chrome.storage.local.get(['roomCode', 'state'], function (result) {
        if (result.state === 'session' && result.roomCode) {
            openSocket(result.roomCode);
        }
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

function relayUrlFor(code) {
    return new Promise(resolve => {
        chrome.storage.local.get('relayUrl', function (result) {
            const base = (result.relayUrl || DEFAULT_RELAY_URL).replace(/\/+$/, '');
            resolve(base + '/room/' + code);
        });
    });
}

async function openSocket(code) {
    closeSocket();
    leaving = false;
    // Callers pass either the stored display form (ABC-DEF) or a raw code.
    roomCode = code.replace(/-/g, '').toUpperCase();
    code = roomCode;

    const url = await relayUrlFor(code);
    let ws;
    try {
        ws = new WebSocket(url);
    } catch (error) {
        console.log('relay url is not usable', error);
        chrome.storage.local.set({ connectionError: String(error) });
        return;
    }
    socket = ws;

    ws.addEventListener('open', function () {
        reconnectAttempts = 0;
        chrome.storage.local.set({ connectionError: null });
        startHeartbeat();
        console.log('joined room', code);
    });

    ws.addEventListener('message', function (event) {
        onRelayMessage(event.data);
    });

    ws.addEventListener('close', function () {
        if (ws !== socket) return;
        stopHeartbeat();
        socket = null;
        chrome.storage.local.set({ connected: false });
        if (!leaving) scheduleReconnect();
    });

    ws.addEventListener('error', function () {
        // 'close' always follows, which is where reconnection is handled.
        console.log('relay socket error');
    });
}

function onRelayMessage(data) {
    if (data === 'pong') return;

    let message;
    try {
        message = JSON.parse(data);
    } catch (e) {
        console.log('invalid relay data', e);
        return;
    }

    if (message.t === 'peers') {
        const connected = message.n >= 2;
        chrome.storage.local.set({ connected });
        // Matches the old behaviour: syncing starts as soon as a peer appears.
        if (connected) chrome.storage.local.set({ sync: 'all' });
        return;
    }

    if (message.t === 'state' && syncEnabled) {
        console.log(message.v);
        chrome.storage.local.set({ videoState: message.v });
    }
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
    if (normalized.length !== CODE_LENGTH || !/^[A-Z0-9]+$/.test(normalized)) {
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

function sendState(content) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ t: 'state', v: content }));
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
    } else if (request.action === 'sendState') {
        if (!syncEnabled) return;
        if (syncMode === 'page' && sender.tab?.id !== syncTabId) return;
        sendState(request.content);
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
