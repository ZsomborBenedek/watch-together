'use strict';

async function ensureOffscreen() {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.WEB_RTC],
        justification: 'WebRTC peer connection requires DOM APIs unavailable in service workers'
    });
}

chrome.runtime.onInstalled.addListener(function () {
    console.log("Watchtogether extension installed!");
    chrome.storage.local.set({ ownId: null });
    chrome.storage.local.set({ remoteId: null });
    chrome.storage.local.set({ state: 'start' });
    chrome.storage.local.set({ connected: false });
    chrome.storage.local.set({ sync: false });
});

function syncVids(_sync) {
    if (_sync) {
        injectContentScript();
        console.log('vids syncing');
        chrome.tabs.onActivated.addListener(injectContentScriptToActivated);
        chrome.tabs.onUpdated.addListener(injectContentScriptToUpdated);
    } else {
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

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request.target === 'offscreen') return;

    // Storage relay: offscreen documents can't reliably access chrome.storage
    if (request.action === 'storeData') {
        chrome.storage.local.set(request.data);
        return;
    }

    if (request.action === 'storeVideoState') {
        chrome.storage.local.get('sync', result => {
            if (result.sync) chrome.storage.local.set({ videoState: request.videoState });
        });
        return;
    }

    const directActions = ['newSession', 'joinSession', 'disconnectPeers'];
    if (directActions.includes(request.action)) {
        ensureOffscreen().then(() => {
            chrome.runtime.sendMessage({ ...request, target: 'offscreen' });
        });
    } else if (request.action === 'sendState') {
        // Check sync here so offscreen doesn't need chrome.storage.get
        chrome.storage.local.get('sync', result => {
            if (!result.sync) return;
            ensureOffscreen().then(() => {
                chrome.runtime.sendMessage({ ...request, target: 'offscreen' });
            });
        });
    }
});

chrome.storage.onChanged.addListener(function (changes, namespace) {
    for (var key in changes) {
        if (key === 'sync')
            syncVids(changes[key].newValue);
    }
});
