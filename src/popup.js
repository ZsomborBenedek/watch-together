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
const copyBtn = document.getElementById('copyBtn');
const connectBtn = document.getElementById('connectBtn');
const backBtn = document.getElementById('backBtn');
const settingsBtn = document.getElementById('settingsBtn');
const saveRelayBtn = document.getElementById('saveRelayBtn');
const relayUrl = document.getElementById('relayUrl');
const syncToggle = document.getElementById('syncToggle');
const syncBtns = document.querySelectorAll('.sync-btn');

let lastError = null;

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
    statusText.classList.toggle('connected', !!isConnected);
    if (lastError) {
        statusText.textContent = lastError;
    } else if (isConnected) {
        statusText.textContent = 'Connected — your friend is here.';
    } else {
        statusText.textContent = 'Waiting for your friend to join…';
    }
}

function setError(message) {
    lastError = message || null;
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
            lastError = result.connectionError || null;
            setConnected(result.connected);
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
        chrome.storage.local.set({ relayUrl: url || null }, function () {
            saveRelayBtn.innerHTML = 'Saved!';
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
