'use strict';

let startSection = document.getElementById('start');
let initiatorSection = document.getElementById('initiator');
let joinerSection = document.getElementById('joiner');
let footer = document.getElementById('footer');
let newSessionBtn = document.getElementById('newSessionBtn');
let joinSessionBtn = document.getElementById('joinSessionBtn');
let ownId = document.getElementById('ownId');
let remoteId = document.getElementById('remoteId');
let copyButton = document.getElementById('copyBtn');
let connectButton = document.getElementById('connectBtn');
let disconnectButton = document.getElementById('disconnectBtn');
let syncToggle = document.getElementById('syncToggle');
let syncBtns = document.querySelectorAll('.sync-btn');

function setState(state) {
    if (state === 'start') {
        startSection.hidden = false;
        initiatorSection.hidden = true;
        joinerSection.hidden = true;
        footer.hidden = true;
    } else {
        startSection.hidden = true;
        footer.hidden = false;
        if (state === 'initiate') {
            initiatorSection.hidden = false;
            joinerSection.hidden = false;
            initiatorSection.parentNode.appendChild(joinerSection);
            initiatorSection.parentNode.appendChild(footer);
        } else if (state === 'join') {
            initiatorSection.hidden = false;
            joinerSection.hidden = false;
            joinerSection.parentNode.appendChild(initiatorSection);
            joinerSection.parentNode.appendChild(footer);
        }
    }
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
    remoteId.disabled = isConnected;
    connectButton.hidden = isConnected;
    disconnectButton.hidden = !isConnected;
    backBtn.hidden = isConnected;
    syncToggle.hidden = !isConnected;
}

chrome.storage.onChanged.addListener(function (changes, namespace) {
    for (var key in changes) {
        if (key === 'connected')
            setConnected(changes[key].newValue);
        else if (key === 'state')
            setState(changes[key].newValue);
        else if (key === 'ownId')
            ownId.value = changes[key].newValue;
        else if (key === 'remoteId')
            remoteId.value = changes[key].newValue;
        else if (key === 'sync')
            setSyncMode(changes[key].newValue);
    }
});

// Init
window.addEventListener('load', initPopup, false);

function initPopup() {

    chrome.storage.local.get('state', function (result) {
        setState(result.state);
    });

    chrome.storage.local.get('connected', function (result) {
        setConnected(result.connected);
    });

    chrome.storage.local.get('ownId', function (result) {
        if (result.ownId != null)
            ownId.value = result.ownId;
    });

    chrome.storage.local.get('remoteId', function (result) {
        if (result.remoteId != null)
            remoteId.value = result.remoteId;
    });

    chrome.storage.local.get('sync', function (result) {
        setSyncMode(result.sync);
    });

    newSessionBtn.addEventListener('click', function () {
        setState('initiate');
        chrome.storage.local.set({ state: 'initiate' }, function () { });
        chrome.runtime.sendMessage({ action: 'newSession' });
    }, false);

    joinSessionBtn.addEventListener('click', function () {
        setState('join');
        chrome.storage.local.set({ state: 'join' }, function () { });
    }, false);

    copyButton.addEventListener('click', function () {
        navigator.clipboard.writeText(ownId.value).then(() => {
            copyButton.innerHTML = 'Copy again!';
        });
    }, false);

    connectButton.addEventListener('click', function () {
        if (remoteId.value.length > 0) {
            chrome.runtime.sendMessage({ action: 'joinSession', remoteId: remoteId.value });
        }
    }, false);

    disconnectButton.addEventListener('click', function () {
        chrome.runtime.sendMessage({ action: 'disconnectPeers' });
    }, false);

    backBtn.addEventListener('click', function () {
        chrome.runtime.sendMessage({ action: 'disconnectPeers' });
    }, false);

    syncBtns.forEach(btn => {
        btn.addEventListener('click', function () {
            chrome.storage.local.set({ sync: btn.dataset.sync });
        });
    });
}
