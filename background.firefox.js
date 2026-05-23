'use strict';

// Firefox background scripts run in a persistent background page with full WebRTC access.
// SimplePeer is already available as a global, loaded before this file via manifest scripts[].

let peer;
let active;
let sync;

chrome.runtime.onInstalled.addListener(function () {
    console.log("Watchtogether extension installed!");
    chrome.storage.local.set({ ownId: null });
    chrome.storage.local.set({ remoteId: null });
    chrome.storage.local.set({ state: 'start' });
    chrome.storage.local.set({ connected: false });
    chrome.storage.local.set({ sync: false });
});

function keepAlive() {
    if (active) setTimeout(keepAlive, 4000);
}

function syncVids(_sync) {
    if (_sync) {
        sync = true;
        injectContentScript();
        console.log('vids syncing');
        chrome.tabs.onActivated.addListener(injectContentScriptToActivated);
        chrome.tabs.onUpdated.addListener(injectContentScriptToUpdated);
    } else {
        sync = false;
        console.log('vids not syncing');
        chrome.tabs.onActivated.removeListener(injectContentScriptToActivated);
        chrome.tabs.onUpdated.removeListener(injectContentScriptToUpdated);
    }
}

function injectContentScript() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs.length === 0) return;
        const tab = tabs[0];
        if (!tab.url || !tab.url.startsWith('http')) return;
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
        }, _ => {
            let e = chrome.runtime.lastError;
            if (e !== undefined) console.log(_, e);
        });
    });
}

function injectContentScriptToActivated(activeInfo) {
    injectContentScript();
}

function injectContentScriptToUpdated(tabId, changeInfo, tab) {
    if (changeInfo.status === 'complete') injectContentScript();
}

function newSession(initiator) {
    peer = new SimplePeer({ initiator: !!initiator, trickle: false });

    peer.on('error', err => console.log(err));

    peer.on('signal', data => {
        active = true;
        keepAlive();
        const id = btoa(JSON.stringify(data));
        chrome.storage.local.set({ ownId: id });
        console.log('signaled as', id);
    });

    peer.on('connect', () => {
        chrome.storage.local.set({ connected: true });
        chrome.storage.local.set({ sync: true });
        console.log('connected');
    });

    peer.on('data', data => {
        if (sync) {
            const videoState = JSON.parse(atob(data));
            console.log(videoState);
            chrome.storage.local.set({ videoState });
        }
    });

    peer.on('close', () => {
        peer = null;
        active = false;
        disconnectPeers();
    });
}

function joinSession(remoteId) {
    try {
        peer.signal(JSON.parse(atob(remoteId)));
        chrome.storage.local.set({ remoteId });
    } catch (error) {
        console.log(error);
    }
}

function disconnectPeers() {
    if (peer) {
        peer.destroy();
    } else {
        chrome.storage.local.set({ ownId: null });
        chrome.storage.local.set({ remoteId: null });
        chrome.storage.local.set({ state: 'start' });
        chrome.storage.local.set({ connected: false });
        chrome.storage.local.set({ sync: false });
    }
}

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request.action === 'newSession') {
        newSession(true);
    } else if (request.action === 'joinSession') {
        if (!peer) newSession(false);
        joinSession(request.remoteId);
    } else if (request.action === 'disconnectPeers') {
        disconnectPeers();
    } else if (request.action === 'sendState') {
        if (peer && sync)
            peer.send(btoa(JSON.stringify(request.content)));
    }
});

chrome.storage.onChanged.addListener(function (changes, namespace) {
    for (var key in changes) {
        if (key === 'sync')
            syncVids(changes[key].newValue);
    }
});
