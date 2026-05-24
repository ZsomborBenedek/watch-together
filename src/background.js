'use strict';

let syncEnabled = false;
let syncMode = 'none';
let syncTabId = null;

async function ensureOffscreen() {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
        url: 'src/offscreen.html',
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
    chrome.storage.local.set({ sync: 'none' });
    ensureOffscreen();
});

chrome.runtime.onStartup.addListener(ensureOffscreen);

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

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request.target === 'offscreen') return;

    // Storage relay: offscreen documents can't reliably access chrome.storage
    if (request.action === 'storeData') {
        chrome.storage.local.set(request.data);
        return;
    }

    if (request.action === 'storeVideoState') {
        if (syncEnabled) chrome.storage.local.set({ videoState: request.videoState });
        return;
    }

    const directActions = ['newSession', 'joinSession', 'disconnectPeers'];
    if (directActions.includes(request.action)) {
        ensureOffscreen().then(() => {
            chrome.runtime.sendMessage({ ...request, target: 'offscreen' });
        });
    } else if (request.action === 'sendState') {
        if (!syncEnabled) return;
        if (syncMode === 'page' && sender.tab?.id !== syncTabId) return;
        ensureOffscreen().then(() => {
            chrome.runtime.sendMessage({ ...request, target: 'offscreen' });
        });
    }
});

chrome.storage.onChanged.addListener(function (changes, namespace) {
    for (var key in changes) {
        if (key === 'sync') {
            let val = changes[key].newValue;
            if (val === true) val = 'all';
            if (val === false || val == null) val = 'none';
            syncEnabled = val !== 'none';
            syncVids(val);
        }
    }
});
