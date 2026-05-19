'use strict';

let peer;
let active;
let sync;

chrome.runtime.onInstalled.addListener(function () {
    console.log("Watchtogether extension installed!");

    chrome.storage.local.set({ ownId: null }, function () { });
    chrome.storage.local.set({ remoteId: null }, function () { });
    chrome.storage.local.set({ state: 'start' }, function () { });
    chrome.storage.local.set({ connected: false }, function () { });
    chrome.storage.local.set({ sync: false }, function () { });
});

function keepAlive() {
    if (active) {
        setTimeout(() => {
            chrome.runtime.getBackgroundPage(_ => { });
            keepAlive();
        }, 4000);
    }
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
    chrome.tabs.executeScript({
        file: 'content.js'
    }, _ => {
        let e = chrome.runtime.lastError;
        if (e !== undefined) {
            console.log(_, e);
        }
    });
}

function injectContentScriptToActivated(activeInfo) {
    injectContentScript();
}

function injectContentScriptToUpdated(tabId, changeInfo, tab) {
    if (changeInfo.status === 'complete') {
        injectContentScript();
    }
}

function newSession(initiator) {
    peer = new SimplePeer({
        initiator: initiator ? true : false,
        trickle: false
    });

    // When there is peer error
    peer.on('error', function (err) {
        console.log(err);
    });

    // When peer is made
    peer.on('signal', function (data) {
        active = true;
        keepAlive();
        let id = btoa(JSON.stringify(data));
        chrome.storage.local.set({ ownId: id }, function () {
            console.log('signaled as ', id);
        });
    });

    // When another peer connects to this one
    peer.on('connect', function () {
        chrome.storage.local.set({ connected: true }, function () {
            console.log('connected');
        });
        chrome.storage.local.set({ sync: true }, function () { });
        sync = true;
    });

    // When data is received
    peer.on('data', function (data) {
        if (sync) {
            let videoState = JSON.parse(atob(data));
            console.log(videoState);
            chrome.storage.local.set({ videoState: videoState }, function () { });
        }
    });

    // When peers are disconnected
    peer.on('close', function () {
        peer = null;
        active = false;
        disconnectPeers();
    });
}

function joinSession(remoteId) {
    try {
        peer.signal(JSON.parse(atob(remoteId)));
        chrome.storage.local.set({ remoteId: remoteId }, function () { });
    } catch (error) {
        console.log(error);
    }
}

function disconnectPeers() {
    if (peer) {
        peer.destroy();
    } else {
        chrome.storage.local.set({ ownId: null }, function () { });
        chrome.storage.local.set({ remoteId: null }, function () { });
        chrome.storage.local.set({ state: 'start' }, function () { });
        chrome.storage.local.set({ connected: false }, function () { });
        chrome.storage.local.set({ sync: false }, function () { });
    }
}

// Receiving messages
chrome.runtime.onMessage.addListener(function (request, _sender, sendResponse) {
    if (request.action === 'newSession') {
        newSession(true);
    } else if (request.action === 'joinSession') {
        if (!peer)
            newSession(false);
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

// chrome.runtime.onSuspend.addListener(function () {
//     console.log("Watchtogether extension suspended!");

//     disconnectPeers();
// });