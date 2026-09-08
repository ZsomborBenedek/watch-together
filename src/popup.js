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
const syncStatus = document.getElementById('syncStatus');
const themeBtns = document.querySelectorAll('.theme-btn');

// The markup is the one source for the resting hint copy, so a transient
// "Saved." always gives way to exactly the text the panel opened with.
const DEFAULT_RELAY_HINT = relayHint.textContent;
const DEFAULT_NAME_HINT = nameHint.textContent;
const NAME_MAX_LENGTH = 24;

// Sync is opt-in and per tab, and a tab can only join by this popup being
// opened on it — that click is the activeTab grant, the only site access
// the extension has. So the popup needs to know which tab it is on, and
// which tabs are syncing, to say plainly whether this one is.
// Site access is asked for on the mode buttons — This page for that site,
// All tabs for every site — and never at install. It is what makes a mode
// outlast a reload; All tabs with every site allowed also reaches pages
// this popup was never opened on.
const ALL_SITES = ['http://*/*', 'https://*/*'];
let currentSync = 'none';
let currentTabId = null;
let currentTabHost = null;
let currentTabPattern = null;
let allSitesGranted = false;
let syncedTabs = [];

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

// Shows the outcome of a copy attempt on the button, then restores it.
function showCopyResult(label) {
    copyText.textContent = label;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(function () {
        copyBtn.classList.remove('copied');
        copyText.textContent = 'Copy';
        copiedTimer = null;
    }, 1800);
}

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
    currentSync = mode === 'page' || mode === 'all' ? mode : 'none';
    renderSync();
}

function siteOf(url) {
    let parsed;
    try { parsed = new URL(url || ''); } catch (error) { return null; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // No port: a pattern without one matches every port, so a dev server on
    // localhost:8080 and the same host on 443 are one grant.
    return { host: parsed.hostname, pattern: parsed.protocol + '//' + parsed.hostname + '/*' };
}

function syncingHere() {
    return currentTabId !== null && syncedTabs.includes(currentTabId);
}

function renderSync() {
    const canSync = currentTabHost !== null;
    const here = syncingHere();
    syncBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.sync === currentSync);
        btn.disabled = btn.dataset.sync !== 'none' && !canSync;
    });
    footer.dataset.sync = currentSync;
    let text;
    if (currentSync === 'none') text = 'Not syncing. Pick This page or All tabs.';
    else if (here) text = currentSync === 'all'
        ? (allSitesGranted ? 'Syncing this tab — and every page with a video.' : 'Syncing this tab — and every tab you open this popup on.')
        : 'Syncing this tab.';
    else if (!canSync) text = 'Open the page with the video, then click the icon there.';
    else if (currentSync === 'page') text = 'Syncing another tab. Choose This page again to sync this one instead.';
    else text = 'This tab is not syncing yet.';
    syncStatus.textContent = text;
    renderSession();
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
    peers.dataset.syncing = phase === 'connected' && syncingHere() ? 'yes' : 'no';
    setAvatar(youInitial, youPlaceholder, youName, myName, 'You');
    const showFriend = phase === 'connected' ? friendName : null;
    setAvatar(peerInitial, peerPlaceholder, peerName, showFriend, 'Friend');

    // Status line under the peers.
    statusText.classList.toggle('connected', phase === 'connected');
    statusText.classList.toggle('error', phase === 'error');
    if (phase === 'error') {
        statusText.textContent = lastError;
    } else if (phase === 'connected') {
        // Whether this page syncs is said by the peers row and the sync
        // control, not here; this line is about the connection only.
        statusText.textContent = friendName
            ? 'Connected with ' + friendName + '.'
            : 'Connected — your friend is here.';
    } else if (phase === 'waiting') {
        statusText.textContent = 'Waiting for your friend to join…';
    } else {
        statusText.textContent = 'Connecting to the relay…';
    }
}

// Only a leading letter or digit makes an initial. Anything else — an emoji,
// punctuation — would show as a question mark, since charAt() takes a single
// UTF-16 unit and an emoji is two, so those names keep the placeholder icon.
function avatarInitial(name) {
    const first = name.charAt(0);
    return /[\p{L}\p{N}]/u.test(first) ? first.toUpperCase() : '';
}

// The placeholder is an <svg>, which has no .hidden property, so both are
// toggled through the attribute.
function setAvatar(initialEl, placeholderEl, nameEl, name, fallback) {
    const trimmed = (name || '').trim();
    const initial = avatarInitial(trimmed);
    initialEl.textContent = initial;
    initialEl.toggleAttribute('hidden', !initial);
    placeholderEl.toggleAttribute('hidden', !!initial);
    nameEl.textContent = trimmed || fallback;
    nameEl.title = trimmed;
}

// Confirmations are transient: the hint goes back to its usual text after a
// moment, so the panel never reads "Saved." an hour later.
function setHint(element, message, tone, fallback) {
    element.textContent = message;
    element.classList.toggle('warning', tone === 'warning');
    element.classList.toggle('success', tone === 'success');
    if (hintTimers.has(element)) {
        clearTimeout(hintTimers.get(element));
        hintTimers.delete(element);
    }
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
        } else if (key === 'syncedTabs') {
            syncedTabs = Array.isArray(value) ? value : [];
            renderSync();
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
            'connectionError', 'displayName', 'peerName', 'theme', 'syncedTabs'],
        function (result) {
            isConnected = !!result.connected;
            relayOpen = !!result.relayOpen;
            myName = result.displayName || '';
            friendName = result.peerName || null;
            lastError = result.connectionError || null;
            setTheme(result.theme);
            syncedTabs = Array.isArray(result.syncedTabs) ? result.syncedTabs : [];
            setSyncMode(result.sync);
            if (result.roomCode != null) roomCode.textContent = result.roomCode;
            if (result.relayUrl != null) relayUrl.value = result.relayUrl;
            displayName.value = myName;
            setState(result.state || 'start');
            setError(lastError);
        }
    );

    // Opening the popup on a page is what can mark it for syncing. The port
    // stays open exactly as long as the popup does, so the background also
    // learns when no page is being pointed at any more.
    const port = chrome.runtime.connect({ name: 'popup' });
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        const tab = tabs[0];
        const site = siteOf(tab && tab.url);
        currentTabId = tab ? tab.id : null;
        currentTabHost = site ? site.host : null;
        currentTabPattern = site ? site.pattern : null;
        renderSync();
        port.postMessage({ action: 'popupOpened', tabId: currentTabId, canSync: currentTabHost !== null });
    });
    chrome.permissions.contains({ origins: ALL_SITES }, function (granted) {
        allSitesGranted = !!granted;
        renderSync();
    });

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
            showCopyResult('Copied');
        }).catch(error => {
            // Clipboard access can be refused (permissions, insecure
            // context); the code is still on screen to copy by hand.
            console.log('clipboard write failed', error);
            copyBtn.classList.remove('copied');
            showCopyResult('Copy failed');
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
            const mode = btn.dataset.sync;
            if (mode === 'none') {
                chrome.runtime.sendMessage({ action: 'setSyncMode', mode, tabId: currentTabId });
                return;
            }
            if (currentTabPattern === null) return;
            // Ask first, apply on the answer. The background is told what is
            // being asked for, and applies it on the grant event itself, so
            // an answer given after the prompt has closed this popup still
            // lands. A refusal changes nothing: the previous mode stays.
            chrome.runtime.sendMessage({ action: 'requestSyncMode', mode, tabId: currentTabId, pattern: currentTabPattern });
            const origins = mode === 'all' ? ALL_SITES : [currentTabPattern];
            chrome.permissions.request({ origins }, function (granted) {
                void chrome.runtime.lastError;
                // Already-allowed sites answer without a prompt and without
                // a grant event, so this is the path that applies them. A
                // refusal needs nothing: the previous mode was never left.
                if (granted) chrome.runtime.sendMessage({ action: 'setSyncMode', mode, tabId: currentTabId });
            });
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
