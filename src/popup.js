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
let vidSync = document.getElementById('vidSync');
let vidSyncContainer = document.getElementById('vidSyncContainer');
let syncLabel = document.getElementById('syncLabel');

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

function setConnected(isConnected) {
    remoteId.disabled = isConnected;
    connectButton.hidden = isConnected;
    disconnectButton.hidden = !isConnected;
    backBtn.hidden = isConnected;
    vidSyncContainer.hidden = !isConnected;
    vidSync.checked = isConnected;
}

chrome.storage.onChanged.addListener(function (changes, namespace) {
    for (var key in changes) {
        if (key === 'connected')
            setConnected(changes[key].newValue);
        else if (key === 'state')
            setState(changes[key].newValue);
        else if (key === 'ownId') {
            ownId.value = changes[key].newValue;
        }
        else if (key === 'remoteId')
            remoteId.value = changes[key].newValue;
        else if (key === 'sync') {
            vidSync.checked = changes[key].newValue;
            syncLabel.textContent = vidSync.checked ? 'Video syncing on' : 'Video syncing off';
        }
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
        vidSync.checked = result.sync;
        syncLabel.textContent = vidSync.checked ? 'Video syncing on' : 'Video syncing off';
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

    vidSync.addEventListener('click', function () {
        chrome.storage.local.set({ sync: vidSync.checked }, function () { });
    });
}
