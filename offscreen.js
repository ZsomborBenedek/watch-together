'use strict';

let peer;
let active;

function keepAlive() {
    if (active) setTimeout(keepAlive, 4000);
}

// Route all storage writes through the service worker, which has reliable chrome.storage access
function store(data) {
    chrome.runtime.sendMessage({ action: 'storeData', data });
}

function newSession(initiator) {
    peer = new SimplePeer({ initiator: !!initiator, trickle: false });

    peer.on('error', err => console.log(err));

    peer.on('signal', data => {
        active = true;
        keepAlive();
        const id = btoa(JSON.stringify(data));
        store({ ownId: id });
        console.log('signaled as', id);
    });

    peer.on('connect', () => {
        store({ connected: true });
        store({ sync: true });
        console.log('connected');
    });

    peer.on('data', data => {
        const videoState = JSON.parse(atob(data));
        console.log(videoState);
        chrome.runtime.sendMessage({ action: 'storeVideoState', videoState });
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
        store({ remoteId });
    } catch (error) {
        console.log(error);
    }
}

function disconnectPeers() {
    if (peer) {
        peer.destroy();
    } else {
        store({ ownId: null });
        store({ remoteId: null });
        store({ state: 'start' });
        store({ connected: false });
        store({ sync: false });
    }
}

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request.target !== 'offscreen') return;

    if (request.action === 'newSession') {
        newSession(true);
    } else if (request.action === 'joinSession') {
        if (!peer) newSession(false);
        joinSession(request.remoteId);
    } else if (request.action === 'disconnectPeers') {
        disconnectPeers();
    } else if (request.action === 'sendState') {
        // sync already checked by the service worker before forwarding
        if (peer) peer.send(btoa(JSON.stringify(request.content)));
    }
});
