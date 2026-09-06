'use strict';

const startSection = document.getElementById('start');
const sessionSection = document.getElementById('session');
const joinSection = document.getElementById('join');
const footer = document.getElementById('footer');

const statusPill = document.getElementById('statusPill');
const statusPillText = document.getElementById('statusPillText');

const newSessionBtn = document.getElementById('newSessionBtn');
const joinSessionBtn = document.getElementById('joinSessionBtn');
const roomCode = document.getElementById('roomCode');
const joinCode = document.getElementById('joinCode');
const statusText = document.getElementById('status');
const joinHint = document.getElementById('joinHint');
const copyBtn = document.getElementById('copyBtn');
const copyText = copyBtn.querySelector('.wt-copy-text');
const connectBtn = document.getElementById('connectBtn');
const joinBackBtn = document.getElementById('joinBackBtn');
const backBtn = document.getElementById('backBtn');

const peers = document.getElementById('peers');
const youInitial = document.getElementById('youInitial');
const youPlaceholder = document.getElementById('youPlaceholder');
const youName = document.getElementById('youName');
const peerInitial = document.getElementById('peerInitial');
const peerPlaceholder = document.getElementById('peerPlaceholder');
const peerName = document.getElementById('peerName');

const displayName = document.getElementById('displayName');
const saveNameBtn = document.getElementById('saveNameBtn');
const nameHint = document.getElementById('nameHint');
const relayUrl = document.getElementById('relayUrl');
const saveRelayBtn = document.getElementById('saveRelayBtn');
const relayHint = document.getElementById('relayHint');
const syncBtns = document.querySelectorAll('.sync-btn');
const themeBtns = document.querySelectorAll('.theme-btn');

const DEFAULT_RELAY_HINT = 'Just the address, e.g. relay.watch-together.net. Empty uses the built-in relay.';
const DEFAULT_NAME_HINT = 'Optional. Sent only to the person you connect with.';
const NAME_MAX_LENGTH = 24;

// Everything the session view shows is derived from these five, so a change
// to any of them re-renders the lot rather than patching pieces in place.
let currentState = 'start';
let lastError = null;
let isConnected = false;
let relayOpen = false;
let myName = '';
let friendName = null;

let copiedTimer = null;
const hintTimers = new Map();

// 'start'   — no session
// 'join'    — entering someone else's code
// 'session' — in a room, waiting or connected
function setState(state) {
    currentState = state;
    startSection.hidden = state !== 'start';
    joinSection.hidden = state !== 'join';
    sessionSection.hidden = state !== 'session';
    footer.hidden = state !== 'session';
    renderSession();
}

function setSyncMode(mode) {
    let val = mode;
    if (val === true) val = 'all';
    if (val === false || val == null) val = 'none';
    syncBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.sync === val);
    });
}

// The stored preference wins; with none stored the page follows the system,
// which the stylesheet handles on its own via prefers-color-scheme.
function setTheme(theme) {
    const val = theme === 'light' || theme === 'dark' ? theme : 'system';
    if (val === 'system') {
        delete document.documentElement.dataset.theme;
    } else {
        document.documentElement.dataset.theme = val;
    }
    themeBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === val);
    });
}

// One of: connecting (no relay yet), waiting (relay up, friend not here),
// connected, or error.
function sessionPhase() {
    if (lastError) return 'error';
    if (isConnected) return 'connected';
    if (relayOpen) return 'waiting';
    return 'connecting';
}

function renderSession() {
    const phase = sessionPhase();
    const inRoom = currentState === 'session';

    // Header pill.
    let pillStatus = 'idle';
    let pillLabel = 'Not in a room';
    if (inRoom) {
        if (phase === 'error') {
            pillStatus = 'error';
            pillLabel = /retry|reconnect/i.test(lastError) ? 'Reconnecting' : 'Not connected';
        } else if (phase === 'connected') {
            pillStatus = 'connected';
            pillLabel = 'Connected';
        } else if (phase === 'waiting') {
            pillStatus = 'waiting';
            pillLabel = 'Waiting for friend';
        } else {
            pillStatus = 'connecting';
            pillLabel = 'Connecting';
        }
    } else if (currentState === 'join') {
        pillLabel = 'Joining a room';
    }
    statusPill.dataset.status = pillStatus;
    statusPillText.textContent = pillLabel;

    // Peers row.
    peers.dataset.phase = phase;
    setAvatar(youInitial, youPlaceholder, youName, myName, 'You');
    const showFriend = phase === 'connected' ? friendName : null;
    setAvatar(peerInitial, peerPlaceholder, peerName, showFriend, 'Friend');

    // Status line under the peers.
    statusText.classList.toggle('connected', phase === 'connected');
    statusText.classList.toggle('error', phase === 'error');
    if (phase === 'error') {
        statusText.textContent = lastError;
    } else if (phase === 'connected') {
        statusText.textContent = friendName
            ? 'Connected with ' + friendName + ' — playback stays in sync.'
            : 'Connected — your friend is here.';
    } else if (phase === 'waiting') {
        statusText.textContent = 'Waiting for your friend to join…';
    } else {
        statusText.textContent = 'Connecting to the relay…';
    }
}

// The placeholder is an <svg>, which has no .hidden property, so both are
// toggled through the attribute.
function setAvatar(initialEl, placeholderEl, nameEl, name, fallback) {
    const trimmed = (name || '').trim();
    if (trimmed) initialEl.textContent = trimmed.charAt(0).toUpperCase();
    initialEl.toggleAttribute('hidden', !trimmed);
    placeholderEl.toggleAttribute('hidden', !!trimmed);
    nameEl.textContent = trimmed || fallback;
    nameEl.title = trimmed;
}

// Confirmations are transient: the hint goes back to its usual text after a
// moment, so the panel never reads "Saved." an hour later.
function setHint(element, message, tone, fallback) {
    element.textContent = message;
    element.classList.toggle('warning', tone === 'warning');
    element.classList.toggle('success', tone === 'success');
    if (hintTimers.has(element)) clearTimeout(hintTimers.get(element));
    if (tone === 'success' && fallback) {
        hintTimers.set(element, setTimeout(function () {
            element.textContent = fallback;
            element.classList.remove('success');
            hintTimers.delete(element);
        }, 3000));
    }
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
    renderSession();
}

// Codes are typed by hand, often read aloud: keep them upper-case and drop
// the dashes in as the user types, so what they see matches what was shared.
function formatCodeInput() {
    const raw = joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 9);
    const groups = raw.match(/.{1,3}/g) || [];
    const formatted = groups.join('-');
    if (formatted !== joinCode.value) joinCode.value = formatted;
}

function leave() {
    chrome.runtime.sendMessage({ action: 'leaveSession' });
    setState('start');
}

chrome.storage.onChanged.addListener(function (changes, namespace) {
    for (var key in changes) {
        const value = changes[key].newValue;
        if (key === 'connected') {
            isConnected = !!value;
            renderSession();
        } else if (key === 'relayOpen') {
            relayOpen = !!value;
            renderSession();
        } else if (key === 'peerName') {
            friendName = value || null;
            renderSession();
        } else if (key === 'displayName') {
            myName = value || '';
            if (document.activeElement !== displayName) displayName.value = myName;
            renderSession();
        } else if (key === 'state') {
            setState(value);
        } else if (key === 'roomCode') {
            roomCode.textContent = value || '…';
        } else if (key === 'sync') {
            setSyncMode(value);
        } else if (key === 'theme') {
            setTheme(value);
        } else if (key === 'connectionError') {
            setError(value);
        }
    }
});

// Init
window.addEventListener('load', initPopup, false);

function initPopup() {

    chrome.storage.local.get(
        ['state', 'connected', 'relayOpen', 'roomCode', 'sync', 'relayUrl',
            'connectionError', 'displayName', 'peerName', 'theme'],
        function (result) {
            isConnected = !!result.connected;
            relayOpen = !!result.relayOpen;
            myName = result.displayName || '';
            friendName = result.peerName || null;
            lastError = result.connectionError || null;
            setTheme(result.theme);
            setSyncMode(result.sync);
            if (result.roomCode != null) roomCode.textContent = result.roomCode;
            if (result.relayUrl != null) relayUrl.value = result.relayUrl;
            displayName.value = myName;
            setState(result.state || 'start');
            setError(lastError);
        }
    );

    newSessionBtn.addEventListener('click', function () {
        relayOpen = false;
        setState('session');
        chrome.runtime.sendMessage({ action: 'newSession' });
    }, false);

    joinSessionBtn.addEventListener('click', function () {
        setState('join');
        chrome.storage.local.set({ state: 'join' });
        joinCode.focus();
    }, false);

    copyBtn.addEventListener('click', function () {
        const code = roomCode.textContent.trim();
        if (!code || code === '…') return;
        navigator.clipboard.writeText(code).then(() => {
            copyBtn.classList.add('copied');
            copyText.textContent = 'Copied';
            if (copiedTimer) clearTimeout(copiedTimer);
            copiedTimer = setTimeout(function () {
                copyBtn.classList.remove('copied');
                copyText.textContent = 'Copy';
                copiedTimer = null;
            }, 1800);
        });
    }, false);

    connectBtn.addEventListener('click', submitJoin, false);

    joinCode.addEventListener('input', formatCodeInput, false);
    joinCode.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') submitJoin();
    }, false);

    joinBackBtn.addEventListener('click', leave, false);
    backBtn.addEventListener('click', leave, false);

    saveNameBtn.addEventListener('click', saveName, false);
    displayName.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') saveName();
    }, false);

    saveRelayBtn.addEventListener('click', saveRelay, false);
    relayUrl.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') saveRelay();
    }, false);

    syncBtns.forEach(btn => {
        btn.addEventListener('click', function () {
            chrome.storage.local.set({ sync: btn.dataset.sync });
        });
    });

    themeBtns.forEach(btn => {
        btn.addEventListener('click', function () {
            setTheme(btn.dataset.theme);
            chrome.storage.local.set({ theme: btn.dataset.theme });
        });
    });
}

function saveName() {
    const name = displayName.value.trim().slice(0, NAME_MAX_LENGTH);
    displayName.value = name;
    chrome.storage.local.set({ displayName: name }, function () {
        setHint(nameHint, name ? 'Saved.' : 'Cleared — you will show up as "You".', 'success', DEFAULT_NAME_HINT);
        // Tells the peer straight away if we are already connected to one.
        chrome.runtime.sendMessage({ action: 'nameChanged' });
    });
}

function saveRelay() {
    const url = relayUrl.value.trim();
    if (url.length > 0 && !isRelayUrl(url)) {
        setHint(relayHint, 'That does not look like a server address.', 'warning', DEFAULT_RELAY_HINT);
        return;
    }
    // An empty field clears the override and falls back to the built-in relay.
    chrome.storage.local.set({ relayUrl: url || null }, function () {
        setHint(relayHint, url ? 'Saved.' : 'Saved — using the built-in relay.', 'success', DEFAULT_RELAY_HINT);
        // The socket URL is built when connecting, so an open session has to
        // be reopened before a new relay actually takes effect.
        chrome.runtime.sendMessage({ action: 'relayChanged' });
    });
}

function submitJoin() {
    const code = joinCode.value.trim();
    if (code.length === 0) return;
    setError(null);
    relayOpen = false;
    chrome.runtime.sendMessage({ action: 'joinSession', roomCode: code });
}
