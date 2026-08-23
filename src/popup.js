'use strict';

const startSection = document.getElementById('start');
const sessionSection = document.getElementById('session');
const joinSection = document.getElementById('join');
const footer = document.getElementById('footer');
const settingsPanel = document.getElementById('settingsPanel');

const newSessionBtn = document.getElementById('newSessionBtn');
const joinSessionBtn = document.getElementById('joinSessionBtn');
const roomCode = document.getElementById('roomCode');
const joinCode = document.getElementById('joinCode');
const statusText = document.getElementById('status');
const joinHint = document.getElementById('joinHint');
const copyBtn = document.getElementById('copyBtn');
const connectBtn = document.getElementById('connectBtn');
const backBtn = document.getElementById('backBtn');
const settingsBtn = document.getElementById('settingsBtn');
const saveRelayBtn = document.getElementById('saveRelayBtn');
const relayUrl = document.getElementById('relayUrl');
const relayHint = document.getElementById('relayHint');
const syncToggle = document.getElementById('syncToggle');
const syncBtns = document.querySelectorAll('.sync-btn');

let lastError = null;

const DEFAULT_HINT = 'Just the address, e.g. relay.watch-together.net. Empty uses the built-in relay.';

// 'start'   — no session
// 'join'    — entering someone else's code
// 'session' — in a room, waiting or connected
function setState(state) {
    startSection.hidden = state !== 'start';
    joinSection.hidden = state !== 'join';
    sessionSection.hidden = state !== 'session';
    footer.hidden = state === 'start';
    backBtn.textContent = state === 'join' ? 'Back' : 'Leave session';
}

function setSyncMode(mode) {
    let val = mode;
    if (val === true) val = 'all';
    if (val === false || val == null) val = 'none';
    syncBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.sync === val);
    });
}

function setConnected(isConnected) {
    syncToggle.hidden = !isConnected;
    statusText.classList.toggle('connected', !!isConnected && !lastError);
    statusText.classList.toggle('error', !!lastError);
    if (lastError) {
        statusText.textContent = lastError;
    } else if (isConnected) {
        statusText.textContent = 'Connected — your friend is here.';
    } else {
        statusText.textContent = 'Waiting for your friend to join…';
    }
}

function setRelayHint(message, isError) {
    relayHint.textContent = message || DEFAULT_HINT;
    relayHint.classList.toggle('warning', !!isError);
}

// Only ws:// and wss:// can ever work here, and rejecting anything else up
// front beats letting it surface later as an opaque connection failure.
// Only checks that this could be a host; the background script decides the
// scheme, since that depends on whether the host is loopback.
function isRelayUrl(value) {
    const bare = String(value)
        .trim()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
        .replace(/\/+$/, '');
    if (!bare) return false;
    try {
        return new URL('wss://' + bare).hostname.length > 0;
    } catch (e) {
        return false;
    }
}

function setError(message) {
    lastError = message || null;
    // The status line lives in the session section, which is hidden while the
    // user is still typing a code — mirror errors into the join section too,
    // or a rejected code looks like nothing happened.
    joinHint.textContent = lastError || '';
    joinHint.classList.toggle('error', !!lastError);
    chrome.storage.local.get('connected', function (result) {
        setConnected(result.connected);
    });
}

chrome.storage.onChanged.addListener(function (changes, namespace) {
    for (var key in changes) {
        if (key === 'connected')
            setConnected(changes[key].newValue);
        else if (key === 'state')
            setState(changes[key].newValue);
        else if (key === 'roomCode')
            roomCode.value = changes[key].newValue || '';
        else if (key === 'sync')
            setSyncMode(changes[key].newValue);
        else if (key === 'connectionError')
            setError(changes[key].newValue);
    }
});

// Init
window.addEventListener('load', initPopup, false);

function initPopup() {

    chrome.storage.local.get(
        ['state', 'connected', 'roomCode', 'sync', 'relayUrl', 'connectionError'],
        function (result) {
            setState(result.state || 'start');
            setError(result.connectionError || null);
            setSyncMode(result.sync);
            if (result.roomCode != null) roomCode.value = result.roomCode;
            if (result.relayUrl != null) relayUrl.value = result.relayUrl;
        }
    );

    newSessionBtn.addEventListener('click', function () {
        setState('session');
        chrome.runtime.sendMessage({ action: 'newSession' });
    }, false);

    joinSessionBtn.addEventListener('click', function () {
        setState('join');
        chrome.storage.local.set({ state: 'join' });
        joinCode.focus();
    }, false);

    copyBtn.addEventListener('click', function () {
        navigator.clipboard.writeText(roomCode.value).then(() => {
            copyBtn.innerHTML = 'Copied!';
        });
    }, false);

    connectBtn.addEventListener('click', submitJoin, false);

    joinCode.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') submitJoin();
    }, false);

    backBtn.addEventListener('click', function () {
        chrome.runtime.sendMessage({ action: 'leaveSession' });
        setState('start');
    }, false);

    settingsBtn.addEventListener('click', function () {
        settingsPanel.hidden = !settingsPanel.hidden;
    }, false);

    saveRelayBtn.addEventListener('click', function () {
        const url = relayUrl.value.trim();
        if (url.length > 0 && !isRelayUrl(url)) {
            setRelayHint('That does not look like a server address.', true);
            return;
        }
        // An empty field clears the override and falls back to the built-in relay.
        chrome.storage.local.set({ relayUrl: url || null }, function () {
            setRelayHint(url ? 'Saved.' : 'Saved — using the built-in relay.');
            // The socket URL is built when connecting, so an open session has to
            // be reopened before a new relay actually takes effect.
            chrome.runtime.sendMessage({ action: 'relayChanged' });
        });
    }, false);

    syncBtns.forEach(btn => {
        btn.addEventListener('click', function () {
            chrome.storage.local.set({ sync: btn.dataset.sync });
        });
    });
}

function submitJoin() {
    const code = joinCode.value.trim();
    if (code.length === 0) return;
    setError(null);
    chrome.runtime.sendMessage({ action: 'joinSession', roomCode: code });
}
