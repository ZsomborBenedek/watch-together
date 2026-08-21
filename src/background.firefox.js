'use strict';

// Firefox background scripts run in a persistent background page with full WebRTC access.
// SimplePeer is already available as a global, loaded before this file via manifest scripts[].

let peer;
let active;
let syncEnabled = false;
let syncMode = 'none';
let syncTabId = null;

chrome.runtime.onInstalled.addListener(function () {
    console.log("Watchtogether extension installed!");
    chrome.storage.local.set({ ownId: null });
    chrome.storage.local.set({ remoteId: null });
    chrome.storage.local.set({ state: 'start' });
    chrome.storage.local.set({ connected: false });
    chrome.storage.local.set({ sync: 'none' });
});

function keepAlive() {
    if (active) setTimeout(keepAlive, 4000);
}

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

function newSession(initiator) {
    peer = new SimplePeer({ initiator: !!initiator, trickle: false });

    peer.on('error', err => {
        console.log(err);
        if (peer) peer.destroy();
    });

    peer.on('signal', data => {
        active = true;
        keepAlive();
        const id = btoa(JSON.stringify(data));
        chrome.storage.local.set({ ownId: id });
        console.log('signaled as', id);
    });

    peer.on('connect', () => {
        syncEnabled = true;
        chrome.storage.local.set({ connected: true });
        chrome.storage.local.set({ sync: 'all' });
        console.log('connected');
    });

    peer.on('data', data => {
        if (syncEnabled) {
            try {
                const videoState = JSON.parse(atob(data));
                console.log(videoState);
                chrome.storage.local.set({ videoState });
            } catch (e) {
                console.log('invalid peer data', e);
            }
        }
    });

    peer.on('close', () => {
        peer = null;
        active = false;
        syncEnabled = false;
        disconnectPeers();
    });
}

function joinSession(remoteId) {
    try {
        peer.signal(JSON.parse(atob(remoteId)));
        chrome.storage.local.set({ remoteId });
    } catch (error) {
        console.log(error);
        disconnectPeers();
    }
}

function disconnectPeers() {
    active = false;
    syncEnabled = false;
    if (peer) {
        peer.destroy();
    } else {
        chrome.storage.local.set({ ownId: null });
        chrome.storage.local.set({ remoteId: null });
        chrome.storage.local.set({ state: 'start' });
        chrome.storage.local.set({ connected: false });
        chrome.storage.local.set({ sync: 'none' });
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
        if (peer && syncEnabled) {
            if (syncMode === 'page' && sender.tab?.id !== syncTabId) return;
            peer.send(btoa(JSON.stringify(request.content)));
        }
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
